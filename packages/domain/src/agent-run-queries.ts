import { and, asc, desc, eq } from "drizzle-orm";
import {
  agentRunEvents, agentRunJobResults, agentRunSteps, agentRuns, jobDiscoveryDiagnostics, jobDiscoveryRunResults, jobDiscoverySourceIssues, jobSourceHealthChecks, jobOpportunities, jobSourcePostings, jobSourcePostingVersions,
  type Database,
} from "@job-copilot/database";
import { AgentRunDetailSchema, AgentRunExecutionSpecSchema, StartAgentRunResponseSchema, type AgentRunDetail, type StartAgentRunResponse } from "@job-copilot/contracts/agent-runs";
import { RunPreflightSnapshotSchema } from "@job-copilot/contracts/run-preflight";
import { mismatchedSourceCapabilityDeclaration, unsupportedSourceCapability } from "@job-copilot/contracts/source-capabilities";
import { normalizeAgentRunSourceScope, projectPublicAgentRunSourceScope } from "./agent-run-source-scope";

type RunRow = typeof agentRuns.$inferSelect;

function sourceIssueSummary(issue: { provider: string; code: string; affectedCount: number }) {
  if (issue.code === "SOURCE_CAPABILITY_UNSUPPORTED" || issue.code === "SOURCE_CAPABILITY_DECLARATION_MISMATCH") {
    const failure = issue.code === "SOURCE_CAPABILITY_UNSUPPORTED" ? unsupportedSourceCapability() : mismatchedSourceCapabilityDeclaration();
    return { provider: "greenhouse" as const, code: failure.reasonCode, affectedCount: issue.affectedCount, impact: failure.impact, retryable: failure.retryable, suggestedActions: failure.suggestedActions };
  }
  return { provider: issue.provider as "anysearch" | "greenhouse", code: issue.code, affectedCount: issue.affectedCount };
}

function summary(row: RunRow): StartAgentRunResponse {
  const sourceScope = row.workflowVersion === "layered-public-job-discovery-v1"
    ? AgentRunExecutionSpecSchema.parse({ targetSnapshot: row.targetSnapshot, profileSnapshot: row.profileSnapshot, watchlistSnapshot: row.watchlistSnapshot, sourceScope: row.sourceScope, workflowVersion: row.workflowVersion, ruleVersion: row.ruleVersion, adapter: row.adapter, adapterVersion: row.adapterVersion, outputSchemaVersion: row.outputSchemaVersion, toolAllowlist: row.toolAllowlist, model: row.modelSnapshot, budget: row.budgetSnapshot }).sourceScope
    : projectPublicAgentRunSourceScope(row.sourceScope);
  return StartAgentRunResponseSchema.parse({
    runId: row.id, targetId: row.targetId, targetVersion: row.targetVersion,
    accountPolicyRevisionNumber: row.accountPolicyRevisionNumber,
    preflightSnapshot: row.preflightSnapshot === null ? null : RunPreflightSnapshotSchema.parse(row.preflightSnapshot),
    targetSnapshot: row.targetSnapshot, sourceScope,
    workflowVersion: row.workflowVersion, adapter: row.adapter,
    adapterVersion: row.adapterVersion, outputSchemaVersion: row.outputSchemaVersion,
    budget: row.budgetSnapshot, status: row.status, currentStep: row.currentStep,
    version: row.version, attemptCount: row.attemptCount, failureCode: row.failureCode,
    queuedAt: row.queuedAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(), reused: false,
  });
}

