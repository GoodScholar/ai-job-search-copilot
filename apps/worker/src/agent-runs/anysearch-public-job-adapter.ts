import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { LayeredPublicJobDiscoveryQuerySchema, PublicJobIdentityParameters, PublicJobIdentityValue, type AnySearchProviderError } from "@job-copilot/contracts/job-discovery";

const ANYSEARCH_BASE_URL = "https://api.anysearch.com";
const MAX_BATCH_SIZE = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
type Failure = { ok: false; error: AnySearchProviderError };
type Success<T> = { ok: true; data: T };
export type AnySearchResult<T> = Success<T> | Failure;
export type AnySearchCandidate = { readonly kind: "anysearch_public_job_candidate"; readonly normalizedUrl: string; readonly allowedSiteDomains: readonly string[]; readonly queryId: string; readonly candidateFingerprint: string };
export type AnySearchCandidateOutcome = { readonly normalizedUrl: string | null; readonly policy: "accepted" | "rejected"; readonly candidate?: AnySearchCandidate };
export type AnySearchSearchInput = z.infer<typeof LayeredPublicJobDiscoveryQuerySchema> & { signal?: AbortSignal };
export type AnySearchExtractInput = { candidate: AnySearchCandidate; identity: string; signal?: AbortSignal };
export type AnySearchBeforeRequest = (input: { kind: "search"; queryId: string } | { kind: "extract"; identity: string; candidateFingerprint: string }) => Promise<void | false> | void | false;
export type AnySearchFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type AnySearchCandidatePreflight = Success<{ normalizedUrl: string; allowedSiteDomains: readonly string[] }> | Failure;

const CandidateSchema = z.object({ kind: z.literal("anysearch_public_job_candidate"), normalizedUrl: z.string(), allowedSiteDomains: z.array(z.string()).max(5), queryId: z.uuid(), candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
function error(code: AnySearchProviderError["code"], retryable: boolean, httpStatus: AnySearchProviderError["httpStatus"]): Failure { return { ok: false, error: { code, retryable, httpStatus } }; }
function normalizeHost(value: string): string { return value.toLowerCase().replace(/\.$/u, ""); }
function isPublicHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return host.includes(".") && isIP(host.replace(/^\[|\]$/gu, "")) === 0 && !["localhost", "local", "internal", "lan"].some((suffix) => host === suffix || host.endsWith("." + suffix));
}
function normalizeAllowedDomains(value: readonly string[]): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_BATCH_SIZE) return undefined;
  const domains: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const normalized = normalizeHost(item.trim());
    let parsed: URL;
    try { parsed = new URL("https://" + normalized); } catch { return undefined; }
    if (parsed.hostname !== normalized || parsed.pathname !== "/" || parsed.username || parsed.password || !isPublicHostname(normalized)) return undefined;
    if (!domains.includes(normalized)) domains.push(normalized);
  }
  return Object.freeze(domains.sort());
}
function allowedHost(hostname: string, domains: readonly string[]): boolean { const host = normalizeHost(hostname); return domains.length === 0 || domains.some((domain) => host === domain || host.endsWith("." + domain)); }
function candidateFingerprint(normalizedUrl: string): string { return createHash("sha256").update(normalizedUrl, "utf8").digest("hex"); }
function isAbortSignal(value: unknown): value is AbortSignal { return value === undefined || (typeof value === "object" && value !== null && "aborted" in value && typeof (value as AbortSignal).addEventListener === "function"); }

