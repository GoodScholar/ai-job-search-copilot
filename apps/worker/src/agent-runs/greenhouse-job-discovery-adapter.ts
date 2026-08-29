import { z } from "zod";
import {
  PUBLIC_JOB_DISCOVERY_BUDGET,
  AgentRunTargetSnapshotSchema,
  type DiscoveryDetailInput,
  type DiscoveryDetailResult,
  type DiscoverySearchInput,
  type DiscoverySearchResult,
  type PublicDiscoveryBatchSearchResult,
  PublicAgentRunSourceScopeSchema,
} from "@job-copilot/contracts/agent-runs";
import { classifyGreenhousePublicSource } from "@job-copilot/contracts/job-discovery-schedules";
import { PublicSourceAccessError, createPublicSourceClient, type PublicSourceClient } from "@job-copilot/source-access";
import type { JobDiscoveryAdapter } from "@job-copilot/domain/agent-runs";

const GREENHOUSE_API_HOST = "boards-api.greenhouse.io";
const RuntimeGreenhouseSourceSchema = z.object({
  sourceId: z.string(), watchlistItemId: z.string(), canonicalCompanyName: z.string(), careersUrl: z.string(),
  allowedDomains: z.array(z.string()), boardToken: z.string(),
}).strict();
const GreenhouseBatchSearchInputSchema = z.object({
  targetSnapshot: AgentRunTargetSnapshotSchema,
  sourceScope: z.object({
    kind: z.literal("company_watchlist"), adapter: z.literal("greenhouse"), adapterVersion: z.literal("greenhouse-job-board-v1"),
    watchlistVersion: z.number().int().positive(), sources: z.array(RuntimeGreenhouseSourceSchema).min(1).max(50),
  }).strict(),
}).strict();
const ListJobSchema = z.object({
  id: z.union([z.number().int(), z.string().trim().min(1)]),
  title: z.string().trim().min(1),
  location: z.object({ name: z.string().trim().min(1) }).passthrough(),
}).passthrough();
export const GreenhouseListResponseSchema = z.object({
  jobs: z.array(ListJobSchema),
  meta: z.object({ total: z.number().int().nonnegative() }).passthrough(),
}).passthrough();
export const GreenhouseDetailResponseSchema = z.object({
  id: z.union([z.number().int(), z.string().trim().min(1)]),
  title: z.string().trim().min(1),
  company_name: z.string().trim().min(1),
  location: z.object({ name: z.string().trim().min(1) }).passthrough(),
  first_published: z.iso.datetime(),
  application_deadline: z.iso.datetime().nullable(),
}).passthrough();

type PublicAgentRunSourceScope = z.infer<typeof PublicAgentRunSourceScopeSchema>;
type Source = PublicAgentRunSourceScope["sources"][number];
type AuthorizedSource = { source: Source; boardToken: string };
type PublicItems = Extract<PublicDiscoveryBatchSearchResult, { ok: true }> ["data"]["items"];
type PublicScans = Extract<PublicDiscoveryBatchSearchResult, { ok: true }> ["data"]["scans"];

function apiUrl(boardToken: string, detailId?: string): URL {
  const encodedBoard = encodeURIComponent(boardToken);
  const path = detailId === undefined
    ? `/v1/boards/${encodedBoard}/jobs`
    : `/v1/boards/${encodedBoard}/jobs/${encodeURIComponent(detailId)}`;
  const url = new URL(`https://${GREENHOUSE_API_HOST}${path}`);
  if (detailId === undefined) url.search = "?content=true";
  return url;
}

function sourceAuthorization(value: unknown): { ok: true; value: AuthorizedSource } | { ok: false; code: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "GREENHOUSE_SOURCE_UNSUPPORTED" };
  const source = value as Record<string, unknown>;
  const expected = ["sourceId", "watchlistItemId", "canonicalCompanyName", "careersUrl", "allowedDomains", "boardToken"];
  if (Object.keys(source).length !== expected.length || expected.some((key) => !(key in source))
    || !["sourceId", "watchlistItemId", "canonicalCompanyName", "careersUrl", "boardToken"].every((key) => typeof source[key] === "string")
    || !Array.isArray(source.allowedDomains) || source.allowedDomains.some((domain) => typeof domain !== "string")) {
    return { ok: false, code: "GREENHOUSE_SOURCE_UNSUPPORTED" };
  }
  const typed = source as unknown as Source;
  let classification;
  try {
    classification = classifyGreenhousePublicSource({
      itemId: typed.watchlistItemId,
      canonicalCompanyName: typed.canonicalCompanyName,
      careersUrl: typed.careersUrl,
      allowedDomains: typed.allowedDomains,
    });
  } catch { return { ok: false, code: "GREENHOUSE_SOURCE_UNSUPPORTED" }; }
  if (classification.kind === "policy_required") return { ok: false, code: classification.code };
  if (classification.kind !== "supported" || classification.source.sourceId !== typed.sourceId || classification.source.boardToken !== typed.boardToken) {
    return { ok: false, code: "GREENHOUSE_SOURCE_UNSUPPORTED" };
  }
  return { ok: true, value: { source: typed, boardToken: classification.source.boardToken } };
}

