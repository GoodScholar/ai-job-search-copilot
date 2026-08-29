import { and, desc, eq } from "drizzle-orm";
import { agentInboxItems, agentRunEvents, agentRunUsageEntries, agentRuns, type Database } from "@job-copilot/database";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { AuditTrail } from "./audit-trail";

type BudgetDimension = "active_duration" | "attempts" | "tool_calls" | "model_calls" | "tokens";
type Reserve = { toolCalls?: number; sourceRequests?: number; modelCalls?: number };
export type AgentRunCheckpointDecision =
  | { kind: "continue" }
  | { kind: "paused" }
  | { kind: "cancelled" }
  | { kind: "budget_exhausted"; budgetDimension: BudgetDimension }
  | { kind: "stale" };

type Dependencies = { db: Database; auditTrail: AuditTrail; id: () => string; clock: () => Date };

async function appendEvent(db: any, input: { id: () => string; userId: string; runId: string; version: number; eventType: string; data: Record<string, unknown>; now: Date }) {
  const [latest] = await db.select({ sequence: agentRunEvents.sequence }).from(agentRunEvents)
    .where(and(eq(agentRunEvents.userId, input.userId), eq(agentRunEvents.runId, input.runId))).orderBy(desc(agentRunEvents.sequence)).limit(1);
  const sequence = (latest?.sequence ?? 0) + 1;
  await db.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: input.runId, sequence, runVersion: input.version, eventType: input.eventType, data: input.data, createdAt: input.now });
  return sequence;
}

function amount(value: number | undefined) { return value ?? 0; }
function activeDuration(run: typeof agentRuns.$inferSelect, now: Date) {
  return run.activeSliceStartedAt ? Math.max(0, now.getTime() - run.activeSliceStartedAt.getTime()) : 0;
}
function exhausted(run: typeof agentRuns.$inferSelect, reserve: Reserve, activeDurationMs: number): BudgetDimension | null {
  const budget = run.budgetSnapshot as { maxActiveDurationMs: number; maxAttempts: number; maxToolCalls: number; maxModelCalls: number; maxTokens: number };
  // attempt 是领取时预增的；第 3 次已合法领取，预算只阻止第 4 次领取。
  if (run.attemptCount > budget.maxAttempts) return "attempts";
  if (run.activeDurationMs + activeDurationMs >= budget.maxActiveDurationMs) return "active_duration";
  if (run.toolCallCount + amount(reserve.toolCalls) > budget.maxToolCalls) return "tool_calls";
  if (run.modelCallCount + amount(reserve.modelCalls) > budget.maxModelCalls) return "model_calls";
  return null;
}

async function writeUsage(transaction: any, input: { id: () => string; userId: string; runId: string; checkpointKey: string; attemptCount: number; activeDurationMs: number; reserve: Reserve; now: Date }) {
  const entries = [
    input.activeDurationMs > 0 ? { category: "active_duration", amount: input.activeDurationMs } : null,
    amount(input.reserve.toolCalls) > 0 ? { category: "tool_call", amount: amount(input.reserve.toolCalls) } : null,
    amount(input.reserve.sourceRequests) > 0 ? { category: "source_request", amount: amount(input.reserve.sourceRequests) } : null,
    amount(input.reserve.modelCalls) > 0 ? { category: "model_call", amount: amount(input.reserve.modelCalls) } : null,
  ].filter((entry): entry is { category: "active_duration" | "tool_call" | "source_request" | "model_call"; amount: number } => entry !== null);
  for (const entry of entries) await transaction.insert(agentRunUsageEntries).values({ id: input.id(), userId: input.userId, runId: input.runId, usageKey: input.checkpointKey, category: entry.category, amount: entry.amount, attemptCount: input.attemptCount, createdAt: input.now }).onConflictDoNothing();
  return entries;
}

