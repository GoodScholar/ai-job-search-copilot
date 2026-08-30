import { and, asc, desc, eq } from "drizzle-orm";
import {
  agentRunEvents, agentRunJobResults, agentRunSteps, agentRuns, jobOpportunities, jobSourcePostings, jobSourcePostingVersions,
  type Database,
} from "@job-copilot/database";
import { AgentRunDetailSchema, StartAgentRunResponseSchema, type AgentRunDetail, type StartAgentRunResponse } from "@job-copilot/contracts/agent-runs";
import { normalizeAgentRunSourceScope } from "./agent-run-source-scope";

type RunRow = typeof agentRuns.$inferSelect;

function summary(row: RunRow): StartAgentRunResponse {
  const sourceScope = normalizeAgentRunSourceScope(row.sourceScope);
  return StartAgentRunResponseSchema.parse({
    runId: row.id, targetId: row.targetId, targetVersion: row.targetVersion,
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
  const [steps, events, results] = await Promise.all([
    db.select().from(agentRunSteps).where(and(eq(agentRunSteps.userId, userId), eq(agentRunSteps.runId, runId))).orderBy(asc(agentRunSteps.ordinal)),
    db.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, runId))).orderBy(asc(agentRunEvents.sequence)),
    db.select({ resultId: agentRunJobResults.id, ordinal: agentRunJobResults.ordinal, opportunityId: agentRunJobResults.opportunityId, sourcePostingId: jobSourcePostings.id, sourcePostingVersionId: agentRunJobResults.sourcePostingVersionId, normalizedData: jobSourcePostingVersions.normalizedData, sourceType: jobSourcePostings.sourceType, isOfficial: jobSourcePostings.isOfficial })
      .from(agentRunJobResults).innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, agentRunJobResults.userId), eq(jobSourcePostingVersions.id, agentRunJobResults.sourcePostingVersionId))).innerJoin(jobSourcePostings, and(eq(jobSourcePostings.userId, jobSourcePostingVersions.userId), eq(jobSourcePostings.id, jobSourcePostingVersions.sourcePostingId)))
      .where(and(eq(agentRunJobResults.userId, userId), eq(agentRunJobResults.runId, runId))).orderBy(asc(agentRunJobResults.ordinal)),
  ]);
  const usage = { activeDurationMs: run.activeDurationMs, attempts: run.attemptCount, toolCalls: run.toolCallCount, sourceRequests: run.sourceRequestCount, modelCalls: run.modelCallCount, inputTokens: run.inputTokenCount, outputTokens: run.outputTokenCount, totalTokens: run.totalTokenCount, results: run.resultCount, complete: run.usageComplete };
  const termination = run.terminationKind === null ? null : { kind: run.terminationKind, failureCode: run.failureCode, budgetDimension: run.terminationBudgetDimension };
  const sourceScope = normalizeAgentRunSourceScope(run.sourceScope);
  const { reused: _reused, ...runSummary } = summary(run);
  return AgentRunDetailSchema.parse({ ...runSummary, executionSpec: { targetSnapshot: run.targetSnapshot, sourceScope, workflowVersion: run.workflowVersion, ruleVersion: run.ruleVersion, adapter: run.adapter, adapterVersion: run.adapterVersion, outputSchemaVersion: run.outputSchemaVersion, toolAllowlist: run.toolAllowlist, model: run.modelSnapshot, budget: run.budgetSnapshot }, controlState: run.controlState, usage, termination, retryOfRunId: run.retryOfRunId, steps: steps.map((step) => ({ stepKey: step.stepKey, ordinal: step.ordinal, status: step.status, attemptCount: step.attemptCount, startedAt: step.startedAt?.toISOString() ?? null, completedAt: step.completedAt?.toISOString() ?? null, failedAt: step.failedAt?.toISOString() ?? null, failureCode: step.failureCode })), events: events.map((event) => ({ sequence: event.sequence, runVersion: event.runVersion, eventType: event.eventType, data: event.data, createdAt: event.createdAt.toISOString() })), results: results.map(({ normalizedData, ...result }) => {
    const snapshot = normalizedData as { company?: string | null; title?: string | null; location?: string | null; postedAt?: string | null; deadline?: string | null };
    return { ...result, company: snapshot.company ?? null, title: snapshot.title ?? null, location: snapshot.location ?? null, postedAt: snapshot.postedAt ?? null, deadline: snapshot.deadline ?? null };
  }) });
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
