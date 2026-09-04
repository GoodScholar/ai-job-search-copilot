import { z } from "zod";
import {
  GREENHOUSE_JOB_DISCOVERY_ADAPTER,
  GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
  SourceHealthDetailIdSchema,
  PUBLIC_JOB_DISCOVERY_BUDGET,
  type AgentRunDetail,
  type PublicSourceHealthAgentRunSourceScope,
} from "@job-copilot/contracts/agent-runs";
import { GreenhousePublicSourceSchema } from "@job-copilot/contracts/job-discovery-schedules";
import { declareFormalBetaSourceCapabilities, type SourceCapabilityDeclaration } from "@job-copilot/contracts/source-capabilities";
import { PublicSourceAccessError, createPublicSourceClient, type PublicSourceClient } from "@job-copilot/source-access";
import type { SourceHealthAdapterFailure, SourceHealthDiscoveryAdapter, SourceHealthDetailResult, SourceHealthListResult } from "@job-copilot/domain/agent-runs";

const GREENHOUSE_API_HOST = "boards-api.greenhouse.io";
const ListJobSchema = z.object({
  id: z.union([z.number().int(), z.string().trim().min(1)]),
  title: z.string().trim().min(1),
  location: z.object({ name: z.string().trim().min(1) }).passthrough(),
}).passthrough();
const GreenhouseSourceListSchema = z.object({
  jobs: z.array(ListJobSchema).max(500).superRefine((jobs, context) => {
    for (const [index, job] of jobs.entries()) {
      if (!SourceHealthDetailIdSchema.safeParse(String(job.id)).success) context.addIssue({ code: "custom", path: [index, "id"], message: "provider job ID must be a safe detail ID" });
    }
    if (new Set(jobs.map((job) => String(job.id))).size !== jobs.length) context.addIssue({ code: "custom", message: "provider job IDs must be unique after normalization" });
  }),
  meta: z.object({ total: z.number().int().nonnegative() }).passthrough(),
}).passthrough().superRefine((list, context) => {
  if (list.jobs.length !== list.meta.total) context.addIssue({ code: "custom", path: ["meta", "total"], message: "provider job list must be complete" });
});
const GreenhouseSourceDetailSchema = z.object({
  id: z.union([z.number().int(), z.string().trim().min(1)]),
  title: z.string().trim().min(1),
  company_name: z.string().trim().min(1),
  location: z.object({ name: z.string().trim().min(1) }).passthrough(),
  first_published: z.iso.datetime(),
  application_deadline: z.iso.datetime().nullable(),
  absolute_url: z.string().trim().min(1),
}).passthrough();

type Source = PublicSourceHealthAgentRunSourceScope["sources"][number];
type TargetSnapshot = AgentRunDetail["targetSnapshot"];

function apiUrl(boardToken: string, detailId?: string): URL {
  const path = detailId === undefined
    ? `/v1/boards/${encodeURIComponent(boardToken)}/jobs`
    : `/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(detailId)}`;
  const url = new URL(`https://${GREENHOUSE_API_HOST}${path}`);
  if (detailId === undefined) url.search = "?content=true";
  return url;
}

function sourceFailure(reasonCode: SourceHealthAdapterFailure["reasonCode"], retryable: boolean, attemptCount: number): SourceHealthAdapterFailure {
  if (reasonCode === "SOURCE_RATE_LIMITED") return { category: "rate_limited", reasonCode, retryable, attemptCount };
  if (reasonCode.startsWith("SOURCE_DETAIL_") || reasonCode === "SOURCE_LIST_SCHEMA_INVALID") {
    return { category: "parser_degraded", reasonCode, retryable, attemptCount };
  }
  return { category: "hard_failed", reasonCode, retryable, attemptCount };
}

function failure(error: unknown): SourceHealthAdapterFailure {
  if (error instanceof PublicSourceAccessError) {
    const mapped: Record<string, [SourceHealthAdapterFailure["reasonCode"], boolean]> = {
      PUBLIC_SOURCE_TIMEOUT: ["SOURCE_TIMEOUT", true],
      PUBLIC_SOURCE_ABORTED: ["SOURCE_TIMEOUT", true],
      PUBLIC_SOURCE_UNREACHABLE: ["SOURCE_UNREACHABLE", true],
      PUBLIC_SOURCE_TARGET_REJECTED: ["SOURCE_POLICY_REJECTED", false],
      PUBLIC_SOURCE_NETWORK_DISABLED: ["SOURCE_POLICY_REJECTED", false],
      PUBLIC_SOURCE_REDIRECT_INVALID: ["SOURCE_POLICY_REJECTED", false],
      PUBLIC_SOURCE_RESPONSE_TOO_LARGE: ["SOURCE_SERVER_ERROR", false],
      PUBLIC_SOURCE_CONTENT_TYPE_INVALID: ["SOURCE_SERVER_ERROR", false],
    };
    const [reasonCode, retryable] = mapped[error.code] ?? ["SOURCE_UNREACHABLE", false];
    return sourceFailure(reasonCode, retryable, Math.max(1, error.attemptCount));
  }
  return sourceFailure("SOURCE_UNREACHABLE", false, 1);
}