/** Lexical preflight only; the later local fetch keeps DNS pinning and address verification authority. */
export function preflightAnySearchCandidate(input: { url: unknown; allowedSiteDomains: readonly string[] }): AnySearchCandidatePreflight {
  if (typeof input.url !== "string") return error("ANYSEARCH_POLICY_REJECTED", false, null);
  const allowedSiteDomains = normalizeAllowedDomains(input.allowedSiteDomains);
  if (!allowedSiteDomains) return error("ANYSEARCH_POLICY_REJECTED", false, null);
  let url: URL;
  try { url = new URL(input.url); } catch { return error("ANYSEARCH_POLICY_REJECTED", false, null); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || !isPublicHostname(url.hostname)) return error("ANYSEARCH_POLICY_REJECTED", false, null);
  const retained = [...url.searchParams].filter(([key, value]) => PublicJobIdentityParameters.has(key.toLowerCase()) && PublicJobIdentityValue.test(value));
  if ([...url.searchParams].some(([key, value]) => PublicJobIdentityParameters.has(key.toLowerCase()) && !PublicJobIdentityValue.test(value))) return error("ANYSEARCH_POLICY_REJECTED", false, null);
  retained.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, value] of retained) url.searchParams.append(key, value);
  url.hash = "";
  if (!allowedHost(url.hostname, allowedSiteDomains)) return error("ANYSEARCH_POLICY_REJECTED", false, null);
  return { ok: true, data: { normalizedUrl: url.toString(), allowedSiteDomains } };
}

export class AnySearchPublicJobAdapter {
  private readonly apiKey: string | undefined;
  private readonly fetch: AnySearchFetch;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly beforeRequest?: AnySearchBeforeRequest;
  private readonly issuedCandidateFingerprints = new Set<string>();
  private readonly claimedCandidateFingerprints = new Set<string>();

