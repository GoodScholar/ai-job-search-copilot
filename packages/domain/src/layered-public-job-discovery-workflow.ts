import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentRunExecutionSpecSchema } from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, LayeredPublicJobDiscoveryQuerySchema, SafeNormalizedPublicJobUrlSchema, type AnySearchProviderError } from "@job-copilot/contracts/job-discovery";

const RunInputSchema = z.object({ runId: z.uuid(), executionSpec: AgentRunExecutionSpecSchema, attemptCount: z.int().min(1).max(3), beforePhysicalOperation: z.function({ input: [z.object({ kind: z.enum(["search", "extract", "fetch"]), identity: z.uuid() }).strict()], output: z.promise(z.void()) }), signal: z.instanceof(AbortSignal) }).strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
type LayeredSpec = Extract<z.infer<typeof AgentRunExecutionSpecSchema>, { workflowVersion: "layered-public-job-discovery-v1" }>;
type Query = z.infer<typeof LayeredPublicJobDiscoveryQuerySchema>;
type Candidate = { normalizedUrl: string; stableFingerprint: string };
export type LayeredPublicPhysicalOperation = { kind: "search" | "extract" | "fetch"; identity: string };
export type LayeredPublicWorkflowDiagnostic =
  | { scope: "provider"; code: string; retryable: boolean; affectedCount: number }
  | { scope: "query"; queryId: string; kind: Query["kind"]; stableFingerprint: string; code: string; retryable: boolean; affectedCount: number }
  | { scope: "lead"; leadId: string; code: string; retryable: boolean; affectedCount: 1 };
export type LayeredPublicWorkflowOutcome = { hasTrustedSuccess: boolean; sourcePostingVersionIds?: string[]; trustedSourcePostingVersionIds?: string[]; sourceIssues?: Array<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }>; diagnostics: LayeredPublicWorkflowDiagnostic[] };
export interface LayeredPublicJobDiscoveryWorkflow { run(input: { runId: string; executionSpec: LayeredSpec; attemptCount: number; beforePhysicalOperation(operation: LayeredPublicPhysicalOperation): Promise<void>; signal: AbortSignal }): Promise<LayeredPublicWorkflowOutcome>; }
export interface LayeredPublicJobDiscoveryWorkflowResolver { resolve(input: { runId: string; idempotencyKey: string; executionSpec: LayeredSpec; attemptCount: number }): LayeredPublicJobDiscoveryWorkflow; }

type Page = { requestedUrl: string; finalUrl: string; canonicalUrl: string; rawHtml: string; visibleText: string; pageClassification: "job"; sourceKind: "official" | "aggregator" };
type RejectionCode = "JOB_PAGE_URL_INVALID" | "JOB_PAGE_TARGET_REJECTED" | "JOB_PAGE_REDIRECT_INVALID" | "JOB_PAGE_LOGIN_REQUIRED" | "JOB_PAGE_LISTING" | "JOB_PAGE_EXPIRED" | "JOB_PAGE_UNRECOGNIZED" | "JOB_PAGE_RESPONSE_TOO_LARGE" | "JOB_PAGE_CONTENT_TYPE_INVALID";
function candidateFingerprint(url: string) { return createHash("sha256").update(url).digest("hex"); }
function matchesAllowedDomain(url: string, domains: readonly string[]) { if (domains.length === 0) return true; const host = new URL(url).hostname; return domains.some((domain) => host === domain || host.endsWith(`.${domain}`)); }
function rejection(error: unknown): RejectionCode | null { const code = error instanceof Error ? error.message : ""; return ["JOB_PAGE_URL_INVALID", "JOB_PAGE_TARGET_REJECTED", "JOB_PAGE_REDIRECT_INVALID", "JOB_PAGE_LOGIN_REQUIRED", "JOB_PAGE_LISTING", "JOB_PAGE_EXPIRED", "JOB_PAGE_UNRECOGNIZED", "JOB_PAGE_RESPONSE_TOO_LARGE", "JOB_PAGE_CONTENT_TYPE_INVALID"].includes(code) ? code as RejectionCode : null; }

