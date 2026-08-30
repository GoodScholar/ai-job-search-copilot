import type { AnySearchProviderError } from "@job-copilot/contracts/job-discovery";

const ANYSEARCH_BASE_URL = "https://api.anysearch.com";
const MAX_BATCH_SIZE = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const identityParameters = new Set([
  "id", "job", "jobid", "job_id", "openingid", "opening_id", "positionid", "position_id", "requisitionid", "requisition_id",
]);
const identityValue = /^[A-Za-z0-9._~-]{1,128}$/u;

type Failure = { ok: false; error: AnySearchProviderError };
type Success<T> = { ok: true; data: T };
export type AnySearchResult<T> = Success<T> | Failure;
export type AnySearchCandidate = {
  readonly kind: "anysearch_public_job_candidate";
  readonly normalizedUrl: string;
};
export type AnySearchCandidateOutcome = {
  readonly normalizedUrl: string | null;
  readonly policy: "accepted" | "rejected";
  readonly candidate?: AnySearchCandidate;
};
export type AnySearchSearchInput = {
  queryId: string;
  ordinal: number;
  query: string;
  allowedSiteDomains: readonly string[];
  signal?: AbortSignal;
};
export type AnySearchExtractInput = { candidate: AnySearchCandidate; identity: string; signal?: AbortSignal };
export type AnySearchBeforeRequest = (input: { kind: "search" | "extract"; identity: string }) => Promise<void | false> | void | false;
export type AnySearchFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type PreflightFailure = Failure;
type PreflightSuccess = Success<{ normalizedUrl: string; allowedSiteDomains: readonly string[] }>;
export type AnySearchCandidatePreflight = PreflightSuccess | PreflightFailure;

function error(code: AnySearchProviderError["code"], retryable: boolean, httpStatus: AnySearchProviderError["httpStatus"]): Failure {
  return { ok: false, error: { code, retryable, httpStatus } };
}

function normalizeHost(value: string): string { return value.toLowerCase().replace(/\.$/u, ""); }

