import { z } from "zod";
import { PUBLIC_JOB_DISCOVERY_BUDGET, type AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import { GreenhousePublicSourceSchema } from "@job-copilot/contracts/job-discovery-schedules";
import { declareFormalBetaSourceCapabilities, type SourceCapabilityDeclaration } from "@job-copilot/contracts/source-capabilities";
import { PublicSourceAccessError, createPublicSourceClient, type PublicSourceClient } from "@job-copilot/source-access";
import type { LayeredTrustedSourceAdapter } from "@job-copilot/domain/agent-runs";

const GREENHOUSE_API_HOST = "boards-api.greenhouse.io";
const ListSchema = z.object({
  jobs: z.array(z.object({ id: z.union([z.number().int(), z.string().trim().min(1)]), title: z.string().trim().min(1), location: z.object({ name: z.string().trim().min(1) }).passthrough() }).passthrough()).max(500),
  meta: z.object({ total: z.number().int().nonnegative() }).passthrough(),
}).passthrough();
const DetailSchema = z.object({
  id: z.union([z.number().int(), z.string().trim().min(1)]), title: z.string().trim().min(1), company_name: z.string().trim().min(1),
  location: z.object({ name: z.string().trim().min(1) }).passthrough(), first_published: z.iso.datetime(), application_deadline: z.iso.datetime().nullable(),
}).passthrough();

type Source = Parameters<LayeredTrustedSourceAdapter["listSource"]>[0]["source"];
type Target = AgentRunDetail["targetSnapshot"];

function apiUrl(boardToken: string, detailId?: string): URL {
  const path = detailId === undefined ? `/v1/boards/${encodeURIComponent(boardToken)}/jobs` : `/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(detailId)}`;
  const url = new URL(`https://${GREENHOUSE_API_HOST}${path}`);
  if (detailId === undefined) url.search = "?content=true";
  return url;
}
function decode(body: Uint8Array): unknown { try { return JSON.parse(new TextDecoder().decode(body)); } catch { return null; } }
function failure(error: unknown): string {
  if (error instanceof PublicSourceAccessError) {
    const codes: Partial<Record<PublicSourceAccessError["code"], string>> = {
      PUBLIC_SOURCE_TIMEOUT: "GREENHOUSE_TIMEOUT", PUBLIC_SOURCE_ABORTED: "GREENHOUSE_TIMEOUT", PUBLIC_SOURCE_UNREACHABLE: "GREENHOUSE_UNREACHABLE",
      PUBLIC_SOURCE_TARGET_REJECTED: "GREENHOUSE_API_HOST_NOT_ALLOWED", PUBLIC_SOURCE_NETWORK_DISABLED: "GREENHOUSE_NETWORK_DISABLED",
      PUBLIC_SOURCE_REDIRECT_INVALID: "GREENHOUSE_REDIRECT_INVALID", PUBLIC_SOURCE_RESPONSE_TOO_LARGE: "GREENHOUSE_RESPONSE_TOO_LARGE", PUBLIC_SOURCE_CONTENT_TYPE_INVALID: "GREENHOUSE_INVALID_RESPONSE",
    };
    return codes[error.code] ?? "GREENHOUSE_REQUEST_FAILED";
  }
  return "GREENHOUSE_INVALID_RESPONSE";
}
function statusFailure(status: number): string | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 401 || status === 403) return "GREENHOUSE_AUTH_FAILED";
  if (status === 404) return "GREENHOUSE_NOT_FOUND";
  if (status === 429) return "GREENHOUSE_RATE_LIMITED";
  if (status >= 500 && status < 600) return "GREENHOUSE_SERVER_ERROR";
  return "GREENHOUSE_HTTP_FAILED";
}
function sourceFor(value: Source): Source | undefined {
  const parsed = GreenhousePublicSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function matchesTarget(job: z.infer<typeof ListSchema>["jobs"][number], target: Target): boolean {
  const role = target.constraints.roleFamily.trim().toLocaleLowerCase("en-US");
  return (!role || job.title.toLocaleLowerCase("en-US").includes(role)) && (target.constraints.locations.length === 0 || target.constraints.locations.includes(job.location.name));
}

/** v4 可信分支专用端口；不改变 v1–v3 adapter 的方法签名或恢复语义。 */
export class GreenhouseTrustedSourceAdapter implements LayeredTrustedSourceAdapter {
  private readonly client: PublicSourceClient;
  private readonly selected = new Set<string>();

  constructor(input: { client?: PublicSourceClient } = {}) {
    if (input.client && process.env.APP_ENV !== "test") throw new Error("GREENHOUSE_TEST_CLIENT_DISABLED");
    this.client = input.client ?? createPublicSourceClient({ exactHosts: [GREENHOUSE_API_HOST] });
  }

  declareCapabilities(input: { sourceId: string }): SourceCapabilityDeclaration {
    return declareFormalBetaSourceCapabilities({ sourceId: input.sourceId, adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2" });
  }

  async listSource(input: Parameters<LayeredTrustedSourceAdapter["listSource"]>[0]) {
    const source = sourceFor(input.source);
    if (!source) return { ok: false as const, error: { code: "GREENHOUSE_SOURCE_UNSUPPORTED" } };
    let response;
    try { response = await this.client.get({ url: apiUrl(source.boardToken), allowedDomains: [GREENHOUSE_API_HOST], accept: "application/json", maxRedirects: 0, retry: "none", signal: input.signal }); }
    catch (error) { return { ok: false as const, error: { code: failure(error) } }; }
    const http = statusFailure(response.status);
    if (http) return { ok: false as const, error: { code: http } };
    const parsed = ListSchema.safeParse(decode(response.body));
    if (!parsed.success) return { ok: false as const, error: { code: "GREENHOUSE_LIST_SCHEMA_INVALID" } };
    const observedDetailIds = [...new Set(parsed.data.jobs.map((job) => String(job.id)))];
    if (observedDetailIds.length !== parsed.data.jobs.length || observedDetailIds.length !== parsed.data.meta.total) return { ok: false as const, error: { code: "GREENHOUSE_LIST_SCHEMA_INVALID" } };
    const candidates = parsed.data.jobs.filter((job) => matchesTarget(job, input.targetSnapshot)).slice(0, PUBLIC_JOB_DISCOVERY_BUDGET.maxResults).map((job) => ({ sourceId: source.sourceId, detailId: String(job.id) }));
    for (const candidate of candidates) this.selected.add(`${candidate.sourceId}:${candidate.detailId}`);
    return { ok: true as const, data: { sourceId: source.sourceId, observedDetailIds, candidates } };
  }

  async getSourceDetail(input: Parameters<LayeredTrustedSourceAdapter["getSourceDetail"]>[0]) {
    const source = sourceFor(input.source);
    if (!source || !this.selected.has(`${input.source.sourceId}:${input.detailId}`)) return { ok: false as const, error: { code: "GREENHOUSE_DETAIL_NOT_SELECTED" } };
    let response;
    try { response = await this.client.get({ url: apiUrl(source.boardToken, input.detailId), allowedDomains: [GREENHOUSE_API_HOST], accept: "application/json", maxRedirects: 0, retry: "none", signal: input.signal }); }
    catch (error) { return { ok: false as const, error: { code: failure(error) } }; }
    const http = statusFailure(response.status);
    if (http) return { ok: false as const, error: { code: http } };
    const raw = decode(response.body); const parsed = DetailSchema.safeParse(raw);
    if (!parsed.success || String(parsed.data.id) !== input.detailId) return { ok: false as const, error: { code: "GREENHOUSE_DETAIL_SCHEMA_INVALID" } };
    return { ok: true as const, data: { sourceId: source.sourceId, detailId: input.detailId, company: parsed.data.company_name, title: parsed.data.title, location: parsed.data.location.name, postedAt: parsed.data.first_published, deadline: parsed.data.application_deadline, sourceType: "company_careers" as const, isOfficial: true as const, rawPayload: raw as Record<string, unknown> } };
  }
}
