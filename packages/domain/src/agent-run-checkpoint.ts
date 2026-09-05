import { and, desc, eq } from "drizzle-orm";
import { agentInboxItems, agentRunEvents, agentRunUsageEntries, agentRuns, type Database } from "@job-copilot/database";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { effectiveAgentRunBudget, type AgentRunBudget } from "./effective-agent-run-budget";
import type { AuditTrail } from "./audit-trail";
import { agentRunUsageSnapshot, appendBudgetFacts, settleActiveSlice, terminateBudgetRun, type BudgetDimension } from "./agent-run-lifecycle";

type Reserve = {
  toolCalls?: number;
  sourceRequests?: number;
  modelCalls?: number;
  /** 实际在模型调用前消耗的输入 token。 */
  inputTokens?: number;
  /** 仅在严格输出验证通过后消耗的输出 token。 */
  outputTokens?: number;
  /** 调用前的总 token 可用性预检，不写入 usage 聚合。 */
  budgetTokens?: number;
  /** 调用已返回：必须先幂等结算真实消耗，再据更新后的账本终止预算。 */
  settleActual?: boolean;
  /** Frozen at invocation time.  A late response must never be attributed to a replacement claim. */
  invocationAttemptCount?: number;
};
export type AgentRunCheckpointDecision =
  | { kind: "continue" }
  | { kind: "paused" }
  | { kind: "cancelled" }
  | { kind: "budget_exhausted"; budgetDimension: BudgetDimension }
  | { kind: "stale" };

export interface AgentRunCheckpoint {
  check(input: { userId: string; runId: string; claimToken: string; checkpointKey: string; reserve?: Reserve }): Promise<AgentRunCheckpointDecision>;
}

type Dependencies = { db: Database; auditTrail: AuditTrail; id: () => string; clock: () => Date };

export class AgentRunCheckpointError extends Error {
  constructor(public readonly code: "AGENT_RUN_CHECKPOINT_CONFLICT") { super(code); }
}

async function appendEvent(db: any, input: { id: () => string; userId: string; runId: string; version: number; eventType: string; data: Record<string, unknown>; now: Date }) {
  const [latest] = await db.select({ sequence: agentRunEvents.sequence }).from(agentRunEvents)
    .where(and(eq(agentRunEvents.userId, input.userId), eq(agentRunEvents.runId, input.runId))).orderBy(desc(agentRunEvents.sequence)).limit(1);
  const sequence = (latest?.sequence ?? 0) + 1;
  await db.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: input.runId, sequence, runVersion: input.version, eventType: input.eventType, data: input.data, createdAt: input.now });
  return sequence;
}

function amount(value: number | undefined) { return value ?? 0; }
function exhausted(run: typeof agentRuns.$inferSelect, reserve: Reserve, activeDurationMs: number): BudgetDimension | null {
  const budget = effectiveAgentRunBudget(run.workflowVersion, run.budgetSnapshot as AgentRunBudget);
  // attempt 是领取时预增的；第 3 次已合法领取，预算只阻止第 4 次领取。
  if (run.attemptCount > budget.maxAttempts) return "attempts";
  if (run.activeDurationMs + activeDurationMs >= budget.maxActiveDurationMs) return "active_duration";
  if (run.toolCallCount + amount(reserve.toolCalls) > budget.maxToolCalls) return "tool_calls";
  if (run.modelCallCount + amount(reserve.modelCalls) > budget.maxModelCalls) return "model_calls";
  if (run.totalTokenCount + amount(reserve.budgetTokens ?? (amount(reserve.inputTokens) + amount(reserve.outputTokens))) > budget.maxTokens) return "tokens";
  return null;
}