async function detail(db: Database, userId: string, runId: string): Promise<AgentRunDetail | null> {
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, runId)));
  if (!run) return null;
  const [steps, events, results, sourceChecks, discoveryDiagnostics, discoveryIssues, discoveryResults] = await Promise.all([
    db.select().from(agentRunSteps).where(and(eq(agentRunSteps.userId, userId), eq(agentRunSteps.runId, runId))).orderBy(asc(agentRunSteps.ordinal)),
    db.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, runId))).orderBy(asc(agentRunEvents.sequence)),
    db.select({ resultId: agentRunJobResults.id, ordinal: agentRunJobResults.ordinal, opportunityId: agentRunJobResults.opportunityId, sourcePostingId: jobSourcePostings.id, sourcePostingVersionId: agentRunJobResults.sourcePostingVersionId, normalizedData: jobSourcePostingVersions.normalizedData, sourceType: jobSourcePostings.sourceType, isOfficial: jobSourcePostings.isOfficial })
      .from(agentRunJobResults).innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, agentRunJobResults.userId), eq(jobSourcePostingVersions.id, agentRunJobResults.sourcePostingVersionId))).innerJoin(jobSourcePostings, and(eq(jobSourcePostings.userId, jobSourcePostingVersions.userId), eq(jobSourcePostings.id, jobSourcePostingVersions.sourcePostingId)))
      .where(and(eq(agentRunJobResults.userId, userId), eq(agentRunJobResults.runId, runId))).orderBy(asc(agentRunJobResults.ordinal)),
    db.select().from(jobSourceHealthChecks).where(and(eq(jobSourceHealthChecks.userId, userId), eq(jobSourceHealthChecks.runId, runId))).orderBy(asc(jobSourceHealthChecks.checkedAt), asc(jobSourceHealthChecks.id)),
    db.select().from(jobDiscoveryDiagnostics).where(and(eq(jobDiscoveryDiagnostics.userId, userId), eq(jobDiscoveryDiagnostics.runId, runId))).orderBy(asc(jobDiscoveryDiagnostics.createdAt), asc(jobDiscoveryDiagnostics.id)),
    db.select().from(jobDiscoverySourceIssues).where(and(eq(jobDiscoverySourceIssues.userId, userId), eq(jobDiscoverySourceIssues.runId, runId))).orderBy(asc(jobDiscoverySourceIssues.provider), asc(jobDiscoverySourceIssues.code)),
    db.select({ resultId: jobDiscoveryRunResults.id, ordinal: jobDiscoveryRunResults.ordinal, sourcePostingVersionId: jobDiscoveryRunResults.sourcePostingVersionId, sourceType: jobSourcePostings.sourceType, isOfficial: jobSourcePostings.isOfficial })
      .from(jobDiscoveryRunResults).innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, jobDiscoveryRunResults.userId), eq(jobSourcePostingVersions.id, jobDiscoveryRunResults.sourcePostingVersionId))).innerJoin(jobSourcePostings, and(eq(jobSourcePostings.userId, jobSourcePostingVersions.userId), eq(jobSourcePostings.id, jobSourcePostingVersions.sourcePostingId)))
      .where(and(eq(jobDiscoveryRunResults.userId, userId), eq(jobDiscoveryRunResults.runId, runId))).orderBy(asc(jobDiscoveryRunResults.ordinal)),
  ]);
  const usage = { activeDurationMs: run.activeDurationMs, attempts: run.attemptCount, toolCalls: run.toolCallCount, sourceRequests: run.sourceRequestCount, modelCalls: run.modelCallCount, inputTokens: run.inputTokenCount, outputTokens: run.outputTokenCount, totalTokens: run.totalTokenCount, results: run.resultCount, complete: run.usageComplete };
  const termination = run.terminationKind === null ? null : { kind: run.terminationKind, failureCode: run.failureCode, budgetDimension: run.terminationBudgetDimension };
  const sourceScope = run.workflowVersion === "layered-public-job-discovery-v1"
    ? AgentRunExecutionSpecSchema.parse({ targetSnapshot: run.targetSnapshot, profileSnapshot: run.profileSnapshot, watchlistSnapshot: run.watchlistSnapshot, sourceScope: run.sourceScope, workflowVersion: run.workflowVersion, ruleVersion: run.ruleVersion, adapter: run.adapter, adapterVersion: run.adapterVersion, outputSchemaVersion: run.outputSchemaVersion, toolAllowlist: run.toolAllowlist, model: run.modelSnapshot, budget: run.budgetSnapshot }).sourceScope
    : projectPublicAgentRunSourceScope(run.sourceScope);
  const { reused: _reused, ...runSummary } = summary(run);
  const base = { ...runSummary, executionSpec: { targetSnapshot: run.targetSnapshot, sourceScope, workflowVersion: run.workflowVersion, ruleVersion: run.ruleVersion, adapter: run.adapter, adapterVersion: run.adapterVersion, outputSchemaVersion: run.outputSchemaVersion, toolAllowlist: run.toolAllowlist, model: run.modelSnapshot, budget: run.budgetSnapshot }, controlState: run.controlState, usage, termination, retryOfRunId: run.retryOfRunId, steps: steps.map((step) => ({ stepKey: step.stepKey, ordinal: step.ordinal, status: step.status, attemptCount: step.attemptCount, startedAt: step.startedAt?.toISOString() ?? null, completedAt: step.completedAt?.toISOString() ?? null, failedAt: step.failedAt?.toISOString() ?? null, failureCode: step.failureCode })), events: events.map((event) => ({ sequence: event.sequence, runVersion: event.runVersion, eventType: event.eventType, data: event.data, createdAt: event.createdAt.toISOString() })), results: results.map(({ normalizedData, ...result }) => {
    const snapshot = normalizedData as { company?: string | null; title?: string | null; location?: string | null; postedAt?: string | null; deadline?: string | null };
    return { ...result, company: snapshot.company ?? null, title: snapshot.title ?? null, location: snapshot.location ?? null, postedAt: snapshot.postedAt ?? null, deadline: snapshot.deadline ?? null };
  }) };
  if (run.workflowVersion === "layered-public-job-discovery-v1") return AgentRunDetailSchema.parse({
    ...base,
    executionSpec: { ...base.executionSpec, profileSnapshot: run.profileSnapshot, watchlistSnapshot: run.watchlistSnapshot },
    results: discoveryResults.map(({ ordinal: _ordinal, ...result }) => ({ ...result, sourceType: result.sourceType as "company_careers" | "recruitment_platform" | "wechat_recruitment_h5" | "public_web" })),
    discoveryDiagnostics: discoveryDiagnostics.map((diagnostic) => diagnostic.scope === "provider" ? { scope: "provider", diagnosticId: diagnostic.id, runId: diagnostic.runId, provider: "anysearch", code: diagnostic.code, retryable: diagnostic.retryable, affectedCount: diagnostic.affectedCount } : diagnostic.scope === "query" ? { scope: "query", diagnosticId: diagnostic.id, runId: diagnostic.runId, queryId: diagnostic.queryId!, kind: diagnostic.queryKind!, stableFingerprint: diagnostic.queryFingerprint!, code: diagnostic.code, retryable: diagnostic.retryable, affectedCount: diagnostic.affectedCount } : { scope: "lead", diagnosticId: diagnostic.id, runId: diagnostic.runId, leadId: diagnostic.leadId!, code: diagnostic.code, retryable: diagnostic.retryable, affectedCount: diagnostic.affectedCount }),
    sourceIssues: discoveryIssues.map(sourceIssueSummary),
  });
  return AgentRunDetailSchema.parse({ ...base, ...(run.workflowVersion === "job-discovery-workflow-v3" ? { sourceChecks: sourceChecks.map((check) => ({ checkId: check.id, runId: check.runId, targetId: check.targetId, watchlistItemId: check.watchlistItemId, sourceId: check.sourceId, status: check.status, reasonCodes: check.reasonCodes, impact: { scope: check.impactScope, affectedCount: check.impactAffectedCount }, observedPostingCount: check.observedPostingCount, selectedDetailCount: check.selectedDetailCount, validDetailCount: check.validDetailCount, requestAttemptCount: check.requestAttemptCount, checkedAt: check.checkedAt.toISOString() })), sourceIssues: discoveryIssues.map(sourceIssueSummary) } : {}) });
}

export function createAgentRunQueries(deps: { db: Database }): {
  latest(input: { userId: string }): Promise<{ run: AgentRunDetail | null }>;
  get(input: { userId: string; runId: string }): Promise<AgentRunDetail | null>;
  eventsAfter(input: { userId: string; runId: string; afterSequence: number }): Promise<AgentRunDetail["events"] | null>;
} {
  return {
    async latest({ userId }) { const [run] = await deps.db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.userId, userId)).orderBy(desc(agentRuns.queuedAt), desc(agentRuns.id)).limit(1); return { run: run ? await detail(deps.db, userId, run.id) : null }; },
    get: ({ userId, runId }) => detail(deps.db, userId, runId),
    async eventsAfter({ userId, runId, afterSequence }) { const run = await detail(deps.db, userId, runId); return run ? run.events.filter((event) => event.sequence > afterSequence) : null; },
  };
}