export function createAgentRunCheckpoint(deps: Dependencies): {
  check(input: { userId: string; runId: string; claimToken: string; checkpointKey: string; reserve?: Reserve }): Promise<AgentRunCheckpointDecision>;
} {
  return {
    async check(input) {
      const reserve = input.reserve ?? {};
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.claimToken, input.claimToken)));
        const now = deps.clock();
        if (!run || run.status !== "running" || !run.claimExpiresAt || run.claimExpiresAt <= now) return { kind: "stale" };
        const elapsed = activeDuration(run, now);
        const prior = await transaction.select({ id: agentRunUsageEntries.id }).from(agentRunUsageEntries)
          .where(and(eq(agentRunUsageEntries.runId, input.runId), eq(agentRunUsageEntries.usageKey, input.checkpointKey))).limit(1);
        if (prior.length > 0) return { kind: "continue" };
        const dimension = exhausted(run, reserve, elapsed);
        const chargedReserve = run.controlState === "none" && dimension === null ? reserve : {};
        const usage = await writeUsage(transaction, { id: deps.id, userId: input.userId, runId: input.runId, checkpointKey: input.checkpointKey, attemptCount: run.attemptCount, activeDurationMs: elapsed, reserve: chargedReserve, now });
        const usageUpdate = { activeDurationMs: run.activeDurationMs + elapsed, toolCallCount: run.toolCallCount + amount(chargedReserve.toolCalls), sourceRequestCount: run.sourceRequestCount + amount(chargedReserve.sourceRequests), modelCallCount: run.modelCallCount + amount(chargedReserve.modelCalls), activeSliceStartedAt: now, updatedAt: now };
        if (usage.length > 0) await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_budget_consumed", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_BUDGET_CONSUMED", resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, activeDurationMs: elapsed, toolCalls: amount(chargedReserve.toolCalls), sourceRequests: amount(chargedReserve.sourceRequests), modelCalls: amount(chargedReserve.modelCalls) } });
        if (run.controlState === "cancel_requested") {
          const version = run.version + 1;
          await transaction.update(agentRuns).set({ ...usageUpdate, status: "cancelled", currentStep: "cancelled", controlState: "none", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, cancelledAt: now, terminationKind: "cancelled_by_user", terminationBudgetDimension: null, failureCode: null, usageComplete: true, version }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
          await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.cancelled", data: { eventType: "run.cancelled", status: "cancelled", currentStep: "cancelled", attemptCount: run.attemptCount }, now });
          await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_cancelled", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_CANCELLED", resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, version, action: "cancel", attemptCount: run.attemptCount } });
          return { kind: "cancelled" };
        }
        if (run.controlState === "pause_requested") {
          const version = run.version + 1;
          await transaction.update(agentRuns).set({ ...usageUpdate, status: "paused", controlState: "none", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, version }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
          const sequence = await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.paused", data: { eventType: "run.paused", status: "paused", currentStep: run.currentStep, attemptCount: run.attemptCount }, now });
          await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_paused", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_PAUSED", resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, version, action: "pause", attemptCount: run.attemptCount } });
          const [item] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: input.userId, runId: input.runId, triggerEventSequence: sequence, kind: "decision_required", status: "open", reasonCode: "AGENT_RUN_PAUSED", budgetDimension: null, createdAt: now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
          if (item) await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_PAUSED", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: input.runId, kind: "decision_required", reasonCode: "AGENT_RUN_PAUSED", budgetDimension: null } });
          return { kind: "paused" };
        }
        if (dimension) {
          const version = run.version + 1;
          await transaction.update(agentRuns).set({ ...usageUpdate, status: "failed", currentStep: "failed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, failedAt: now, terminationKind: "budget_exhausted", terminationBudgetDimension: dimension, failureCode: "AGENT_RUN_BUDGET_EXCEEDED", usageComplete: true, version }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
          const sequence = await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: run.attemptCount, failureCode: "AGENT_RUN_BUDGET_EXCEEDED" }, now });
          const [item] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: input.userId, runId: input.runId, triggerEventSequence: sequence, kind: "budget_exhausted", status: "open", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: dimension, createdAt: now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
          await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_budget_exhausted", occurredAt: now, requestId: input.runId, outcome: "failure", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, budgetDimension: dimension, attemptCount: run.attemptCount } });
          if (item) await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: input.runId, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: dimension } });
          return { kind: "budget_exhausted", budgetDimension: dimension };
        }
        await transaction.update(agentRuns).set(usageUpdate).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
        return { kind: "continue" };
      });
    },
  };
}