async function writeUsage(transaction: any, input: { id: () => string; userId: string; runId: string; checkpointKey: string; attemptCount: number; reserve: Reserve; now: Date }) {
  const entries = [
    amount(input.reserve.toolCalls) > 0 ? { category: "tool_call", amount: amount(input.reserve.toolCalls) } : null,
    amount(input.reserve.sourceRequests) > 0 ? { category: "source_request", amount: amount(input.reserve.sourceRequests) } : null,
    amount(input.reserve.modelCalls) > 0 ? { category: "model_call", amount: amount(input.reserve.modelCalls) } : null,
    amount(input.reserve.inputTokens) > 0 ? { category: "input_tokens", amount: amount(input.reserve.inputTokens) } : null,
    amount(input.reserve.outputTokens) > 0 ? { category: "output_tokens", amount: amount(input.reserve.outputTokens) } : null,
  ].filter((entry): entry is { category: "tool_call" | "source_request" | "model_call" | "input_tokens" | "output_tokens"; amount: number } => entry !== null);
  for (const entry of entries) await transaction.insert(agentRunUsageEntries).values({ id: input.id(), userId: input.userId, runId: input.runId, usageKey: input.checkpointKey, category: entry.category, amount: entry.amount, attemptCount: input.attemptCount, createdAt: input.now }).onConflictDoNothing();
  return entries;
}

function sameReserve(entries: Array<{ category: string; amount: number }>, reserve: Reserve) {
  const actual = new Map(entries.filter((entry) => entry.category !== "active_duration").map((entry) => [entry.category, entry.amount]));
  return actual.get("tool_call") === ((reserve.toolCalls ?? 0) || undefined)
    && actual.get("source_request") === ((reserve.sourceRequests ?? 0) || undefined)
    && actual.get("model_call") === ((reserve.modelCalls ?? 0) || undefined)
    && actual.get("input_tokens") === ((reserve.inputTokens ?? 0) || undefined)
    && actual.get("output_tokens") === ((reserve.outputTokens ?? 0) || undefined)
    && actual.size === [reserve.toolCalls, reserve.sourceRequests, reserve.modelCalls, reserve.inputTokens, reserve.outputTokens].filter((value) => (value ?? 0) > 0).length;
}