function allowedHost(hostname: string, domains: readonly string[]): boolean {
  if (domains.length === 0) return true;
  const host = normalizeHost(hostname);
  return domains.some((domain) => {
    if (typeof domain !== "string") return false;
    const allowed = normalizeHost(domain.trim());
    return allowed.length > 0 && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

/** 将不可信 provider URL 收紧为可验证的公开岗位 URL；绝不在失败结果中回显原 URL。 */
export function preflightAnySearchCandidate(input: { url: unknown; allowedSiteDomains: readonly string[] }): AnySearchCandidatePreflight {
  if (typeof input.url !== "string" || !Array.isArray(input.allowedSiteDomains)) return error("ANYSEARCH_POLICY_REJECTED", false, null);
  let url: URL;
  try { url = new URL(input.url); } catch { return error("ANYSEARCH_POLICY_REJECTED", false, null); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return error("ANYSEARCH_POLICY_REJECTED", false, null);
  const retained = [...url.searchParams].filter(([key, value]) => identityParameters.has(key.toLowerCase()) && identityValue.test(value));
  const invalidIdentity = [...url.searchParams].some(([key, value]) => identityParameters.has(key.toLowerCase()) && !identityValue.test(value));
  if (invalidIdentity) return error("ANYSEARCH_POLICY_REJECTED", false, null);
  retained.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [key, value] of retained) url.searchParams.append(key, value);
  url.hash = "";
  if (!allowedHost(url.hostname, input.allowedSiteDomains)) return error("ANYSEARCH_POLICY_REJECTED", false, null);
  return { ok: true, data: { normalizedUrl: url.toString(), allowedSiteDomains: [...input.allowedSiteDomains] } };
}

export class AnySearchPublicJobAdapter {
  private readonly apiKey: string | undefined;
  private readonly fetch: AnySearchFetch;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly acceptedCandidates = new WeakSet<object>();
  private readonly consumedCandidates = new WeakSet<object>();
  private readonly candidatePolicies = new WeakMap<object, readonly string[]>();
  private readonly beforeRequest?: AnySearchBeforeRequest;

  constructor(input: {
    apiKey?: string;
    transport?: AnySearchFetch;
    baseUrl?: string;
    timeoutMs?: number;
    beforeRequest?: AnySearchBeforeRequest;
  } = {}) {
    if ((input.transport || input.baseUrl) && process.env.APP_ENV !== "test") throw new Error("ANYSEARCH_TEST_TRANSPORT_DISABLED");
    this.apiKey = input.apiKey?.trim() || undefined;
    this.fetch = input.transport ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = new URL(input.baseUrl ?? ANYSEARCH_BASE_URL);
    if (process.env.APP_ENV !== "test" && this.baseUrl.origin !== ANYSEARCH_BASE_URL) throw new Error("ANYSEARCH_BASE_URL_INVALID");
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.beforeRequest = input.beforeRequest;
  }

  async search(input: AnySearchSearchInput): Promise<AnySearchResult<{ queryId: string; ordinal: number; candidates: readonly AnySearchCandidateOutcome[] }>> {
    if (!this.apiKey) return error("ANYSEARCH_NOT_CONFIGURED", false, null);
    if (!validSearchInput(input)) return error("ANYSEARCH_POLICY_REJECTED", false, null);
    const response = await this.request("search", input.queryId, "/v1/search", { query: input.query, max_results: 5 }, input.signal);
    if (!response.ok) return response;
    const parsed = parseSearch(response.data);
    if (!parsed.ok) return parsed;
    const candidates = parsed.data.map((result) => {
      const preflight = preflightAnySearchCandidate({ url: result.url, allowedSiteDomains: input.allowedSiteDomains });
      if (!preflight.ok) return { normalizedUrl: safeNormalizedUrl(result.url), policy: "rejected" as const };
      const candidate: AnySearchCandidate = Object.freeze({
        kind: "anysearch_public_job_candidate",
        normalizedUrl: preflight.data.normalizedUrl,
      });
      this.acceptedCandidates.add(candidate);
      this.candidatePolicies.set(candidate, Object.freeze([...preflight.data.allowedSiteDomains]));
      return { normalizedUrl: candidate.normalizedUrl, policy: "accepted" as const, candidate };
    });
    return { ok: true, data: { queryId: input.queryId, ordinal: input.ordinal, candidates } };
  }

  async searchBatch(inputs: readonly AnySearchSearchInput[]): Promise<readonly AnySearchResult<{ queryId: string; ordinal: number; candidates: readonly AnySearchCandidateOutcome[] }>[]> {
    if (inputs.length < 1 || inputs.length > MAX_BATCH_SIZE) return [error("ANYSEARCH_POLICY_REJECTED", false, null)];
    const results: Array<AnySearchResult<{ queryId: string; ordinal: number; candidates: readonly AnySearchCandidateOutcome[] }> | undefined> = Array(inputs.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= inputs.length) return;
        results[index] = await this.search(inputs[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_BATCH_SIZE, inputs.length) }, worker));
    return results as readonly AnySearchResult<{ queryId: string; ordinal: number; candidates: readonly AnySearchCandidateOutcome[] }>[];
  }

  async extract(input: AnySearchExtractInput): Promise<AnySearchResult<{ normalizedUrl: string; content: string }>> {
    if (!this.apiKey) return error("ANYSEARCH_NOT_CONFIGURED", false, null);
    if (!input || typeof input.identity !== "string" || !this.acceptedCandidates.has(input.candidate) || this.consumedCandidates.has(input.candidate)) return error("ANYSEARCH_POLICY_REJECTED", false, null);
    const allowedSiteDomains = this.candidatePolicies.get(input.candidate);
    if (!allowedSiteDomains) return error("ANYSEARCH_POLICY_REJECTED", false, null);
    const checked = preflightAnySearchCandidate({ url: input.candidate.normalizedUrl, allowedSiteDomains });
    if (!checked.ok || checked.data.normalizedUrl !== input.candidate.normalizedUrl) return error("ANYSEARCH_POLICY_REJECTED", false, null);
    this.consumedCandidates.add(input.candidate);
    const response = await this.request("extract", input.identity, "/v1/extract", { url: checked.data.normalizedUrl }, input.signal);
    if (!response.ok) return response;
    const parsed = parseExtract(response.data);
    if (!parsed.ok) return parsed;
    return { ok: true, data: { normalizedUrl: checked.data.normalizedUrl, content: parsed.data.content } };
  }

  private async request(kind: "search" | "extract", identity: string, path: "/v1/search" | "/v1/extract", body: Record<string, unknown>, signal?: AbortSignal): Promise<AnySearchResult<unknown>> {
    if (signal?.aborted) return error("ANYSEARCH_CANCELLED", false, null);
    try {
      const proceed = await this.beforeRequest?.({ kind, identity });
      if (proceed === false || signal?.aborted) return error("ANYSEARCH_CANCELLED", false, null);
    } catch { return error("ANYSEARCH_CANCELLED", false, null); }
    const controller = new AbortController();
    let timeout = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await abortable(this.fetch(new URL(path, this.baseUrl), {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }), controller.signal);
      } catch {
        if (signal?.aborted) return error("ANYSEARCH_CANCELLED", false, null);
        if (timeout) return error("ANYSEARCH_TIMEOUT", true, null);
        return error("ANYSEARCH_UNAVAILABLE", true, null);
      }
      const status = statusError(response.status);
      if (status) return status;
      try {
        const bytes = await readBytes(response, controller.signal);
        return { ok: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
      } catch {
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

function validSearchInput(input: AnySearchSearchInput): boolean {
  return Boolean(input && typeof input.queryId === "string" && typeof input.query === "string" && input.query.trim() && Number.isInteger(input.ordinal) && input.ordinal > 0 && Array.isArray(input.allowedSiteDomains));
}

function statusError(status: number): Failure | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 402) return error("ANYSEARCH_QUOTA_EXHAUSTED", false, 402);
  if (status === 429) return error("ANYSEARCH_RATE_LIMITED", true, 429);
  if (status === 401 || status === 403) return error("ANYSEARCH_AUTH_FAILED", false, status);
  if (status === 500 || status === 502 || status === 503 || status === 504) return error("ANYSEARCH_UNAVAILABLE", true, status);
  return error("ANYSEARCH_UNAVAILABLE", true, null);
}

function parseSearch(value: unknown): AnySearchResult<Array<{ url: string }>> {
  const envelope = parseEnvelope(value);
  if (!envelope || !Array.isArray(envelope.data.results) || envelope.data.results.length > MAX_BATCH_SIZE) return error("ANYSEARCH_INVALID_RESPONSE", false, null);
  const results: Array<{ url: string }> = [];
  for (const result of envelope.data.results) {
    if (!isRecord(result) || typeof result.url !== "string" || typeof result.title !== "string" || (typeof result.content !== "string" && typeof result.snippet !== "string")) return error("ANYSEARCH_INVALID_RESPONSE", false, null);
    results.push({ url: result.url });
  }
  return { ok: true, data: results };
}

function parseExtract(value: unknown): AnySearchResult<{ content: string }> {
  const envelope = parseEnvelope(value);
  if (!envelope || typeof envelope.data.url !== "string" || typeof envelope.data.title !== "string" || typeof envelope.data.content !== "string") return error("ANYSEARCH_INVALID_RESPONSE", false, null);
  return { ok: true, data: { content: envelope.data.content } };
}

function parseEnvelope(value: unknown): { data: Record<string, unknown> } | undefined {
  if (!isRecord(value) || value.code !== 0 || typeof value.message !== "string" || typeof value.request_id !== "string" || !isRecord(value.data)) return undefined;
  return { data: value.data };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function safeNormalizedUrl(value: string): string | null {
  const preflight = preflightAnySearchCandidate({ url: value, allowedSiteDomains: [] });
  return preflight.ok ? preflight.data.normalizedUrl : null;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("aborted")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (reason) => { cleanup(); reject(reason); });
  });
}

async function readBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await abortable(reader.read(), signal);
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