function matchesTarget(job: z.infer<typeof ListJobSchema>, target: DiscoverySearchInput["targetSnapshot"]): boolean {
  const role = target.constraints.roleFamily.trim().toLocaleLowerCase("en-US");
  if (role && !job.title.toLocaleLowerCase("en-US").includes(role)) return false;
  return target.constraints.locations.length === 0 || target.constraints.locations.includes(job.location.name);
}

function failure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof PublicSourceAccessError) {
    const map: Record<string, { code: string; retryable: boolean }> = {
      PUBLIC_SOURCE_TIMEOUT: { code: "GREENHOUSE_TIMEOUT", retryable: true },
      PUBLIC_SOURCE_RESPONSE_TOO_LARGE: { code: "GREENHOUSE_RESPONSE_TOO_LARGE", retryable: false },
      PUBLIC_SOURCE_REDIRECT_INVALID: { code: "GREENHOUSE_REDIRECT_INVALID", retryable: false },
      PUBLIC_SOURCE_CONTENT_TYPE_INVALID: { code: "GREENHOUSE_INVALID_RESPONSE", retryable: false },
      PUBLIC_SOURCE_UNREACHABLE: { code: "GREENHOUSE_UNREACHABLE", retryable: true },
      PUBLIC_SOURCE_TARGET_REJECTED: { code: "GREENHOUSE_API_HOST_NOT_ALLOWED", retryable: false },
      PUBLIC_SOURCE_NETWORK_DISABLED: { code: "GREENHOUSE_NETWORK_DISABLED", retryable: false },
      PUBLIC_SOURCE_ABORTED: { code: "GREENHOUSE_TIMEOUT", retryable: true },
    };
    return map[error.code] ?? { code: "GREENHOUSE_REQUEST_FAILED", retryable: false };
  }
  return { code: "GREENHOUSE_INVALID_RESPONSE", retryable: false };
}

function statusFailure(status: number): { code: string; retryable: boolean } | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return { code: "GREENHOUSE_AUTH_FAILED", retryable: false };
  if (status === 404) return { code: "GREENHOUSE_NOT_FOUND", retryable: false };
  if (status === 429) return { code: "GREENHOUSE_RATE_LIMITED", retryable: true };
  if (status >= 500 && status <= 599) return { code: "GREENHOUSE_SERVER_ERROR", retryable: true };
  return { code: "GREENHOUSE_HTTP_FAILED", retryable: false };
}

function decode(body: Uint8Array): unknown { return JSON.parse(new TextDecoder().decode(body)); }

/** 只读取已授权 Greenhouse Job Board API 的列表和精确岗位详情。 */
export class GreenhouseJobDiscoveryAdapter implements JobDiscoveryAdapter {
  private sources = new Map<string, AuthorizedSource>();
  private candidates = new Set<string>();
  private detailCache = new Map<string, DiscoveryDetailResult>();
  private readonly client: PublicSourceClient;

  constructor(input: { client?: PublicSourceClient } = {}) {
    if (input.client && process.env.APP_ENV !== "test") throw new Error("GREENHOUSE_TEST_CLIENT_DISABLED");
    this.client = input.client ?? createPublicSourceClient({ exactHosts: [GREENHOUSE_API_HOST] });
  }

  async search(_input: DiscoverySearchInput): Promise<DiscoverySearchResult> {
    return { ok: false, error: { code: "GREENHOUSE_SEARCH_UNSUPPORTED", retryable: false } };
  }

