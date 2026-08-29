import { and, asc, desc, eq } from "drizzle-orm";
import {
  agentRunEvents, agentRunJobResults, agentRunSteps, agentRuns, jobOpportunities, jobSourcePostings, jobSourcePostingVersions,
  type Database,
} from "@job-copilot/database";
import type { AgentRunDetail, StartAgentRunResponse } from "@job-copilot/contracts/agent-runs";

type RunRow = typeof agentRuns.$inferSelect;

function summary(row: RunRow): StartAgentRunResponse {
  return {
    runId: row.id, targetId: row.targetId, targetVersion: row.targetVersion,
    targetSnapshot: row.targetSnapshot as StartAgentRunResponse["targetSnapshot"], sourceScope: row.sourceScope as StartAgentRunResponse["sourceScope"],
    workflowVersion: row.workflowVersion as StartAgentRunResponse["workflowVersion"], adapter: row.adapter as StartAgentRunResponse["adapter"],
    adapterVersion: row.adapterVersion as StartAgentRunResponse["adapterVersion"], outputSchemaVersion: row.outputSchemaVersion as StartAgentRunResponse["outputSchemaVersion"],
    budget: row.budgetSnapshot as StartAgentRunResponse["budget"], status: row.status as StartAgentRunResponse["status"], currentStep: row.currentStep as StartAgentRunResponse["currentStep"],
    version: row.version, attemptCount: row.attemptCount, failureCode: row.failureCode as StartAgentRunResponse["failureCode"],
    queuedAt: row.queuedAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(), reused: false,
  };
}

async function detail(db: Database, userId: string, runId: string): Promise<AgentRunDetail | null> {
  const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, runId)));
  if (!run) return null;
  const [steps, events, results] = await Promise.all([
    db.select().from(agentRunSteps).where(and(eq(agentRunSteps.userId, userId), eq(agentRunSteps.runId, runId))).orderBy(asc(agentRunSteps.ordinal)),
    db.select().from(agentRunEvents).where(and(eq(agentRunEvents.userId, userId), eq(agentRunEvents.runId, runId))).orderBy(asc(agentRunEvents.sequence)),
    db.select({ resultId: agentRunJobResults.id, ordinal: agentRunJobResults.ordinal, opportunityId: agentRunJobResults.opportunityId, sourcePostingId: jobSourcePostings.id, sourcePostingVersionId: agentRunJobResults.sourcePostingVersionId, company: jobOpportunities.company, title: jobOpportunities.title, location: jobOpportunities.location, postedAt: jobOpportunities.postedAt, deadline: jobOpportunities.deadline, sourceType: jobSourcePostings.sourceType, isOfficial: jobSourcePostings.isOfficial })
      .from(agentRunJobResults).innerJoin(jobOpportunities, and(eq(jobOpportunities.userId, agentRunJobResults.userId), eq(jobOpportunities.id, agentRunJobResults.opportunityId))).innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, agentRunJobResults.userId), eq(jobSourcePostingVersions.id, agentRunJobResults.sourcePostingVersionId))).innerJoin(jobSourcePostings, and(eq(jobSourcePostings.userId, jobSourcePostingVersions.userId), eq(jobSourcePostings.id, jobSourcePostingVersions.sourcePostingId)))
      .where(and(eq(agentRunJobResults.userId, userId), eq(agentRunJobResults.runId, runId))).orderBy(asc(agentRunJobResults.ordinal)),
  ]);
  const usage = { activeDurationMs: run.activeDurationMs, attempts: run.attemptCount, toolCalls: run.toolCallCount, sourceRequests: run.sourceRequestCount, modelCalls: run.modelCallCount, inputTokens: run.inputTokenCount, outputTokens: run.outputTokenCount, totalTokens: run.totalTokenCount, results: run.resultCount, complete: run.usageComplete };
  const termination = run.terminationKind === null ? null : { kind: run.terminationKind, failureCode: run.failureCode, budgetDimension: run.terminationBudgetDimension };
  return { ...summary(run), executionSpec: { targetSnapshot: run.targetSnapshot, sourceScope: run.sourceScope, workflowVersion: run.workflowVersion, ruleVersion: run.ruleVersion, adapter: run.adapter, adapterVersion: run.adapterVersion, outputSchemaVersion: run.outputSchemaVersion, toolAllowlist: run.toolAllowlist, model: run.modelSnapshot, budget: run.budgetSnapshot }, controlState: run.controlState as AgentRunDetail["controlState"], usage, termination, retryOfRunId: run.retryOfRunId, steps: steps.map((step) => ({ stepKey: step.stepKey as AgentRunDetail["steps"][number]["stepKey"], ordinal: step.ordinal, status: step.status as AgentRunDetail["steps"][number]["status"], attemptCount: step.attemptCount, startedAt: step.startedAt?.toISOString() ?? null, completedAt: step.completedAt?.toISOString() ?? null, failedAt: step.failedAt?.toISOString() ?? null, failureCode: step.failureCode as AgentRunDetail["steps"][number]["failureCode"] })), events: events.map((event) => ({ sequence: event.sequence, runVersion: event.runVersion, eventType: event.eventType as AgentRunDetail["events"][number]["eventType"], data: event.data as AgentRunDetail["events"][number]["data"], createdAt: event.createdAt.toISOString() })), results: results.map((result) => ({ ...result, postedAt: result.postedAt?.toISOString() ?? null, deadline: result.deadline?.toISOString() ?? null })) } as AgentRunDetail;
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