function statusFailure(status: number, attemptCount: number): SourceHealthAdapterFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429) return sourceFailure("SOURCE_RATE_LIMITED", true, attemptCount);
  if (status === 401 || status === 403) return sourceFailure("SOURCE_AUTH_FAILED", false, attemptCount);
  if (status >= 500 && status <= 599) return sourceFailure("SOURCE_SERVER_ERROR", true, attemptCount);
  return sourceFailure("SOURCE_SERVER_ERROR", false, attemptCount);
}

function matchesTarget(job: z.infer<typeof ListJobSchema>, target: TargetSnapshot): boolean {
  const role = target.constraints.roleFamily.trim().toLocaleLowerCase("en-US");
  return (!role || job.title.toLocaleLowerCase("en-US").includes(role))
    && (target.constraints.locations.length === 0 || target.constraints.locations.includes(job.location.name));
}

function isSafeAbsoluteUrl(value: string, source: Source, detailId: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && (url.hostname === "boards.greenhouse.io" || url.hostname === "job-boards.greenhouse.io")
      && url.pathname === `/${source.boardToken}/jobs/${encodeURIComponent(detailId)}`;
  } catch { return false; }
}

function decode(body: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(body)); } catch { return null; }
}

function authorizedSource(source: unknown): Source | undefined {
  const parsed = GreenhousePublicSourceSchema.safeParse(source);
  return parsed.success ? parsed.data : undefined;
}

/** Greenhouse v3 受控检查：每一次列表或详情请求只影响一个来源。 */
export class GreenhouseSourceHealthAdapter implements SourceHealthDiscoveryAdapter {
  readonly adapter = GREENHOUSE_JOB_DISCOVERY_ADAPTER;
  readonly adapterVersion = GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION;
  private readonly client: PublicSourceClient;

  constructor(input: { client?: PublicSourceClient } = {}) {
    if (input.client && process.env.APP_ENV !== "test") throw new Error("GREENHOUSE_TEST_CLIENT_DISABLED");
    this.client = input.client ?? createPublicSourceClient({ exactHosts: [GREENHOUSE_API_HOST] });
  }

  declareCapabilities(input: { sourceId: string }): SourceCapabilityDeclaration {
    return declareFormalBetaSourceCapabilities({ sourceId: input.sourceId, adapter: this.adapter, adapterVersion: this.adapterVersion });
  }

  async listSource(input: { targetSnapshot: TargetSnapshot; source: Source }): Promise<SourceHealthListResult> {
    const source = authorizedSource(input.source);
    if (!source) return { ok: false, failure: sourceFailure("SOURCE_POLICY_REJECTED", false, 1) };
    let response;
    try {
      response = await this.client.get({ url: apiUrl(source.boardToken), allowedDomains: [GREENHOUSE_API_HOST], accept: "application/json", maxRedirects: 0, retry: "bounded" });
    } catch (error) { return { ok: false, failure: failure(error) }; }
    const httpFailure = statusFailure(response.status, response.attemptCount);
    if (httpFailure) return { ok: false, failure: httpFailure };
    const parsed = GreenhouseSourceListSchema.safeParse(decode(response.body));
    if (!parsed.success) return { ok: false, failure: sourceFailure("SOURCE_LIST_SCHEMA_INVALID", false, response.attemptCount) };
    const observedDetailIds = [...new Set(parsed.data.jobs.map((job) => String(job.id)))];
    const candidates = parsed.data.jobs
      .filter((job) => matchesTarget(job, input.targetSnapshot))
      .slice(0, PUBLIC_JOB_DISCOVERY_BUDGET.maxResults)
      .map((job) => ({ sourceId: source.sourceId, detailId: String(job.id), company: null, title: job.title, location: job.location.name }));
    return { ok: true, data: { sourceId: source.sourceId, observedDetailIds, candidates }, attemptCount: response.attemptCount };
  }

  async getSourceDetail(input: { source: Source; detailId: string }): Promise<SourceHealthDetailResult> {
    const source = authorizedSource(input.source);
    if (!source) return { ok: false, failure: sourceFailure("SOURCE_POLICY_REJECTED", false, 1) };
    let response;
    try {
      response = await this.client.get({ url: apiUrl(source.boardToken, input.detailId), allowedDomains: [GREENHOUSE_API_HOST], accept: "application/json", maxRedirects: 0, retry: "bounded" });
    } catch (error) { return { ok: false, failure: failure(error) }; }
    const httpFailure = statusFailure(response.status, response.attemptCount);
    if (httpFailure) return { ok: false, failure: httpFailure };
    const raw = decode(response.body);
    const parsed = GreenhouseSourceDetailSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, failure: sourceFailure("SOURCE_DETAIL_FIELDS_MISSING", false, response.attemptCount) };
    if (!isSafeAbsoluteUrl(parsed.data.absolute_url, source, input.detailId)) return { ok: false, failure: sourceFailure("SOURCE_DETAIL_URL_INVALID", false, response.attemptCount) };
    if (String(parsed.data.id) !== input.detailId) return { ok: false, failure: sourceFailure("SOURCE_DETAIL_IDENTITY_INVALID", false, response.attemptCount) };
    return {
      ok: true,
      data: {
        sourceId: source.sourceId, detailId: input.detailId, company: parsed.data.company_name, title: parsed.data.title,
        location: parsed.data.location.name, postedAt: parsed.data.first_published, deadline: parsed.data.application_deadline,
        sourceType: "company_careers", isOfficial: true, absoluteUrl: parsed.data.absolute_url, rawPayload: raw as Record<string, unknown>,
      },
      attemptCount: response.attemptCount,
    };
  }
}
