import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentRunExecutionSpecSchema } from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, LayeredPublicJobDiscoveryQuerySchema, SafeNormalizedPublicJobUrlSchema, type AnySearchProviderError } from "@job-copilot/contracts/job-discovery";

const LayeredPublicOperationKindSchema = z.enum(["search", "extract", "fetch", "record_pending", "gate_reject", "gate_verify"]);
const RunInputSchema = z.object({ userId: z.uuid(), runId: z.uuid(), now: z.date(), executionSpec: AgentRunExecutionSpecSchema, attemptCount: z.int().min(1).max(3), beforePhysicalOperation: z.function({ input: [z.object({ kind: LayeredPublicOperationKindSchema, identity: z.uuid() }).strict()], output: z.promise(z.void()) }), signal: z.instanceof(AbortSignal) }).strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
type LayeredSpec = Extract<z.infer<typeof AgentRunExecutionSpecSchema>, { workflowVersion: "layered-public-job-discovery-v1" }>;
type Query = z.infer<typeof LayeredPublicJobDiscoveryQuerySchema>;
type Candidate = { normalizedUrl: string; stableFingerprint: string };
export type IssuedCandidateCapability = {
  userId: string;
  runId: string;
  queryId: string;
  queryFingerprint: string;
  normalizedUrl: string;
  stableFingerprint: string;
  allowedSiteDomains: readonly string[];
};
export type RecoveredCandidateCapability = IssuedCandidateCapability & { leadId: string };
export type LayeredPublicPhysicalOperation = { kind: z.infer<typeof LayeredPublicOperationKindSchema>; identity: string };
export type LayeredPublicWorkflowDiagnostic =
  | { scope: "provider"; code: string; retryable: boolean; affectedCount: number }
  | { scope: "query"; queryId: string; kind: Query["kind"]; stableFingerprint: string; code: string; retryable: boolean; affectedCount: number }
  | { scope: "lead"; leadId: string; code: string; retryable: boolean; affectedCount: 1 };