  constructor(input: { apiKey?: string; transport?: AnySearchFetch; baseUrl?: string; timeoutMs?: number; beforeRequest?: AnySearchBeforeRequest } = {}) {
    if ((input.transport || input.baseUrl) && process.env.APP_ENV !== "test") throw new Error("ANYSEARCH_TEST_TRANSPORT_DISABLED");
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS)) throw new Error("ANYSEARCH_TIMEOUT_INVALID");
    this.apiKey = input.apiKey?.trim() || undefined;
    this.fetch = input.transport ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = new URL(input.baseUrl ?? ANYSEARCH_BASE_URL);
    if (process.env.APP_ENV !== "test" && this.baseUrl.origin !== ANYSEARCH_BASE_URL) throw new Error("ANYSEARCH_BASE_URL_INVALID");
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.beforeRequest = input.beforeRequest;
  }

  async search(input: unknown): Promise<AnySearchResult<{ queryId: string; ordinal: number; candidates: readonly AnySearchCandidateOutcome[] }>> {
    if (!this.apiKey) return error("ANYSEARCH_NOT_CONFIGURED", false, null);
    const parsedInput = parseSearchInput(input);
    if (!parsedInput) return error("ANYSEARCH_POLICY_REJECTED", false, null);
    const response = await this.request({ kind: "search", queryId: parsedInput.queryId }, "/v1/search", { query: parsedInput.query, max_results: 5 }, parsedInput.signal);
    if (!response.ok) return response;
    const parsed = parseSearch(response.data);
    if (!parsed.ok) return parsed;
    const candidates = parsed.data.map((result) => {
      const preflight = preflightAnySearchCandidate({ url: result.url, allowedSiteDomains: parsedInput.allowedSiteDomains });
      if (!preflight.ok) return { normalizedUrl: safeNormalizedUrl(result.url), policy: "rejected" as const };
      const fingerprint = candidateFingerprint(preflight.data.normalizedUrl);
      if (this.issuedCandidateFingerprints.has(fingerprint)) return { normalizedUrl: preflight.data.normalizedUrl, policy: "rejected" as const };
      this.issuedCandidateFingerprints.add(fingerprint);
      const candidate: AnySearchCandidate = Object.freeze({ kind: "anysearch_public_job_candidate", normalizedUrl: preflight.data.normalizedUrl, allowedSiteDomains: preflight.data.allowedSiteDomains, queryId: parsedInput.queryId, candidateFingerprint: fingerprint });
      return { normalizedUrl: candidate.normalizedUrl, policy: "accepted" as const, candidate };
    });
    return { ok: true, data: { queryId: parsedInput.queryId, ordinal: parsedInput.ordinal, candidates } };
  }

  async searchBatch(inputs: readonly unknown[]): Promise<readonly AnySearchResult<{ queryId: string; ordinal: number; candidates: readonly AnySearchCandidateOutcome[] }>[]> {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_BATCH_SIZE) return [error("ANYSEARCH_POLICY_REJECTED", false, null)];
    const results: Array<AnySearchResult<{ queryId: string; ordinal: number; candidates: readonly AnySearchCandidateOutcome[] }> | undefined> = Array(inputs.length);
    let cursor = 0;
    const worker = async () => { for (;;) { const index = cursor++; if (index >= inputs.length) return; results[index] = await this.search(inputs[index]); } };
    await Promise.all(Array.from({ length: inputs.length }, worker));
    return results as readonly AnySearchResult<{ queryId: string; ordinal: number; candidates: readonly AnySearchCandidateOutcome[] }>[];
  }

  async extract(input: unknown): Promise<AnySearchResult<{ normalizedUrl: string; content: string }>> {
    if (!this.apiKey) return error("ANYSEARCH_NOT_CONFIGURED", false, null);
    const parsedInput = parseExtractInput(input);
    if (!parsedInput) return error("ANYSEARCH_POLICY_REJECTED", false, null);
    const checked = preflightAnySearchCandidate({ url: parsedInput.candidate.normalizedUrl, allowedSiteDomains: parsedInput.candidate.allowedSiteDomains });
    if (!checked.ok || checked.data.normalizedUrl !== parsedInput.candidate.normalizedUrl || candidateFingerprint(checked.data.normalizedUrl) !== parsedInput.candidate.candidateFingerprint) return error("ANYSEARCH_POLICY_REJECTED", false, null);
    const response = await this.request({ kind: "extract", identity: parsedInput.identity, candidateFingerprint: parsedInput.candidate.candidateFingerprint }, "/v1/extract", { url: checked.data.normalizedUrl }, parsedInput.signal, () => {
      if (this.claimedCandidateFingerprints.has(parsedInput.candidate.candidateFingerprint)) return false;
      this.claimedCandidateFingerprints.add(parsedInput.candidate.candidateFingerprint);
      return true;
    });
    if (!response.ok) return response;
    const parsed = parseExtract(response.data);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { normalizedUrl: checked.data.normalizedUrl, content: parsed.data.content } };
  }

  private async request(hookInput: Parameters<AnySearchBeforeRequest>[0], path: "/v1/search" | "/v1/extract", body: Record<string, unknown>, signal?: AbortSignal, claim?: () => boolean): Promise<AnySearchResult<unknown>> {
    if (signal?.aborted) return error("ANYSEARCH_CANCELLED", false, null);
    const proceed = await this.beforeRequest?.(hookInput);
    if (proceed === false || signal?.aborted) return error("ANYSEARCH_CANCELLED", false, null);
    if (claim && !claim()) return error("ANYSEARCH_POLICY_REJECTED", false, null);
    const controller = new AbortController();
    let timeout = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await abortable(this.fetch(new URL(path, this.baseUrl), { method: "POST", headers: { authorization: "Bearer " + this.apiKey, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: controller.signal }), controller.signal);
      } catch {
        if (signal?.aborted) return error("ANYSEARCH_CANCELLED", false, null);
        if (timeout) return error("ANYSEARCH_TIMEOUT", true, null);
        return error("ANYSEARCH_UNAVAILABLE", true, null);
      }
      const status = statusError(response.status);
      if (status) { await discardBody(response); return status; }
      try { return { ok: true, data: JSON.parse(new TextDecoder().decode(await readBytes(response, controller.signal))) }; } catch {
        if (signal?.aborted) return error("ANYSEARCH_CANCELLED", false, null);
        if (timeout) return error("ANYSEARCH_TIMEOUT", true, null);
        return error("ANYSEARCH_INVALID_RESPONSE", false, null);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function parseSearchInput(input: unknown): (Omit<z.infer<typeof LayeredPublicJobDiscoveryQuerySchema>, "allowedSiteDomains"> & { allowedSiteDomains: readonly string[]; signal?: AbortSignal }) | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { signal, ...query } = input as Record<string, unknown>;
  if (!isAbortSignal(signal)) return undefined;
  const parsed = LayeredPublicJobDiscoveryQuerySchema.safeParse(query);
  if (!parsed.success) return undefined;
  const allowedSiteDomains = normalizeAllowedDomains(parsed.data.allowedSiteDomains);
  if (!allowedSiteDomains) return undefined;
  return { ...parsed.data, allowedSiteDomains, signal: signal as AbortSignal | undefined };
}
function parseExtractInput(input: unknown): { candidate: AnySearchCandidate; identity: string; signal?: AbortSignal } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { signal, ...facts } = input as Record<string, unknown>;
  if (!isAbortSignal(signal) || Object.keys(facts).length !== 2 || typeof facts.identity !== "string" || !z.uuid().safeParse(facts.identity).success) return undefined;
  const candidate = CandidateSchema.safeParse(facts.candidate);
  if (!candidate.success) return undefined;
  const allowedSiteDomains = normalizeAllowedDomains(candidate.data.allowedSiteDomains);
  if (!allowedSiteDomains || !sameValues(allowedSiteDomains, candidate.data.allowedSiteDomains)) return undefined;
  return { candidate: Object.freeze({ ...candidate.data, allowedSiteDomains }), identity: facts.identity, signal: signal as AbortSignal | undefined };
}
function sameValues(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function statusError(status: number): Failure | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 402) return error("ANYSEARCH_QUOTA_EXHAUSTED", false, 402);
  if (status === 429) return error("ANYSEARCH_RATE_LIMITED", true, 429);
  if (status === 401 || status === 403) return error("ANYSEARCH_AUTH_FAILED", false, status);
  if (status === 400 || status === 415) return error("ANYSEARCH_INVALID_RESPONSE", false, status);
  if (status === 500 || status === 502 || status === 503 || status === 504) return error("ANYSEARCH_UNAVAILABLE", true, status);
  return error("ANYSEARCH_INVALID_RESPONSE", false, null);
}
function parseSearch(value: unknown): AnySearchResult<Array<{ url: string }>> {
  const envelope = parseEnvelope(value);
  if (!envelope || !Array.isArray(envelope.data.results) || envelope.data.results.length > MAX_BATCH_SIZE) return error("ANYSEARCH_INVALID_RESPONSE", false, null);
  const results: Array<{ url: string }> = [];
  for (const result of envelope.data.results) {
    if (!isRecord(result) || typeof result.url !== "string" || typeof result.title !== "string" || !("content" in result || "snippet" in result) || ("content" in result && typeof result.content !== "string") || ("snippet" in result && typeof result.snippet !== "string")) return error("ANYSEARCH_INVALID_RESPONSE", false, null);
    results.push({ url: result.url });
  }
  return { ok: true, data: results };
}
function parseExtract(value: unknown): AnySearchResult<{ content: string }> {
  const envelope = parseEnvelope(value);
  if (!envelope || typeof envelope.data.url !== "string" || typeof envelope.data.title !== "string" || typeof envelope.data.content !== "string") return error("ANYSEARCH_INVALID_RESPONSE", false, null);
  return { ok: true, data: { content: envelope.data.content } };
}
function parseEnvelope(value: unknown): { data: Record<string, unknown> } | undefined { return isRecord(value) && value.code === 0 && typeof value.message === "string" && typeof value.request_id === "string" && isRecord(value.data) ? { data: value.data } : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeNormalizedUrl(value: string): string | null { const preflight = preflightAnySearchCandidate({ url: value, allowedSiteDomains: [] }); return preflight.ok ? preflight.data.normalizedUrl : null; }
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => { const abort = () => { cleanup(); reject(new Error("aborted")); }; const cleanup = () => signal.removeEventListener("abort", abort); signal.addEventListener("abort", abort, { once: true }); operation.then((value) => { cleanup(); resolve(value); }, (reason) => { cleanup(); reject(reason); }); });
}
async function discardBody(response: Response): Promise<void> { try { await response.body?.cancel(); } catch { /* do not read status body */ } }
async function readBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) { const next = await abortable(reader.read(), signal); if (next.done) break; size += next.value.byteLength; if (size > MAX_RESPONSE_BYTES) throw new Error("response too large"); chunks.push(next.value); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (cause) {
    try { await reader.cancel(cause); } catch { /* cancellation is best effort */ }
    throw cause;
  } finally { reader.releaseLock(); }
}
