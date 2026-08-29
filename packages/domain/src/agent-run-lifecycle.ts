import { and, desc, eq } from "drizzle-orm";
import { agentInboxItems, agentRunEvents, agentRunUsageEntries, agentRuns } from "@job-copilot/database";
import type { AuditTrail } from "./audit-trail";

export type BudgetDimension = "active_duration" | "attempts" | "tool_calls" | "model_calls" | "tokens";

async function appendEvent(transaction: any, input: { id: () => string; userId: string; runId: string; version: number; eventType: "run.failed"; attemptCount: number; now: Date }) {
  const [latest] = await transaction.select({ sequence: agentRunEvents.sequence }).from(agentRunEvents)
    .where(and(eq(agentRunEvents.userId, input.userId), eq(agentRunEvents.runId, input.runId))).orderBy(desc(agentRunEvents.sequence)).limit(1);
  const sequence = (latest?.sequence ?? 0) + 1;
  await transaction.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: input.runId, sequence, runVersion: input.version, eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: input.attemptCount, failureCode: "AGENT_RUN_BUDGET_EXCEEDED" }, createdAt: input.now });
  return sequence;
}

/** 同一 claim slice 只可结算一次；稳定 key 使事务重试不会重复增加聚合。 */
export async function settleActiveSlice(transaction: any, input: { id: () => string; userId: string; run: typeof agentRuns.$inferSelect; now: Date; until?: Date }) {
  const startedAt = input.run.activeSliceStartedAt;
  const claimToken = input.run.claimToken;
  if (!startedAt || !claimToken) return 0;
  const settledAt = input.until && input.until < input.now ? input.until : input.now;
  const amount = Math.max(0, settledAt.getTime() - startedAt.getTime());
  if (amount === 0) return 0;
  const usageKey = `${claimToken}:active:${startedAt.toISOString()}`;
  const [inserted] = await transaction.insert(agentRunUsageEntries).values({
    id: input.id(), userId: input.userId, runId: input.run.id, usageKey, category: "active_duration", amount,
    attemptCount: input.run.attemptCount, createdAt: settledAt,
  }).onConflictDoNothing().returning({ id: agentRunUsageEntries.id });
  return inserted ? amount : 0;
}

/** 所有预算终止共用事件、Inbox 与审计语义；调用方必须持有账户锁。 */
export async function terminateBudgetRun(transaction: any, input: {
  id: () => string; auditTrail: AuditTrail; userId: string; requestId: string; run: typeof agentRuns.$inferSelect;
  now: Date; budgetDimension: BudgetDimension; activeDurationMs?: number;
}) {
  const version = input.run.version + 1;
  await transaction.update(agentRuns).set({
    status: "failed", currentStep: "failed", controlState: "none", claimToken: null, claimExpiresAt: null,
    activeSliceStartedAt: null, activeDurationMs: input.activeDurationMs ?? input.run.activeDurationMs,
    startedAt: input.run.startedAt ?? input.now, failedAt: input.now, terminationKind: "budget_exhausted", terminationBudgetDimension: input.budgetDimension,
    failureCode: "AGENT_RUN_BUDGET_EXCEEDED", usageComplete: input.run.usageComplete, version, updatedAt: input.now,
  }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.run.id)));
  const sequence = await appendEvent(transaction, { id: input.id, userId: input.userId, runId: input.run.id, version, attemptCount: input.run.attemptCount, now: input.now, eventType: "run.failed" });
  const [item] = await transaction.insert(agentInboxItems).values({ id: input.id(), userId: input.userId, runId: input.run.id, triggerEventSequence: sequence, kind: "budget_exhausted", status: "open", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: input.budgetDimension, createdAt: input.now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
  const audit = input.auditTrail.bind(transaction);
  await audit.append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_failed", occurredAt: input.now, requestId: input.requestId, outcome: "failure", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", resourceType: "agent_run", resourceId: input.run.id, metadata: { runId: input.run.id, targetId: input.run.targetId, attemptCount: input.run.attemptCount, failureCode: "AGENT_RUN_BUDGET_EXCEEDED" } });
  await audit.append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_budget_exhausted", occurredAt: input.now, requestId: input.requestId, outcome: "failure", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", resourceType: "agent_run", resourceId: input.run.id, metadata: { runId: input.run.id, budgetDimension: input.budgetDimension, attemptCount: input.run.attemptCount } });
  if (item) await audit.append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: input.now, requestId: input.requestId, outcome: "success", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: input.run.id, kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: input.budgetDimension } });
}