export function createAgentRunCheckpoint(deps: Dependencies): AgentRunCheckpoint {
  return {
    async check(input) {
      const reserve = input.reserve ?? {};
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
        const now = deps.clock();
        const expired = Boolean(run?.claimExpiresAt && run.claimExpiresAt <= now);
        // A returned model response is an accounting fact even when a new claimant has
        // already taken over.  Ordinary preflight/checkpoints remain claim-fenced; only
        // `settleActual` may record this immutable, run+candidate-keyed cost first.
        const ownsClaim = Boolean(run && run.claimToken === input.claimToken);
        if (!run || (!reserve.settleActual && (run.status !== "running" || !run.claimExpiresAt || !ownsClaim || (expired && run.controlState === "none")))) return { kind: "stale" };
        const prior = await transaction.select({ category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount }).from(agentRunUsageEntries)
          .where(and(eq(agentRunUsageEntries.runId, input.runId), eq(agentRunUsageEntries.usageKey, input.checkpointKey)));
        if (run.controlState === "none" && prior.length > 0 && !sameReserve(prior, reserve)) throw new AgentRunCheckpointError("AGENT_RUN_CHECKPOINT_CONFLICT");
        // A stale invocation may leave an immutable cost fact, but it may not settle the
        // replacement claimant's active slice or mutate its aggregate counters.
        const mayMutateRun = ownsClaim;
        const elapsed = mayMutateRun && (run.controlState !== "none" || prior.length === 0) ? await settleActiveSlice(transaction, { id: deps.id, userId: input.userId, run, now, until: expired ? run.claimExpiresAt ?? undefined : undefined }) : 0;
        const activeDurationMs = run.activeDurationMs + elapsed;
        const preflightDimension = exhausted({ ...run, activeDurationMs }, reserve, 0);
        // A post-call settlement is an accounting fact, not a reservation.  Never discard
        // an already incurred model call merely because it pushes the budget over its limit.
        // A completed model call is an immutable accounting fact even if a control request
        // lands between the response and this checkpoint.  Record it once, then transition.
        const chargedReserve = prior.length === 0 && (reserve.settleActual || (run.controlState === "none" && preflightDimension === null)) ? reserve : {};
        const usageEntries = prior.length === 0 ? await writeUsage(transaction, { id: deps.id, userId: input.userId, runId: input.runId, checkpointKey: input.checkpointKey, attemptCount: reserve.invocationAttemptCount ?? run.attemptCount, reserve: chargedReserve, now }) : [];
        const inputTokens = amount(chargedReserve.inputTokens);
        const outputTokens = amount(chargedReserve.outputTokens);
        const usageUpdate = { activeDurationMs, toolCallCount: run.toolCallCount + amount(chargedReserve.toolCalls), sourceRequestCount: run.sourceRequestCount + amount(chargedReserve.sourceRequests), modelCallCount: run.modelCallCount + amount(chargedReserve.modelCalls), inputTokenCount: run.inputTokenCount + inputTokens, outputTokenCount: run.outputTokenCount + outputTokens, totalTokenCount: run.totalTokenCount + inputTokens + outputTokens, activeSliceStartedAt: now, updatedAt: now };
        const usageChanged = elapsed > 0 || usageEntries.length > 0;
        const usageVersion = usageChanged ? run.version + 1 : run.version;
        const usage = agentRunUsageSnapshot(run, usageUpdate);
        if (usageChanged && mayMutateRun) {
          await transaction.update(agentRuns).set({ ...usageUpdate, version: usageVersion }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
          await appendBudgetFacts(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: input.userId, requestId: input.runId, runId: input.runId, version: usageVersion, currentStep: run.currentStep, usage, consumed: { activeDurationMs: elapsed, toolCalls: amount(chargedReserve.toolCalls), sourceRequests: amount(chargedReserve.sourceRequests), modelCalls: amount(chargedReserve.modelCalls) }, now });
        }
        if (!ownsClaim || (expired && run.controlState === "none")) return { kind: "stale" };
        if (run.controlState === "cancel_requested") {
          const version = usageVersion + 1;
          await transaction.update(agentRuns).set({ ...usageUpdate, status: "cancelled", currentStep: "cancelled", controlState: "none", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, cancelledAt: now, terminationKind: "cancelled_by_user", terminationBudgetDimension: null, failureCode: null, usageComplete: run.usageComplete, version }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
          await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.cancelled", data: { eventType: "run.cancelled", status: "cancelled", currentStep: "cancelled", attemptCount: run.attemptCount }, now });
          await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_cancelled", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_CANCELLED", resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, version, action: "cancel", attemptCount: run.attemptCount } });
          return { kind: "cancelled" };
        }
        if (run.controlState === "pause_requested") {
          const version = usageVersion + 1;
          await transaction.update(agentRuns).set({ ...usageUpdate, status: "paused", controlState: "none", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, version }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
          const sequence = await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.paused", data: { eventType: "run.paused", status: "paused", currentStep: run.currentStep, attemptCount: run.attemptCount }, now });
          await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_paused", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_PAUSED", resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, version, action: "pause", attemptCount: run.attemptCount } });
          const [item] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: input.userId, runId: input.runId, triggerEventSequence: sequence, kind: "decision_required", status: "unread", reasonCode: "AGENT_RUN_PAUSED", budgetDimension: null, createdAt: now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
          if (item) await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_PAUSED", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: input.runId, kind: "decision_required", reasonCode: "AGENT_RUN_PAUSED", budgetDimension: null } });
          return { kind: "paused" };
        }
        const dimension = reserve.settleActual
          ? exhausted({ ...run, ...usageUpdate }, {}, 0)
          : preflightDimension;
        if (dimension) {
          await terminateBudgetRun(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: input.userId, requestId: input.runId, run: { ...run, ...usageUpdate, version: usageVersion }, now, budgetDimension: dimension, activeDurationMs });
          return { kind: "budget_exhausted", budgetDimension: dimension };
        }
        if (prior.length > 0) return { kind: "continue" };
        if (!usageChanged) await transaction.update(agentRuns).set(usageUpdate).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
        return { kind: "continue" };
      });
    },
  };
}