export class LayeredPublicWorkflowInterruption extends Error {
  constructor(readonly outcome: "paused" | "cancelled" | "budget_exhausted" | "stale") { super("LAYERED_PUBLIC_WORKFLOW_INTERRUPTED"); }
}
export const LayeredPublicWorkflowBranchOutcomeSchema = z.object({
  trusted: z.enum(["succeeded", "failed"]),
  publicDiscovery: z.enum(["verified", "clean_zero", "candidate_failures", "failed"]),
}).strict();
export type LayeredPublicWorkflowOutcome = {
  branchOutcome: z.infer<typeof LayeredPublicWorkflowBranchOutcomeSchema>;
  sourcePostingVersionIds?: string[];
  trustedSourcePostingVersionIds?: string[];
  sourceIssues?: Array<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }>;
  diagnostics: LayeredPublicWorkflowDiagnostic[];
  interruption?: "paused" | "cancelled" | "budget_exhausted" | "stale";
};
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
  anySearch: { search(input: { runId: string; executionSpec: LayeredSpec; query: Query; signal: AbortSignal; beforeRequest(): Promise<void> }): Promise<{ candidates: Candidate[] } | { error: AnySearchProviderError }>; extract(input: { candidate: RecoveredCandidateCapability; signal: AbortSignal; beforeRequest(): Promise<void> }): Promise<{ normalizedUrl: string } | { error: AnySearchProviderError }> };
  preflight(input: { candidate: IssuedCandidateCapability }): Promise<{ normalizedUrl: string } | null>;
  leads: { recordPending(input: { targetId: string; candidate: IssuedCandidateCapability; now: Date }): Promise<{ leadId: string }> };
  fetcher: { fetch(input: { candidate: RecoveredCandidateCapability; signal: AbortSignal }): Promise<Page> };
  gate: { verify(input: { candidate: RecoveredCandidateCapability; candidateFingerprint: string; extract: { normalizedUrl: string }; page: Page; now: Date }): Promise<{ sourcePostingVersionId: string }>; reject(input: { candidate: RecoveredCandidateCapability; code: RejectionCode; now: Date }): Promise<void> };
}): LayeredPublicJobDiscoveryWorkflow {
  return { async run(input) {
    const value = RunInputSchema.parse(input);
    if (value.executionSpec.workflowVersion !== LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION || value.executionSpec.sourceScope.kind !== "layered_public") throw new Error("LAYERED_PUBLIC_WORKFLOW_SPEC_REQUIRED");
    const spec = value.executionSpec; const diagnostics: LayeredPublicWorkflowDiagnostic[] = []; const sourceIssues: Array<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }> = []; const sourcePostingVersionIds: string[] = []; const seen = new Set<string>(); let trusted: { succeeded: boolean; verifiedSourcePostingVersionIds: string[]; sourceIssues?: Array<{ code: string; affectedCount: number }> } = { succeeded: false, verifiedSourcePostingVersionIds: [] }; let verificationCandidates = 0; let publicSearchSucceeded = false; let publicCandidateCount = 0; let publicVerifiedCount = 0;
    const result = () => ({
      branchOutcome: {
        trusted: trusted.succeeded ? "succeeded" as const : "failed" as const,
        publicDiscovery: publicVerifiedCount > 0 ? "verified" as const : publicCandidateCount > 0 ? "candidate_failures" as const : publicSearchSucceeded ? "clean_zero" as const : "failed" as const,
      },
      sourcePostingVersionIds: [...new Set(sourcePostingVersionIds)], trustedSourcePostingVersionIds: trusted.verifiedSourcePostingVersionIds,
      sourceIssues: aggregateSourceIssues(sourceIssues), diagnostics: aggregateDiagnostics(diagnostics),
    });
    try {
    trusted = await deps.trustedSources.discover({ runId: value.runId, executionSpec: spec, signal: value.signal, beforeRequest: (watchlistItemId) => value.beforePhysicalOperation({ kind: "search", identity: watchlistItemId }) });
    sourcePostingVersionIds.push(...trusted.verifiedSourcePostingVersionIds);
    sourceIssues.push(...(trusted.sourceIssues?.map((issue) => ({ provider: "greenhouse" as const, ...issue })) ?? []));
    for (const query of spec.sourceScope.publicDiscovery.queries) {
      const searched = await deps.anySearch.search({ runId: value.runId, executionSpec: spec, query, signal: value.signal, beforeRequest: () => value.beforePhysicalOperation({ kind: "search", identity: query.queryId }) });
      if ("error" in searched) { diagnostics.push({ scope: "provider", code: searched.error.code, retryable: searched.error.retryable, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: searched.error.code, affectedCount: 1 }); continue; }
      publicSearchSucceeded = true;
      publicCandidateCount += searched.candidates.length;
      for (const candidate of searched.candidates.slice(0, query.resultLimit)) {
        if (!fingerprint.safeParse(candidate.stableFingerprint).success || seen.has(candidate.stableFingerprint)) continue;
        if (verificationCandidates >= spec.sourceScope.publicDiscovery.maxVerificationCandidates) continue;
        seen.add(candidate.stableFingerprint);
        const issued: IssuedCandidateCapability = { userId: value.userId, runId: value.runId, queryId: query.queryId, queryFingerprint: query.stableFingerprint, normalizedUrl: candidate.normalizedUrl, stableFingerprint: candidate.stableFingerprint, allowedSiteDomains: query.allowedSiteDomains };
        const safe = await deps.preflight({ candidate: issued });
        if (!safe || safe.normalizedUrl !== candidate.normalizedUrl || !SafeNormalizedPublicJobUrlSchema.safeParse(safe.normalizedUrl).success) { diagnostics.push({ scope: "query", queryId: query.queryId, kind: query.kind, stableFingerprint: query.stableFingerprint, code: "ANYSEARCH_POLICY_REJECTED", retryable: false, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: "ANYSEARCH_POLICY_REJECTED", affectedCount: 1 }); continue; }
        if (!matchesAllowedDomain(safe.normalizedUrl, query.allowedSiteDomains)) {
          await value.beforePhysicalOperation({ kind: "record_pending", identity: issued.queryId });
          const pending = await deps.leads.recordPending({ targetId: spec.targetSnapshot.targetId, candidate: issued, now: value.now });
          await value.beforePhysicalOperation({ kind: "gate_reject", identity: pending.leadId });
          await deps.gate.reject({ candidate: { ...issued, leadId: pending.leadId }, code: "POLICY_REJECTED", now: value.now });
          diagnostics.push({ scope: "query", queryId: query.queryId, kind: query.kind, stableFingerprint: query.stableFingerprint, code: "ANYSEARCH_POLICY_REJECTED", retryable: false, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: "ANYSEARCH_POLICY_REJECTED", affectedCount: 1 }); continue;
        }
        verificationCandidates += 1;
        await value.beforePhysicalOperation({ kind: "record_pending", identity: issued.queryId });
        const pending = await deps.leads.recordPending({ targetId: spec.targetSnapshot.targetId, candidate: issued, now: value.now });
        const recovered: RecoveredCandidateCapability = { ...issued, leadId: pending.leadId };
        try {
          const extract = await deps.anySearch.extract({ candidate: recovered, signal: value.signal, beforeRequest: () => value.beforePhysicalOperation({ kind: "extract", identity: pending.leadId }) });
          if ("error" in extract) { diagnostics.push({ scope: "lead", leadId: pending.leadId, code: extract.error.code, retryable: extract.error.retryable, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: extract.error.code, affectedCount: 1 }); continue; }
          if (extract.normalizedUrl !== safe.normalizedUrl) { await value.beforePhysicalOperation({ kind: "gate_reject", identity: pending.leadId }); await deps.gate.reject({ candidate: recovered, code: "JOB_PAGE_URL_INVALID", now: value.now }); continue; }
          await value.beforePhysicalOperation({ kind: "fetch", identity: pending.leadId }); const page = await deps.fetcher.fetch({ candidate: recovered, signal: value.signal });
          await value.beforePhysicalOperation({ kind: "gate_verify", identity: pending.leadId });
          const verified = await deps.gate.verify({ candidate: recovered, candidateFingerprint: candidateFingerprint(safe.normalizedUrl), extract, page, now: value.now }); sourcePostingVersionIds.push(verified.sourcePostingVersionId); publicVerifiedCount += 1;
        } catch (error) {
          const code = rejection(error);
          if (code) { await value.beforePhysicalOperation({ kind: "gate_reject", identity: pending.leadId }); await deps.gate.reject({ candidate: recovered, code, now: value.now }); diagnostics.push({ scope: "lead", leadId: pending.leadId, code, retryable: false, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code, affectedCount: 1 }); }
          else {
            const retryable = retryablePageCode(error);
            if (retryable) { diagnostics.push({ scope: "lead", leadId: pending.leadId, code: retryable, retryable: true, affectedCount: 1 }); sourceIssues.push({ provider: "anysearch", code: retryable, affectedCount: 1 }); }
            else throw error;
          }
        }
      }
    }
    return result();
    } catch (error) {
      if (error instanceof LayeredPublicWorkflowInterruption) return { ...result(), interruption: error.outcome };
      throw error;
    }
  } };
}