/** v4 安全链路；Slice 8 只组装 provider/config，不能改变 pending → extract → fetch → gate 的顺序。 */
export function createLayeredPublicJobDiscoveryWorkflow(deps: {
  trustedSources: { discover(input: { runId: string; executionSpec: LayeredSpec; signal: AbortSignal; beforeRequest(watchlistItemId: string): Promise<void> }): Promise<{ verifiedSourcePostingVersionIds: string[]; sourceIssues?: Array<{ code: string; affectedCount: number }> }> };
  anySearch: { search(input: { runId: string; executionSpec: LayeredSpec; query: Query; signal: AbortSignal; beforeRequest(): Promise<void> }): Promise<{ candidates: Candidate[] } | { error: AnySearchProviderError }>; extract(input: { normalizedUrl: string; signal: AbortSignal; beforeRequest(): Promise<void> }): Promise<{ normalizedUrl: string } | { error: AnySearchProviderError }> };
  preflight(input: { normalizedUrl: string; query: Query }): Promise<{ normalizedUrl: string } | null>;
  leads: { recordPending(input: { runId: string; targetId: string; query: Query; normalizedUrl: string; stableFingerprint: string }): Promise<{ leadId: string }> };
  fetcher: { fetch(input: { url: string; signal: AbortSignal }): Promise<Page> };
  gate: { verify(input: { leadId: string; queryId: string; normalizedUrl: string; candidateFingerprint: string; extract: { normalizedUrl: string }; page: Page }): Promise<{ sourcePostingVersionId: string }>; reject(input: { leadId: string; code: RejectionCode }): Promise<void> };
}): LayeredPublicJobDiscoveryWorkflow {
  return { async run(input) {
    const value = RunInputSchema.parse(input);
    if (value.executionSpec.workflowVersion !== LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION || value.executionSpec.sourceScope.kind !== "layered_public") throw new Error("LAYERED_PUBLIC_WORKFLOW_SPEC_REQUIRED");
    const spec = value.executionSpec; const trusted = await deps.trustedSources.discover({ runId: value.runId, executionSpec: spec, signal: value.signal, beforeRequest: (watchlistItemId) => value.beforePhysicalOperation({ kind: "search", identity: watchlistItemId }) });
    const sourcePostingVersionIds = [...trusted.verifiedSourcePostingVersionIds]; const diagnostics: LayeredPublicWorkflowDiagnostic[] = []; const sourceIssues: Array<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }> = trusted.sourceIssues?.map((issue) => ({ provider: "greenhouse" as const, ...issue })) ?? []; const seen = new Set<string>();
    for (const query of spec.sourceScope.publicDiscovery.queries) {
      const searched = await deps.anySearch.search({ runId: value.runId, executionSpec: spec, query, signal: value.signal, beforeRequest: () => value.beforePhysicalOperation({ kind: "search", identity: query.queryId }) });
      if ("error" in searched) { diagnostics.push({ scope: "provider", code: searched.error.code, retryable: searched.error.retryable, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: searched.error.code, affectedCount: 1 }); continue; }
      for (const candidate of searched.candidates.slice(0, query.resultLimit)) {
        if (!fingerprint.safeParse(candidate.stableFingerprint).success || seen.has(candidate.stableFingerprint)) continue;
        seen.add(candidate.stableFingerprint); const safe = await deps.preflight({ normalizedUrl: candidate.normalizedUrl, query });
        if (!safe || !matchesAllowedDomain(safe.normalizedUrl, query.allowedSiteDomains) || !SafeNormalizedPublicJobUrlSchema.safeParse(safe.normalizedUrl).success) continue;
        const pending = await deps.leads.recordPending({ runId: value.runId, targetId: spec.targetSnapshot.targetId, query, normalizedUrl: safe.normalizedUrl, stableFingerprint: candidate.stableFingerprint });
        try {
          const extract = await deps.anySearch.extract({ normalizedUrl: safe.normalizedUrl, signal: value.signal, beforeRequest: () => value.beforePhysicalOperation({ kind: "extract", identity: pending.leadId }) });
          if ("error" in extract) { diagnostics.push({ scope: "lead", leadId: pending.leadId, code: extract.error.code, retryable: extract.error.retryable, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: extract.error.code, affectedCount: 1 }); continue; }
          if (extract.normalizedUrl !== safe.normalizedUrl) { await deps.gate.reject({ leadId: pending.leadId, code: "JOB_PAGE_URL_INVALID" }); continue; }
          await value.beforePhysicalOperation({ kind: "fetch", identity: pending.leadId }); const page = await deps.fetcher.fetch({ url: safe.normalizedUrl, signal: value.signal });
          const verified = await deps.gate.verify({ leadId: pending.leadId, queryId: query.queryId, normalizedUrl: safe.normalizedUrl, candidateFingerprint: candidateFingerprint(safe.normalizedUrl), extract, page }); sourcePostingVersionIds.push(verified.sourcePostingVersionId);
        } catch (error) {
          const code = rejection(error);
          if (code) { await deps.gate.reject({ leadId: pending.leadId, code }); diagnostics.push({ scope: "lead", leadId: pending.leadId, code, retryable: false, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code, affectedCount: 1 }); }
          else { diagnostics.push({ scope: "lead", leadId: pending.leadId, code: "JOB_PAGE_UNREACHABLE", retryable: true, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: "JOB_PAGE_UNREACHABLE", affectedCount: 1 }); }
        }
      }
    }
    return { hasTrustedSuccess: sourcePostingVersionIds.length > 0, sourcePostingVersionIds: [...new Set(sourcePostingVersionIds)], trustedSourcePostingVersionIds: trusted.verifiedSourcePostingVersionIds, sourceIssues, diagnostics };
  } };
}