  async searchBatch(input: { targetSnapshot: DiscoverySearchInput["targetSnapshot"]; sourceScope: PublicAgentRunSourceScope }): Promise<PublicDiscoveryBatchSearchResult> {
    // A batch owns one discovery generation. No prior generation may serve a
    // detail while this one is empty, malformed, or only partially fetched.
    this.sources.clear();
    this.candidates.clear();
    this.detailCache.clear();
    const parsedInput = GreenhouseBatchSearchInputSchema.safeParse(input);
    if (!parsedInput.success) return { ok: false, error: { code: "GREENHOUSE_SOURCE_UNSUPPORTED", retryable: false } };
    const rawSources = parsedInput.data.sourceScope.sources;
    const authorizedSources: AuthorizedSource[] = [];
    for (const rawSource of rawSources) {
      if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) return { ok: false, error: { code: "GREENHOUSE_SOURCE_UNSUPPORTED", retryable: false } };
      const authorized = sourceAuthorization(rawSource);
      if (!authorized.ok) return { ok: false, error: { code: authorized.code, retryable: false } };
      authorizedSources.push(authorized.value);
    }
    const strictScope = PublicAgentRunSourceScopeSchema.safeParse(parsedInput.data.sourceScope);
    if (!strictScope.success || strictScope.data.sources.length !== authorizedSources.length) {
      return { ok: false, error: { code: "GREENHOUSE_SOURCE_UNSUPPORTED", retryable: false } };
    }
    const items: PublicItems = [];
    const scans: PublicScans = [];
    const nextSources = new Map<string, AuthorizedSource>();
    const nextCandidates = new Set<string>();
    for (const authorized of authorizedSources) {
      const rawSource = authorized.source;
      nextSources.set(rawSource.sourceId, authorized);
      let response;
      try {
        response = await this.client.get({ url: apiUrl(authorized.boardToken), allowedDomains: [GREENHOUSE_API_HOST], accept: "application/json", maxRedirects: 0, retry: "bounded" });
      } catch (error) { return { ok: false, error: failure(error) }; }
      const httpFailure = statusFailure(response.status);
      if (httpFailure) return { ok: false, error: httpFailure };
      const parsed = GreenhouseListResponseSchema.safeParse(safeDecode(response.body));
      if (!parsed.success) return { ok: false, error: { code: "GREENHOUSE_LIST_SCHEMA_INVALID", retryable: false } };
      const observedDetailIds = [...new Set(parsed.data.jobs.map((job) => String(job.id)))];
      scans.push({ sourceId: rawSource.sourceId, observedDetailIds, complete: observedDetailIds.length === parsed.data.meta.total });
      for (const job of parsed.data.jobs) {
        if (items.length >= PUBLIC_JOB_DISCOVERY_BUDGET.maxResults || !matchesTarget(job, parsedInput.data.targetSnapshot)) continue;
        const detailId = String(job.id);
        nextCandidates.add(`${rawSource.sourceId}:${detailId}`);
        items.push({ sourceId: rawSource.sourceId, detailId, company: null, title: job.title, location: job.location.name });
      }
    }
    this.sources = nextSources;
    this.candidates = nextCandidates;
    return { ok: true, data: { items, scans } };
  }

  async getDetail(input: DiscoveryDetailInput): Promise<DiscoveryDetailResult> {
    const key = `${input.sourceId}:${input.detailId}`;
    const cached = this.detailCache.get(key);
    if (cached) return cached;
    const source = this.sources.get(input.sourceId);
    if (!source || !this.candidates.has(key)) return { ok: false, error: { code: "GREENHOUSE_DETAIL_NOT_SELECTED", retryable: false } };
    let response;
    try {
      response = await this.client.get({ url: apiUrl(source.boardToken, input.detailId), allowedDomains: [GREENHOUSE_API_HOST], accept: "application/json", maxRedirects: 0, retry: "bounded" });
    } catch (error) { return { ok: false, error: failure(error) }; }
    const httpFailure = statusFailure(response.status);
    if (httpFailure) return { ok: false, error: httpFailure };
    const raw = safeDecode(response.body);
    const parsed = GreenhouseDetailResponseSchema.safeParse(raw);
    if (!parsed.success || String(parsed.data.id) !== input.detailId) return { ok: false, error: { code: "GREENHOUSE_DETAIL_SCHEMA_INVALID", retryable: false } };
    const result: DiscoveryDetailResult = {
      ok: true,
      data: { sourceId: input.sourceId, detailId: input.detailId, company: parsed.data.company_name, title: parsed.data.title, location: parsed.data.location.name, postedAt: parsed.data.first_published, deadline: parsed.data.application_deadline, sourceType: "company_careers", isOfficial: true, rawPayload: raw as Record<string, unknown> },
    };
    this.detailCache.set(key, result);
    return result;
  }
}

function safeDecode(body: Uint8Array): unknown {
  try { return decode(body); } catch { return null; }
}
