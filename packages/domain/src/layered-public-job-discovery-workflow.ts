import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentRunExecutionSpecSchema } from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, LayeredPublicJobDiscoveryQuerySchema, SafeNormalizedPublicJobUrlSchema, type AnySearchProviderError } from "@job-copilot/contracts/job-discovery";

const RunInputSchema = z.object({ userId: z.uuid(), runId: z.uuid(), now: z.date(), executionSpec: AgentRunExecutionSpecSchema, attemptCount: z.int().min(1).max(3), beforePhysicalOperation: z.function({ input: [z.object({ kind: z.enum(["search", "extract", "fetch"]), identity: z.uuid() }).strict()], output: z.promise(z.void()) }), signal: z.instanceof(AbortSignal) }).strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
type LayeredSpec = Extract<z.infer<typeof AgentRunExecutionSpecSchema>, { workflowVersion: "layered-public-job-discovery-v1" }>;
type Query = z.infer<typeof LayeredPublicJobDiscoveryQuerySchema>;
type Candidate = { normalizedUrl: string; stableFingerprint: string };
export type LayeredPublicPhysicalOperation = { kind: "search" | "extract" | "fetch"; identity: string };
export type LayeredPublicWorkflowDiagnostic =
  | { scope: "provider"; code: string; retryable: boolean; affectedCount: number }
  | { scope: "query"; queryId: string; kind: Query["kind"]; stableFingerprint: string; code: string; retryable: boolean; affectedCount: number }
  | { scope: "lead"; leadId: string; code: string; retryable: boolean; affectedCount: 1 };
export type LayeredPublicWorkflowOutcome = { hasTrustedSuccess: boolean; branchSuccess?: { trusted: boolean; publicDiscovery: boolean }; sourcePostingVersionIds?: string[]; trustedSourcePostingVersionIds?: string[]; sourceIssues?: Array<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }>; diagnostics: LayeredPublicWorkflowDiagnostic[] };
export interface LayeredPublicJobDiscoveryWorkflow { run(input: { userId: string; runId: string; now: Date; executionSpec: LayeredSpec; attemptCount: number; beforePhysicalOperation(operation: LayeredPublicPhysicalOperation): Promise<void>; signal: AbortSignal }): Promise<LayeredPublicWorkflowOutcome>; }
export interface LayeredPublicJobDiscoveryWorkflowResolver { resolve(input: { runId: string; idempotencyKey: string; executionSpec: LayeredSpec; attemptCount: number }): LayeredPublicJobDiscoveryWorkflow; }

type Page = { requestedUrl: string; finalUrl: string; canonicalUrl: string; rawHtml: string; visibleText: string; pageClassification: "job"; sourceKind: "official" | "aggregator" };
type RejectionCode = "JOB_PAGE_URL_INVALID" | "JOB_PAGE_TARGET_REJECTED" | "JOB_PAGE_REDIRECT_INVALID" | "JOB_PAGE_LOGIN_REQUIRED" | "JOB_PAGE_LISTING" | "JOB_PAGE_EXPIRED" | "JOB_PAGE_UNRECOGNIZED" | "JOB_PAGE_RESPONSE_TOO_LARGE" | "JOB_PAGE_CONTENT_TYPE_INVALID" | "POLICY_REJECTED";
function candidateFingerprint(url: string) { return createHash("sha256").update(url).digest("hex"); }
function matchesAllowedDomain(url: string, domains: readonly string[]) { if (domains.length === 0) return true; const host = new URL(url).hostname; return domains.some((domain) => host === domain || host.endsWith(`.${domain}`)); }
function rejection(error: unknown): RejectionCode | null { const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""; return ["JOB_PAGE_URL_INVALID", "JOB_PAGE_TARGET_REJECTED", "JOB_PAGE_REDIRECT_INVALID", "JOB_PAGE_LOGIN_REQUIRED", "JOB_PAGE_LISTING", "JOB_PAGE_EXPIRED", "JOB_PAGE_UNRECOGNIZED", "JOB_PAGE_RESPONSE_TOO_LARGE", "JOB_PAGE_CONTENT_TYPE_INVALID"].includes(code) ? code as RejectionCode : null; }
function retryablePageCode(error: unknown): "JOB_PAGE_TIMEOUT" | "JOB_PAGE_CANCELLED" | "JOB_PAGE_UNREACHABLE" | "JOB_PAGE_RATE_LIMITED" | null { const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : ""; return ["JOB_PAGE_TIMEOUT", "JOB_PAGE_CANCELLED", "JOB_PAGE_UNREACHABLE", "JOB_PAGE_RATE_LIMITED"].includes(code) ? code as "JOB_PAGE_TIMEOUT" | "JOB_PAGE_CANCELLED" | "JOB_PAGE_UNREACHABLE" | "JOB_PAGE_RATE_LIMITED" : null; }
function aggregateSourceIssues(items: Array<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }>) {
  const grouped = new Map<string, { provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }>();
  for (const item of items) { const key = `${item.provider}\u001f${item.code}`; const previous = grouped.get(key); grouped.set(key, { ...item, affectedCount: Math.min(10, (previous?.affectedCount ?? 0) + item.affectedCount) }); }
  return [...grouped.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.code.localeCompare(right.code));
}
function aggregateDiagnostics(items: LayeredPublicWorkflowDiagnostic[]) {
  const grouped = new Map<string, LayeredPublicWorkflowDiagnostic>();
  for (const item of items) { const key = item.scope === "provider" ? `p\u001f${item.code}` : item.scope === "query" ? `q\u001f${item.queryId}\u001f${item.code}` : `l\u001f${item.leadId}\u001f${item.code}`; const previous = grouped.get(key); grouped.set(key, { ...item, affectedCount: Math.min(10, (previous?.affectedCount ?? 0) + item.affectedCount) } as LayeredPublicWorkflowDiagnostic); }
  return [...grouped.values()].sort((left, right) => `${left.scope}\u001f${left.code}`.localeCompare(`${right.scope}\u001f${right.code}`));
}

/** v4 安全链路；Slice 8 只组装 provider/config，不能改变 pending → extract → fetch → gate 的顺序。 */
export function createLayeredPublicJobDiscoveryWorkflow(deps: {
  trustedSources: { discover(input: { runId: string; executionSpec: LayeredSpec; signal: AbortSignal; beforeRequest(watchlistItemId: string): Promise<void> }): Promise<{ succeeded: boolean; verifiedSourcePostingVersionIds: string[]; sourceIssues?: Array<{ code: string; affectedCount: number }> }> };
  anySearch: { search(input: { runId: string; executionSpec: LayeredSpec; query: Query; signal: AbortSignal; beforeRequest(): Promise<void> }): Promise<{ candidates: Candidate[] } | { error: AnySearchProviderError }>; extract(input: { normalizedUrl: string; signal: AbortSignal; beforeRequest(): Promise<void> }): Promise<{ normalizedUrl: string } | { error: AnySearchProviderError }> };
  preflight(input: { normalizedUrl: string; query: Query }): Promise<{ normalizedUrl: string } | null>;
  leads: { recordPending(input: { userId: string; runId: string; targetId: string; query: Query; normalizedUrl: string; stableFingerprint: string; now: Date }): Promise<{ leadId: string }> };
  fetcher: { fetch(input: { url: string; signal: AbortSignal }): Promise<Page> };
  gate: { verify(input: { userId: string; leadId: string; queryId: string; normalizedUrl: string; candidateFingerprint: string; extract: { normalizedUrl: string }; page: Page; now: Date }): Promise<{ sourcePostingVersionId: string }>; reject(input: { userId: string; leadId: string; code: RejectionCode; now: Date }): Promise<void> };
}): LayeredPublicJobDiscoveryWorkflow {
  return { async run(input) {
    const value = RunInputSchema.parse(input);
    if (value.executionSpec.workflowVersion !== LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION || value.executionSpec.sourceScope.kind !== "layered_public") throw new Error("LAYERED_PUBLIC_WORKFLOW_SPEC_REQUIRED");
    const spec = value.executionSpec; const trusted = await deps.trustedSources.discover({ runId: value.runId, executionSpec: spec, signal: value.signal, beforeRequest: (watchlistItemId) => value.beforePhysicalOperation({ kind: "search", identity: watchlistItemId }) });
    const sourcePostingVersionIds = [...trusted.verifiedSourcePostingVersionIds]; const diagnostics: LayeredPublicWorkflowDiagnostic[] = []; const sourceIssues: Array<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }> = trusted.sourceIssues?.map((issue) => ({ provider: "greenhouse" as const, ...issue })) ?? []; const seen = new Set<string>(); let verificationCandidates = 0; let publicDiscoverySucceeded = false;
    for (const query of spec.sourceScope.publicDiscovery.queries) {
      const searched = await deps.anySearch.search({ runId: value.runId, executionSpec: spec, query, signal: value.signal, beforeRequest: () => value.beforePhysicalOperation({ kind: "search", identity: query.queryId }) });
      if ("error" in searched) { diagnostics.push({ scope: "provider", code: searched.error.code, retryable: searched.error.retryable, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: searched.error.code, affectedCount: 1 }); continue; }
      publicDiscoverySucceeded = true;
      for (const candidate of searched.candidates.slice(0, query.resultLimit)) {
        if (!fingerprint.safeParse(candidate.stableFingerprint).success || seen.has(candidate.stableFingerprint)) continue;
        seen.add(candidate.stableFingerprint); const safe = await deps.preflight({ normalizedUrl: candidate.normalizedUrl, query });
        if (!safe || safe.normalizedUrl !== candidate.normalizedUrl || !SafeNormalizedPublicJobUrlSchema.safeParse(safe.normalizedUrl).success) { diagnostics.push({ scope: "query", queryId: query.queryId, kind: query.kind, stableFingerprint: query.stableFingerprint, code: "ANYSEARCH_POLICY_REJECTED", retryable: false, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: "ANYSEARCH_POLICY_REJECTED", affectedCount: 1 }); continue; }
        if (!matchesAllowedDomain(safe.normalizedUrl, query.allowedSiteDomains)) {
          const pending = await deps.leads.recordPending({ userId: value.userId, runId: value.runId, targetId: spec.targetSnapshot.targetId, query, normalizedUrl: safe.normalizedUrl, stableFingerprint: candidate.stableFingerprint, now: value.now });
          await deps.gate.reject({ userId: value.userId, leadId: pending.leadId, code: "POLICY_REJECTED", now: value.now });
          diagnostics.push({ scope: "query", queryId: query.queryId, kind: query.kind, stableFingerprint: query.stableFingerprint, code: "ANYSEARCH_POLICY_REJECTED", retryable: false, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: "ANYSEARCH_POLICY_REJECTED", affectedCount: 1 }); continue;
        }
        if (++verificationCandidates > spec.sourceScope.publicDiscovery.maxVerificationCandidates) break;
        const pending = await deps.leads.recordPending({ userId: value.userId, runId: value.runId, targetId: spec.targetSnapshot.targetId, query, normalizedUrl: safe.normalizedUrl, stableFingerprint: candidate.stableFingerprint, now: value.now });
        try {
          const extract = await deps.anySearch.extract({ normalizedUrl: safe.normalizedUrl, signal: value.signal, beforeRequest: () => value.beforePhysicalOperation({ kind: "extract", identity: pending.leadId }) });
          if ("error" in extract) { diagnostics.push({ scope: "lead", leadId: pending.leadId, code: extract.error.code, retryable: extract.error.retryable, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: extract.error.code, affectedCount: 1 }); continue; }
          if (extract.normalizedUrl !== safe.normalizedUrl) { await deps.gate.reject({ userId: value.userId, leadId: pending.leadId, code: "JOB_PAGE_URL_INVALID", now: value.now }); continue; }
          await value.beforePhysicalOperation({ kind: "fetch", identity: pending.leadId }); const page = await deps.fetcher.fetch({ url: safe.normalizedUrl, signal: value.signal });
          const verified = await deps.gate.verify({ userId: value.userId, leadId: pending.leadId, queryId: query.queryId, normalizedUrl: safe.normalizedUrl, candidateFingerprint: candidateFingerprint(safe.normalizedUrl), extract, page, now: value.now }); sourcePostingVersionIds.push(verified.sourcePostingVersionId);
        } catch (error) {
          const code = rejection(error);
          if (code) { await deps.gate.reject({ userId: value.userId, leadId: pending.leadId, code, now: value.now }); diagnostics.push({ scope: "lead", leadId: pending.leadId, code, retryable: false, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code, affectedCount: 1 }); }
          else {
            const retryable = retryablePageCode(error);
            if (retryable) { diagnostics.push({ scope: "lead", leadId: pending.leadId, code: retryable, retryable: true, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: retryable, affectedCount: 1 }); }
            else throw error;
          }
        }
      }
    }
    return { hasTrustedSuccess: trusted.succeeded, branchSuccess: { trusted: trusted.succeeded, publicDiscovery: publicDiscoverySucceeded }, sourcePostingVersionIds: [...new Set(sourcePostingVersionIds)], trustedSourcePostingVersionIds: trusted.verifiedSourcePostingVersionIds, sourceIssues: aggregateSourceIssues(sourceIssues), diagnostics: aggregateDiagnostics(diagnostics) };
  } };
}
