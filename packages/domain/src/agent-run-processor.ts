import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, lte, or, sql } from "drizzle-orm";
import {
  agentInboxItems, agentRunEvents, agentRunSteps, agentRuns, jobDiscoveryAttributions, jobDiscoveryDiagnostics, jobDiscoveryLeads, jobDiscoveryRunResults, jobDiscoverySourceIssues, jobSourcePostingVersions, jobSourcePostings,
  type Database,
} from "@job-copilot/database";
import {
  AGENT_RUN_BUDGET, AGENT_RUN_JOB_VERSION, AgentRunExecutionSpecSchema, DiscoveryBatchSearchResultSchema, DiscoveryDetailResultSchema, PublicDiscoveryBatchSearchResultSchema,
  GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, parseSourceHealthDetailResult, parseSourceHealthListResult,
  type JobSourceHealthCheck,
  type AgentRunJob,
} from "@job-copilot/contracts/agent-runs";
import { AnySearchProviderErrorCodeSchema } from "@job-copilot/contracts/job-discovery";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { createJobDiscoveryPersistence, discoverySourceIdentifier, type DiscoveryDetail } from "./job-discovery-persistence";
import { persistJobOpportunity } from "./job-opportunity-persistence";
import { triggerDeepMatchAfterDiscovery } from "./deep-match-agent-runs";
import type { DeepMatchRunQueue } from "./deep-match-agent-runs";
import { decideRetry } from "./agent-run-state";
import { agentRunUsageSnapshot, appendBudgetFacts, settleActiveSlice, terminateBudgetRun, type BudgetDimension } from "./agent-run-lifecycle";
import type { AgentRunCheckpoint } from "./agent-run-checkpoint";
import { normalizeAgentRunSourceScope } from "./agent-run-source-scope";
import { applyTransactionDeadline } from "./transaction-deadline";
import { deriveSourceHealthTerminal, type SourceHealthTerminal } from "./source-health-terminal";
import type { SourceHealthDiscoveryAdapter, SourceHealthDiscoveryAdapterResolver } from "./source-health-discovery-adapter";
import {
  type LayeredPublicJobDiscoveryWorkflow,
  type LayeredPublicJobDiscoveryWorkflowResolver,
  LayeredPublicWorkflowBranchOutcomeSchema,
  LayeredPublicWorkflowInterruption,
  isLayeredPublicWorkflowInterruption,
  type LayeredPublicWorkflowDiagnostic,
} from "./layered-public-job-discovery-workflow";

export interface DiscoveryContentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "application/json"; runId: string }): Promise<void>;
  delete(input: { objectKey: string }): Promise<void>;
}

/** 在真实列表请求前执行；用于把每个 board 的逻辑预算与该 GET 绑定。 */
export type PublicDiscoveryListHook = (sourceId: string) => Promise<void>;
export type PublicDiscoveryBatchSearchInput = {
  targetSnapshot: import("@job-copilot/contracts/agent-runs").DiscoverySearchInput["targetSnapshot"];
  sourceScope: import("@job-copilot/contracts/agent-runs").PublicAgentRunSourceScope;
  beforeList?: PublicDiscoveryListHook;
};

export interface JobDiscoveryAdapter {
  search(input: import("@job-copilot/contracts/agent-runs").DiscoverySearchInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoverySearchResult>;
  searchBatch(input: import("@job-copilot/contracts/agent-runs").DiscoveryBatchSearchInput | PublicDiscoveryBatchSearchInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoveryBatchSearchResult | import("@job-copilot/contracts/agent-runs").PublicDiscoveryBatchSearchResult>;
  getDetail(input: import("@job-copilot/contracts/agent-runs").DiscoveryDetailInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoveryDetailResult>;
}

/** Resolves the adapter strictly from the immutable run execution spec. */
export interface JobDiscoveryAdapterResolver {
  resolve(input: { runId: string; idempotencyKey: string; executionSpec: unknown; attemptCount: number }): JobDiscoveryAdapter;
}

const stepKeys = ["batch_search", "fetch_details", "persist_results"] as const;

function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, jsonValue(item)]));
  return value;
}

/** 用稳定字节串保存外部原始对象，避免 JSON 键顺序造成伪版本。 */
export function canonicalJsonBytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(jsonValue(value))); }
export function canonicalJsonSha256(value: unknown): string { return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex"); }
export { discoverySourceIdentifier } from "./job-discovery-persistence";

export function createAgentRunRecoveryQueries(deps: { db: Database; clock: () => Date; batchSize?: number; queryTimeoutMs?: number }): {
  listRecoverable(): Promise<AgentRunJob[]>;
} {
  return {
    async listRecoverable() {
      const timeoutMs = deps.queryTimeoutMs ?? 1_000;
      const deadline = new Date(deps.clock().getTime() + timeoutMs);
      const rows = await bounded(deps.clock, deadline, () => deps.db.transaction(async (transaction) => {
        const remaining = remainingBudget(deps.clock, deadline);
        if (remaining <= 0) throw new AgentRunBudgetError("active_duration");
        await applyTransactionDeadline(transaction, { deadline, clock: deps.clock });
        const now = deps.clock();
        if (remainingBudget(deps.clock, deadline) <= 0) throw new AgentRunBudgetError("active_duration");
        return transaction.select({ runId: agentRuns.id, userId: agentRuns.userId }).from(agentRuns)
          .where(or(eq(agentRuns.status, "queued"), and(eq(agentRuns.status, "running"), lte(agentRuns.claimExpiresAt, now))))
          .orderBy(asc(agentRuns.queuedAt), asc(agentRuns.id)).limit(deps.batchSize ?? 100);
      }) as Promise<Array<{ runId: string; userId: string }>>);
      return rows.map((row) => ({ version: AGENT_RUN_JOB_VERSION, runId: row.runId, userId: row.userId }));
    },
  };
}

export type AgentRunProcessorDependencies = {
  db: Database;
  adapterResolver: JobDiscoveryAdapterResolver;
  sourceHealthAdapterResolver?: SourceHealthDiscoveryAdapterResolver;
  /** v4 的生产实现由 Slice 8 注入；这里不读取环境配置也不构造 provider client。 */
  layeredPublicWorkflowResolver?: LayeredPublicJobDiscoveryWorkflowResolver;
  checkpoint: AgentRunCheckpoint;
  contentStore: DiscoveryContentStore;
  auditTrail: AuditTrail;
  id: () => string;
  clock: () => Date;
  cleanupTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatStopTimeoutMs?: number;
  heartbeatRenew?: (input: { userId: string; runId: string; claimToken: string; deadline: Date }) => Promise<boolean | "paused" | "cancelled">;
  /** Matching runs share the existing queue; a persisted queued row remains the recovery authority. */
  matchingQueue?: DeepMatchRunQueue;
};
type FailureCode = "AGENT_RUN_ADAPTER_RETRYABLE" | "AGENT_RUN_ADAPTER_FAILED" | "AGENT_RUN_CONTENT_STORAGE_FAILED" | "AGENT_RUN_PERSIST_FAILED" | "AGENT_RUN_BUDGET_EXCEEDED";
type NonBudgetFailureCode = Exclude<FailureCode, "AGENT_RUN_BUDGET_EXCEEDED">;
const CLEANUP_TIMEOUT_MS = 1_000;
class AgentRunBudgetError extends Error {
  constructor(public readonly budgetDimension: BudgetDimension) { super("AGENT_RUN_BUDGET_EXCEEDED"); }
}
class PublicListCheckpointStop extends Error {
  constructor(readonly outcome: ProcessorOutcome) { super("PUBLIC_LIST_CHECKPOINT_STOP"); }
}
class LayeredPublicWorkflowStop extends Error {
  constructor(readonly outcome: ProcessorOutcome) { super("LAYERED_PUBLIC_WORKFLOW_STOP"); }
}

type Failure = { failureCode: FailureCode; retryable: boolean; category: "source" | "model" | "model_auth" | "model_policy" | "model_invalid"; budgetDimension?: BudgetDimension };

function remainingBudget(clock: () => Date, deadline: Date): number {
  return deadline.getTime() - clock().getTime();
}

async function runTransaction<T>(deps: AgentRunProcessorDependencies, deadline: Date, operation: (transaction: any) => Promise<T>): Promise<T> {
  const transaction = deps.db.transaction(async (connection) => {
    // 连接池等待结束后重新读取时间，迟到事务不执行任何业务 SQL。
    const remaining = remainingBudget(deps.clock, deadline);
    if (remaining <= 0) throw new AgentRunBudgetError("active_duration");
    // PostgreSQL 17 的 transaction_timeout 覆盖整个事务，statement/lock timeout 覆盖单次慢语句和锁等待。
    await applyTransactionDeadline(connection, { deadline, clock: deps.clock });
    if (remainingBudget(deps.clock, deadline) <= 0) throw new AgentRunBudgetError("active_duration");
    return operation(connection);
  }) as Promise<T>;
  // 池等待本身不可由 postgres-js 取消；晚到 callback 会先通过上面的 fresh deadline 检查自弃。
  return bounded(deps.clock, deadline, () => transaction);
}

function adapterFailure(error: unknown): Failure {
  if (error instanceof AgentRunBudgetError) return { failureCode: "AGENT_RUN_BUDGET_EXCEEDED", retryable: false, category: "source", budgetDimension: error.budgetDimension };
  if (error instanceof Error && error.name === "ZodError") return { failureCode: "AGENT_RUN_ADAPTER_FAILED", retryable: false, category: "source" };
  return { failureCode: "AGENT_RUN_ADAPTER_FAILED", retryable: false, category: "source" };
}

async function renewClaim(deps: AgentRunProcessorDependencies, input: { userId: string; runId: string; claimToken: string; deadline: Date }): Promise<boolean | "paused" | "cancelled"> {
  const [renewed] = await runTransaction<Array<{ outcome: boolean | "paused" | "cancelled" }>>(deps, input.deadline, async (transaction) => {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const now = deps.clock();
    if (remainingBudget(deps.clock, input.deadline) <= 0) throw new AgentRunBudgetError("active_duration");
    const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.claimToken)));
    if (!run) return [];
    if (run.controlState === "pause_requested") return [{ outcome: "paused" }];
    if (run.controlState === "cancel_requested") return [{ outcome: "cancelled" }];
    const elapsed = await settleActiveSlice(transaction, { id: deps.id, userId: input.userId, run, now });
    const activeDurationMs = run.activeDurationMs + elapsed;
    const version = elapsed > 0 ? run.version + 1 : run.version;
    const updated = await transaction.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() + 30_000), activeDurationMs, activeSliceStartedAt: now, version, updatedAt: now })
      .where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.controlState, "none"), eq(agentRuns.claimToken, input.claimToken))).returning({ id: agentRuns.id });
    if (updated[0]) {
      if (elapsed > 0) await appendBudgetFacts(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: input.userId, requestId: input.runId, runId: input.runId, version, currentStep: run.currentStep, usage: agentRunUsageSnapshot(run, { activeDurationMs }), consumed: { activeDurationMs: elapsed, toolCalls: 0, sourceRequests: 0, modelCalls: 0 }, now });
      return [{ outcome: true }];
    }
    const [afterFailedRenewal] = await transaction.select({ controlState: agentRuns.controlState }).from(agentRuns).where(and(
      eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.claimToken),
    ));
    if (afterFailedRenewal?.controlState === "pause_requested") return [{ outcome: "paused" }];
    if (afterFailedRenewal?.controlState === "cancel_requested") return [{ outcome: "cancelled" }];
    return [{ outcome: false }];
  });
  return renewed?.outcome ?? false;
}

function startClaimHeartbeat(deps: AgentRunProcessorDependencies, input: { userId: string; runId: string; claimToken: string; deadline: Date; onLeaseLost?(): void; onControl?(outcome: "paused" | "cancelled"): void }) {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const tick = () => {
    if (stopped || inFlight) return;
    const renew = deps.heartbeatRenew ?? ((renewInput) => renewClaim(deps, renewInput));
    inFlight = renew(input).then((renewed) => {
      if (renewed === "paused" || renewed === "cancelled") input.onControl?.(renewed);
      else if (!renewed) input.onLeaseLost?.();
    }, () => { input.onLeaseLost?.(); }).finally(() => { inFlight = undefined; });
  };
  tick();
  const interval = setInterval(tick, deps.heartbeatIntervalMs ?? 15_000);
  return async () => {
    stopped = true;
    (clearInterval as unknown as (timer: typeof interval) => void)(interval);
    if (inFlight) await bounded(deps.clock, new Date(deps.clock().getTime() + (deps.heartbeatStopTimeoutMs ?? 1_000)), () => inFlight!);
  };
}

async function bounded<T>(clock: () => Date, deadline: Date, operation: () => Promise<T>): Promise<T> {
  const remaining = deadline.getTime() - clock().getTime();
  if (remaining <= 0) throw new AgentRunBudgetError("active_duration");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([operation(), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AgentRunBudgetError("active_duration")), remaining); })]);
    if (clock().getTime() >= deadline.getTime()) throw new AgentRunBudgetError("active_duration");
    return result;
  } finally { if (timer) clearTimeout(timer); }
}

async function removeBestEffort(store: DiscoveryContentStore, clock: () => Date, deadline: Date, objectKeys: string[]) {
  await Promise.all(objectKeys.map(async (objectKey) => { try { await bounded(clock, deadline, () => store.delete({ objectKey })); } catch { /* 补偿不得覆盖主结果或 attempt deadline。 */ } }));
}

function cleanupDeadline(deps: AgentRunProcessorDependencies): Date {
  return new Date(deps.clock().getTime() + (deps.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS));
}

async function appendEvent(db: any, input: { id: () => string; userId: string; runId: string; version: number; eventType: string; data: Record<string, unknown>; now: Date }) {
  const [latest] = await db.select({ sequence: agentRunEvents.sequence }).from(agentRunEvents).where(and(eq(agentRunEvents.userId, input.userId), eq(agentRunEvents.runId, input.runId))).orderBy(desc(agentRunEvents.sequence)).limit(1);
  const sequence = (latest?.sequence ?? 0) + 1;
  await db.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: input.runId, sequence, runVersion: input.version, eventType: input.eventType, data: input.data, createdAt: input.now });
  return sequence;
}

async function stepTransition(deps: AgentRunProcessorDependencies, input: { userId: string; runId: string; claimToken: string; stepKey: typeof stepKeys[number]; complete: boolean; attemptCount: number; deadline: Date }) {
  const now = deps.clock();
  return runTransaction(deps, input.deadline, async (transaction) => {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.claimToken)));
    if (!run) return false;
    const version = run.version + 1;
    if (input.complete) {
      await transaction.update(agentRunSteps).set({ status: "completed", completedAt: now, failedAt: null, failureCode: null }).where(and(eq(agentRunSteps.userId, input.userId), eq(agentRunSteps.runId, input.runId), eq(agentRunSteps.stepKey, input.stepKey)));
    } else {
      await transaction.update(agentRunSteps).set({ status: "running", attemptCount: input.attemptCount, startedAt: now, completedAt: null, failedAt: null, failureCode: null }).where(and(eq(agentRunSteps.userId, input.userId), eq(agentRunSteps.runId, input.runId), eq(agentRunSteps.stepKey, input.stepKey)));
    }
    await transaction.update(agentRuns).set({ currentStep: input.stepKey, version, updatedAt: now }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.claimToken, input.claimToken)));
    await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: input.complete ? "step.completed" : "step.started", data: { eventType: input.complete ? "step.completed" : "step.started", status: "running", currentStep: input.stepKey, stepKey: input.stepKey, attemptCount: input.attemptCount }, now });
    return true;
  });
}

async function failOrRetry(deps: AgentRunProcessorDependencies, input: { userId: string; runId: string; claimToken: string; attemptCount: number; failure: Failure; deadline: Date; discoveryIssues?: Array<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }> }): Promise<"retry" | "budget_exhausted" | "failed" | "stale"> {
  const now = deps.clock();
  // 预算到点后仍要用极短、可取消的控制事务写出明确终态，不能让运行悬空。
  const controlDeadline = remainingBudget(deps.clock, input.deadline) <= 0 ? new Date(now.getTime() + 1_000) : input.deadline;
  return runTransaction(deps, controlDeadline, async (transaction) => {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.claimToken)));
    if (!run) return "stale";
    const elapsed = await settleActiveSlice(transaction, { id: deps.id, userId: input.userId, run, now });
    const activeDurationMs = run.activeDurationMs + elapsed;
    const reserve = input.failure.category === "source" ? { toolCalls: 1, sourceRequests: 1 }
      : input.failure.category === "model" ? { modelCalls: 1, tokens: 1 }
      : undefined;
    const decision = input.failure.failureCode === "AGENT_RUN_BUDGET_EXCEEDED"
      ? { kind: "budget_exhausted" as const, budgetDimension: input.failure.budgetDimension ?? "active_duration" }
      : decideRetry({ failure: { category: input.failure.category, retryable: input.failure.retryable }, usage: { attempts: run.attemptCount, activeDurationMs, toolCalls: run.toolCallCount, modelCalls: run.modelCallCount, totalTokens: run.totalTokenCount }, budget: run.budgetSnapshot as { maxAttempts: number; maxActiveDurationMs: number; maxToolCalls: number; maxModelCalls: number; maxTokens: number }, reserve });
    const version = run.version + 1;
    if (decision.kind === "retry") {
      await transaction.update(agentRunSteps).set({ status: "pending", startedAt: null, completedAt: null, failedAt: null, failureCode: null }).where(and(eq(agentRunSteps.userId, input.userId), eq(agentRunSteps.runId, input.runId)));
      await transaction.update(agentRuns).set({ status: "queued", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, activeDurationMs, startedAt: null, completedAt: null, failedAt: null, failureCode: null, version, updatedAt: now }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.claimToken, input.claimToken)));
      await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.retry_scheduled", data: { eventType: "run.retry_scheduled", status: "queued", currentStep: run.currentStep, attemptCount: input.attemptCount, failureCode: input.failure.failureCode }, now });
      await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_retry_scheduled", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: input.failure.failureCode, resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, attemptCount: input.attemptCount, failureCode: input.failure.failureCode } });
      return "retry";
    }
    const budgetExhausted = decision.kind === "budget_exhausted";
    const failureCode = budgetExhausted ? "AGENT_RUN_BUDGET_EXCEEDED" : input.failure.failureCode;
    await transaction.update(agentRunSteps).set({ status: "failed", completedAt: null, failedAt: now, failureCode }).where(and(eq(agentRunSteps.userId, input.userId), eq(agentRunSteps.runId, input.runId), eq(agentRunSteps.stepKey, run.currentStep), eq(agentRunSteps.status, "running")));
    if (budgetExhausted) {
      const sequence = await terminateBudgetRun(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: input.userId, requestId: input.runId, run, now, budgetDimension: decision.budgetDimension, activeDurationMs });
      for (const issue of input.discoveryIssues ?? []) await transaction.insert(jobDiscoverySourceIssues).values({ id: deps.id(), userId: input.userId, runId: input.runId, provider: issue.provider, code: issue.code, affectedCount: issue.affectedCount, createdAt: now }).onConflictDoNothing();
      if ((input.discoveryIssues?.length ?? 0) > 0) {
        const [attention] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: input.userId, runId: input.runId, triggerEventSequence: sequence, kind: "discovery_attention", status: "open", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null, createdAt: now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
        if (attention) await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "DISCOVERY_ATTENTION", resourceType: "agent_inbox_item", resourceId: attention.id, metadata: { runId: input.runId, kind: "discovery_attention", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null } });
      }
      return "budget_exhausted";
    }
    const terminationKind = failureCode === "AGENT_RUN_CONTENT_STORAGE_FAILED" ? "content_storage_failed" : failureCode === "AGENT_RUN_PERSIST_FAILED" ? "persistence_failed" : "source_failed";
    await transaction.update(agentRuns).set({ status: "failed", currentStep: "failed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, activeDurationMs, failureCode, terminationKind, terminationBudgetDimension: null, failedAt: now, version, updatedAt: now }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.claimToken, input.claimToken)));
    const sequence = await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: input.attemptCount, failureCode }, now });
    for (const issue of input.discoveryIssues ?? []) await transaction.insert(jobDiscoverySourceIssues).values({ id: deps.id(), userId: input.userId, runId: input.runId, provider: issue.provider, code: issue.code, affectedCount: issue.affectedCount, createdAt: now }).onConflictDoNothing();
    if ((input.discoveryIssues?.length ?? 0) > 0) {
      const [attention] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: input.userId, runId: input.runId, triggerEventSequence: sequence, kind: "discovery_attention", status: "open", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null, createdAt: now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
      if (attention) await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: "DISCOVERY_ATTENTION", resourceType: "agent_inbox_item", resourceId: attention.id, metadata: { runId: input.runId, kind: "discovery_attention", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null } });
    }
    await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_failed", occurredAt: now, requestId: input.runId, outcome: "failure", reasonCode: failureCode, resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, targetId: run.targetId, attemptCount: input.attemptCount, failureCode } });
    const nonBudgetFailureCode = failureCode as NonBudgetFailureCode;
    const [item] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: input.userId, runId: input.runId, triggerEventSequence: sequence, kind: "run_failed", status: "open", reasonCode: nonBudgetFailureCode, budgetDimension: null, createdAt: now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
    if (item) await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: now, requestId: input.runId, outcome: "success", reasonCode: nonBudgetFailureCode, resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: input.runId, kind: "run_failed", reasonCode: nonBudgetFailureCode, budgetDimension: null } });
    return "failed";
  });
}

type ProcessorOutcome = "completed" | "retry" | "paused" | "cancelled" | "budget_exhausted" | "failed" | "stale";

async function checkPoint(checkpoint: AgentRunCheckpoint, input: { userId: string; runId: string; claimToken: string; operation: string; ordinal: number; reserve?: { toolCalls?: number; sourceRequests?: number; modelCalls?: number } }): Promise<ProcessorOutcome | null> {
  const decision = await checkpoint.check({
    userId: input.userId,
    runId: input.runId,
    claimToken: input.claimToken,
    checkpointKey: `${input.claimToken}:${input.operation}:${input.ordinal}`,
    reserve: input.reserve,
  });
  switch (decision.kind) {
    case "continue": return null;
    case "paused": return "paused";
    case "cancelled": return "cancelled";
    case "budget_exhausted": return "budget_exhausted";
    case "stale": return "stale";
  }
}

/** v4 终态只持久化脱敏 diagnostic facts；页面、URL、query 正文和 provider body 均留在 adapter 生命周期内。 */
async function persistLayeredPublicOutcome(deps: AgentRunProcessorDependencies, input: {
  userId: string; runId: string; claimToken: string; now: Date; deadline: Date;
  diagnostics: readonly LayeredPublicWorkflowDiagnostic[];
  sourceIssues: ReadonlyArray<{ provider: "anysearch" | "greenhouse"; code: string; affectedCount: number }>;
  sourcePostingVersionIds: readonly string[];
  trustedSourcePostingVersionIds: readonly string[];
  trustedSourceIds: readonly string[];
  complete?: boolean;
  interrupted?: "paused" | "cancelled" | "budget_exhausted" | "stale";
}): Promise<"completed" | "stale" | "facts"> {
  return runTransaction(deps, input.deadline, async (transaction) => {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const [run] = await transaction.select().from(agentRuns).where(input.interrupted
      ? and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId))
      : and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.claimToken), eq(agentRuns.controlState, "none")));
    if (!run) return "stale";
    if (input.interrupted === "paused" && run.status !== "paused") return "stale";
    if (input.interrupted === "cancelled" && run.status !== "cancelled") return "stale";
    if (input.interrupted === "budget_exhausted" && !(run.status === "failed" && run.terminationKind === "budget_exhausted")) return "stale";
    if (input.interrupted === "stale" && run.status === "running" && run.claimToken === input.claimToken) return "stale";
    const plannedQueries = new Map(((run.sourceScope as { publicDiscovery?: { queries?: Array<{ queryId: string; kind: string; stableFingerprint: string }> } }).publicDiscovery?.queries ?? []).map((query) => [query.queryId, query]));
    for (const diagnostic of input.diagnostics) {
      if (diagnostic.scope === "provider" && !AnySearchProviderErrorCodeSchema.safeParse(diagnostic.code).success) throw new Error("LAYERED_PUBLIC_DIAGNOSTIC_INVALID");
      if (diagnostic.scope === "query") {
        const query = plannedQueries.get(diagnostic.queryId);
        if (!query || query.kind !== diagnostic.kind || query.stableFingerprint !== diagnostic.stableFingerprint) throw new Error("LAYERED_PUBLIC_DIAGNOSTIC_INVALID");
      }
      if (diagnostic.scope === "lead") {
        const [lead] = await transaction.select({ runId: jobDiscoveryLeads.runId }).from(jobDiscoveryLeads).where(and(eq(jobDiscoveryLeads.userId, input.userId), eq(jobDiscoveryLeads.id, diagnostic.leadId))).limit(1);
        if (!lead || lead.runId !== input.runId) throw new Error("LAYERED_PUBLIC_DIAGNOSTIC_INVALID");
      }
      const values = diagnostic.scope === "provider"
        ? { id: deps.id(), userId: input.userId, runId: input.runId, scope: "provider" as const, provider: "anysearch" as const, queryId: null, queryKind: null, queryFingerprint: null, leadId: null, code: diagnostic.code, retryable: diagnostic.retryable, affectedCount: diagnostic.affectedCount, createdAt: input.now }
        : diagnostic.scope === "query"
          ? { id: deps.id(), userId: input.userId, runId: input.runId, scope: "query" as const, provider: "anysearch" as const, queryId: diagnostic.queryId, queryKind: diagnostic.kind, queryFingerprint: diagnostic.stableFingerprint, leadId: null, code: diagnostic.code, retryable: diagnostic.retryable, affectedCount: diagnostic.affectedCount, createdAt: input.now }
          : { id: deps.id(), userId: input.userId, runId: input.runId, scope: "lead" as const, provider: "anysearch" as const, queryId: null, queryKind: null, queryFingerprint: null, leadId: diagnostic.leadId, code: diagnostic.code, retryable: diagnostic.retryable, affectedCount: 1, createdAt: input.now };
      await transaction.insert(jobDiscoveryDiagnostics).values(values).onConflictDoUpdate({
        target: [jobDiscoveryDiagnostics.userId, jobDiscoveryDiagnostics.runId, jobDiscoveryDiagnostics.scope, jobDiscoveryDiagnostics.provider, jobDiscoveryDiagnostics.queryId, jobDiscoveryDiagnostics.leadId, jobDiscoveryDiagnostics.code],
        set: { affectedCount: sql`greatest(${jobDiscoveryDiagnostics.affectedCount}, excluded.affected_count)` },
      });
    }
    for (const issue of input.sourceIssues) {
      await transaction.insert(jobDiscoverySourceIssues).values({ id: deps.id(), userId: input.userId, runId: input.runId, provider: issue.provider, code: issue.code, affectedCount: issue.affectedCount, createdAt: input.now }).onConflictDoUpdate({
        target: [jobDiscoverySourceIssues.userId, jobDiscoverySourceIssues.runId, jobDiscoverySourceIssues.provider, jobDiscoverySourceIssues.code],
        set: { affectedCount: sql`greatest(${jobDiscoverySourceIssues.affectedCount}, excluded.affected_count)` },
      });
    }
    if (input.complete === false) {
      if (input.sourceIssues.length > 0) {
        const [existing] = await transaction.select({ id: agentInboxItems.id }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, input.userId), eq(agentInboxItems.runId, input.runId), eq(agentInboxItems.kind, "discovery_attention"))).limit(1);
        if (!existing) {
          const [latest] = await transaction.select({ sequence: agentRunEvents.sequence }).from(agentRunEvents).where(and(eq(agentRunEvents.userId, input.userId), eq(agentRunEvents.runId, input.runId))).orderBy(desc(agentRunEvents.sequence)).limit(1);
          if (latest) await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: input.userId, runId: input.runId, triggerEventSequence: latest.sequence, kind: "discovery_attention", status: "open", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null, createdAt: input.now }).onConflictDoNothing();
        }
      }
      return "facts";
    }
    const attributed = new Set((await transaction.select({ sourcePostingVersionId: jobDiscoveryAttributions.sourcePostingVersionId }).from(jobDiscoveryAttributions).where(and(eq(jobDiscoveryAttributions.userId, input.userId), eq(jobDiscoveryAttributions.runId, input.runId)))).map((row: { sourcePostingVersionId: string }) => row.sourcePostingVersionId));
    const trusted = new Set(input.trustedSourcePostingVersionIds);
    for (const sourcePostingVersionId of input.sourcePostingVersionIds) {
      const [version] = await transaction.select({ sourceId: jobSourcePostings.sourceId, sourceIdentifier: jobSourcePostings.sourceIdentifier, sourceType: jobSourcePostings.sourceType, isOfficial: jobSourcePostings.isOfficial }).from(jobSourcePostingVersions).innerJoin(jobSourcePostings, and(eq(jobSourcePostings.userId, jobSourcePostingVersions.userId), eq(jobSourcePostings.id, jobSourcePostingVersions.sourcePostingId))).where(and(eq(jobSourcePostingVersions.userId, input.userId), eq(jobSourcePostingVersions.id, sourcePostingVersionId))).limit(1);
      const trustedVersion = trusted.has(sourcePostingVersionId)
        && version?.sourceId !== null
        && input.trustedSourceIds.includes(version?.sourceId ?? "")
        && version?.sourceType === "company_careers"
        && version.isOfficial;
      if (!version || (!attributed.has(sourcePostingVersionId) && !trustedVersion)) throw new Error("LAYERED_PUBLIC_RESULT_PROVENANCE_INVALID");
      if (attributed.has(sourcePostingVersionId)) {
        await persistJobOpportunity(transaction, {
          id: deps.id, userId: input.userId, importId: null, sourcePostingVersionId, isOfficial: version.isOfficial,
          company: null, title: null, location: null, postedAt: null, deadline: null, description: null, normalizedData: {},
          dedupIdentity: version.sourceIdentifier, now: input.now,
        });
      }
    }
    const existingResults: Array<{ ordinal: number; sourcePostingVersionId: string }> = await transaction.select({ ordinal: jobDiscoveryRunResults.ordinal, sourcePostingVersionId: jobDiscoveryRunResults.sourcePostingVersionId })
      .from(jobDiscoveryRunResults).where(and(eq(jobDiscoveryRunResults.userId, input.userId), eq(jobDiscoveryRunResults.runId, input.runId))).orderBy(asc(jobDiscoveryRunResults.ordinal));
    const existingVersionIds = new Set(existingResults.map((result) => result.sourcePostingVersionId));
    let nextOrdinal = Math.max(0, ...existingResults.map((result) => result.ordinal)) + 1;
    for (const sourcePostingVersionId of [...new Set(input.sourcePostingVersionIds)]) {
      if (existingVersionIds.has(sourcePostingVersionId) || nextOrdinal > 5) continue;
      await transaction.insert(jobDiscoveryRunResults).values({ id: deps.id(), userId: input.userId, runId: input.runId, sourcePostingVersionId, ordinal: nextOrdinal, createdAt: input.now }).onConflictDoNothing({ target: [jobDiscoveryRunResults.userId, jobDiscoveryRunResults.runId, jobDiscoveryRunResults.sourcePostingVersionId] });
      existingVersionIds.add(sourcePostingVersionId);
      nextOrdinal += 1;
    }
    const [{ resultCount }] = await transaction.select({ resultCount: count() }).from(jobDiscoveryRunResults).where(and(
      eq(jobDiscoveryRunResults.userId, input.userId), eq(jobDiscoveryRunResults.runId, input.runId),
    ));
    const sourceIssues = await transaction.select({ id: jobDiscoverySourceIssues.id }).from(jobDiscoverySourceIssues).where(and(
      eq(jobDiscoverySourceIssues.userId, input.userId), eq(jobDiscoverySourceIssues.runId, input.runId),
    ));
    const terminal = sourceIssues.length > 0 ? "completed_with_source_issues" as const : "completed" as const;
    const elapsed = await settleActiveSlice(transaction, { id: deps.id, userId: input.userId, run, now: input.now });
    const activeDurationMs = run.activeDurationMs + elapsed;
    const version = run.version + 1;
    await transaction.update(agentRunSteps).set({ status: "completed", completedAt: input.now, failedAt: null, failureCode: null }).where(and(
      eq(agentRunSteps.userId, input.userId), eq(agentRunSteps.runId, input.runId), eq(agentRunSteps.status, "running"),
    ));
    await transaction.update(agentRuns).set({ status: "completed", currentStep: "completed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, activeDurationMs, completedAt: input.now, failedAt: null, failureCode: null, terminationKind: terminal, terminationBudgetDimension: null, resultCount: Math.min(Number(resultCount), 5), usageComplete: true, version, updatedAt: input.now }).where(and(
      eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.claimToken, input.claimToken), eq(agentRuns.controlState, "none"),
    ));
    const sequence = await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.completed", data: { eventType: "run.completed", status: "completed", currentStep: "completed", attemptCount: run.attemptCount, resultCount: Math.min(Number(resultCount), 5) }, now: input.now });
    await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_completed", occurredAt: input.now, requestId: input.runId, outcome: "success", reasonCode: "AGENT_RUN_COMPLETED", resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, targetId: run.targetId, attemptCount: run.attemptCount, resultCount: Math.min(Number(resultCount), 5) } });
    if (sourceIssues.length > 0) {
      const [existing] = await transaction.select({ id: agentInboxItems.id }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, input.userId), eq(agentInboxItems.runId, input.runId), eq(agentInboxItems.kind, "discovery_attention"))).limit(1);
      if (!existing) {
        const [item] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: input.userId, runId: input.runId, triggerEventSequence: sequence, kind: "discovery_attention", status: "open", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null, createdAt: input.now }).returning({ id: agentInboxItems.id });
        if (item) await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: input.now, requestId: input.runId, outcome: "success", reasonCode: "DISCOVERY_ATTENTION", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: input.runId, kind: "discovery_attention", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null } });
      }
    }
    return "completed";
  });
}

export function createAgentRunProcessor(deps: AgentRunProcessorDependencies): { process(job: AgentRunJob & { finalAttempt?: boolean }): Promise<ProcessorOutcome> } {
  return {
    async process(job) {
      const now = deps.clock();
      let deadline = new Date(now.getTime() + AGENT_RUN_BUDGET.maxActiveDurationMs);
      const claimed = await runTransaction(deps, deadline, async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, job.userId);
        const claimNow = deps.clock();
        if (remainingBudget(deps.clock, deadline) <= 0) throw new AgentRunBudgetError("active_duration");
        let [current] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        if (!current) return { kind: "stale" as const };
        if (current.status === "completed") return { kind: current.workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION ? "completed" as const : "stale" as const };
        if (current.status === "failed") return { kind: current.terminationKind === "budget_exhausted" ? "budget_exhausted" as const : "failed" as const };
        if (current.status === "paused") return { kind: "paused" as const };
        if (current.status === "cancelled") return { kind: "cancelled" as const };
        if (current.status === "running" && current.claimExpiresAt && current.claimExpiresAt > claimNow) return { kind: "retry" as const };
        if (current.status === "running" && current.claimExpiresAt && current.claimExpiresAt <= claimNow) {
          if (current.controlState !== "none" && current.claimToken) return { kind: "pending_control" as const, claimToken: current.claimToken };
          const elapsed = await settleActiveSlice(transaction, { id: deps.id, userId: job.userId, run: current, now: claimNow, until: current.claimExpiresAt });
          const activeDurationMs = current.activeDurationMs + elapsed;
          const budget = current.budgetSnapshot as { maxActiveDurationMs: number };
          if (activeDurationMs >= budget.maxActiveDurationMs) {
            await transaction.update(agentRunSteps).set({ status: "failed", completedAt: null, failedAt: claimNow, failureCode: "AGENT_RUN_BUDGET_EXCEEDED" }).where(and(
              eq(agentRunSteps.userId, job.userId), eq(agentRunSteps.runId, job.runId), eq(agentRunSteps.stepKey, current.currentStep), eq(agentRunSteps.status, "running"),
            ));
            await terminateBudgetRun(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: job.userId, requestId: job.runId, run: current, now: claimNow, budgetDimension: "active_duration", activeDurationMs });
            return { kind: "budget_exhausted" as const };
          }
          current = { ...current, activeDurationMs };
        }
        if (current.attemptCount >= AGENT_RUN_BUDGET.maxAttempts) {
          await transaction.update(agentRunSteps).set({ status: "failed", completedAt: null, failedAt: claimNow, failureCode: "AGENT_RUN_BUDGET_EXCEEDED" }).where(and(
            eq(agentRunSteps.userId, job.userId), eq(agentRunSteps.runId, job.runId), eq(agentRunSteps.stepKey, current.currentStep), eq(agentRunSteps.status, "running"),
          ));
          await terminateBudgetRun(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: job.userId, requestId: job.runId, run: current, now: claimNow, budgetDimension: "attempts" });
          return { kind: "budget_exhausted" as const };
        }
        const claimToken = deps.id();
        const attemptCount = current.attemptCount + 1;
        const version = current.version + 1;
        const [run] = await transaction.update(agentRuns).set({ status: "running", currentStep: "batch_search", claimToken, claimExpiresAt: new Date(claimNow.getTime() + 30_000), activeSliceStartedAt: claimNow, activeDurationMs: current.activeDurationMs, attemptCount, startedAt: claimNow, completedAt: null, failedAt: null, failureCode: null, version, updatedAt: claimNow }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), or(eq(agentRuns.status, "queued"), and(eq(agentRuns.status, "running"), lte(agentRuns.claimExpiresAt, claimNow))))).returning();
        if (!run) return { kind: "stale" as const };
        await appendEvent(transaction, { id: deps.id, userId: job.userId, runId: job.runId, version, eventType: "run.started", data: { eventType: "run.started", status: "running", currentStep: "batch_search", attemptCount }, now: claimNow });
        const usageVersion = version + 1;
        await transaction.update(agentRuns).set({ version: usageVersion, updatedAt: claimNow }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.claimToken, claimToken)));
        const claimedRun = { ...run, version: usageVersion };
        await appendBudgetFacts(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: job.userId, requestId: job.runId, runId: job.runId, version: usageVersion, currentStep: "batch_search", usage: agentRunUsageSnapshot(claimedRun), consumed: { activeDurationMs: 0, toolCalls: 0, sourceRequests: 0, modelCalls: 0 }, now: claimNow });
        return { kind: "claimed" as const, run: claimedRun, claimToken, attemptCount };
      });
      if (claimed.kind === "pending_control") {
        const controlOutcome = await checkPoint(deps.checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "recovery_control", ordinal: 1 });
        return controlOutcome ?? "stale";
      }
      if (claimed.kind !== "claimed") return claimed.kind;
      deadline = new Date(now.getTime() + Number((claimed.run.budgetSnapshot as { maxActiveDurationMs: number }).maxActiveDurationMs));
      const checkpoint = deps.checkpoint;
      const claimOutcome = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "claim", ordinal: 1 });
      if (claimOutcome) return claimOutcome;
      let adapter!: JobDiscoveryAdapter;
      let sourceHealthAdapter!: SourceHealthDiscoveryAdapter;
      let layeredWorkflow!: LayeredPublicJobDiscoveryWorkflow;
      let layeredExecutionSpec!: Extract<ReturnType<typeof AgentRunExecutionSpecSchema.parse>, { workflowVersion: "layered-public-job-discovery-v1" }>;
      try {
        const resolverInput = {
          runId: claimed.run.id,
          idempotencyKey: claimed.run.idempotencyKey,
          executionSpec: {
            targetSnapshot: claimed.run.targetSnapshot,
            sourceScope: claimed.run.sourceScope,
            workflowVersion: claimed.run.workflowVersion,
            ruleVersion: claimed.run.ruleVersion,
            adapter: claimed.run.adapter,
            adapterVersion: claimed.run.adapterVersion,
            outputSchemaVersion: claimed.run.outputSchemaVersion,
            toolAllowlist: claimed.run.toolAllowlist,
            model: claimed.run.modelSnapshot,
          budget: claimed.run.budgetSnapshot,
        },
          attemptCount: claimed.attemptCount,
        };
        if (claimed.run.workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION) {
          if (!deps.sourceHealthAdapterResolver) throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
          sourceHealthAdapter = deps.sourceHealthAdapterResolver.resolve(resolverInput);
        } else if (claimed.run.workflowVersion === "layered-public-job-discovery-v1") {
          if (!deps.layeredPublicWorkflowResolver) throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED");
          const parsed = AgentRunExecutionSpecSchema.parse({ ...resolverInput.executionSpec, profileSnapshot: claimed.run.profileSnapshot, watchlistSnapshot: claimed.run.watchlistSnapshot });
          if (parsed.workflowVersion !== "layered-public-job-discovery-v1") throw new Error("LAYERED_PUBLIC_WORKFLOW_SPEC_REQUIRED");
          layeredExecutionSpec = parsed;
          layeredWorkflow = deps.layeredPublicWorkflowResolver.resolve({ ...resolverInput, executionSpec: parsed });
        } else adapter = deps.adapterResolver.resolve(resolverInput);
      } catch (error) {
        return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline });
      }
      const layeredController = claimed.run.workflowVersion === "layered-public-job-discovery-v1" ? new AbortController() : undefined;
      let trustedStop: "paused" | "cancelled" | "budget_exhausted" | "stale" | undefined;
      let heartbeatControl: "paused" | "cancelled" | undefined;
      const stopHeartbeat = startClaimHeartbeat(deps, {
        userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, deadline,
        onLeaseLost: () => layeredController?.abort(),
        onControl: (outcome) => { heartbeatControl = outcome; trustedStop = outcome; layeredController?.abort(); },
      });
      try {
      const adapterCall = async <T>(operation: string, ordinal: number, call: () => Promise<T>): Promise<{ value?: T; outcome?: ProcessorOutcome }> => {
        const before = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation, ordinal, reserve: { toolCalls: 1, sourceRequests: 1 } });
        if (before) return { outcome: before };
        const value = await bounded(deps.clock, deadline, call);
        const after = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: `${operation}_after`, ordinal });
        return after ? { outcome: after } : { value };
      };
      const transition = async (stepKey: typeof stepKeys[number], complete: boolean): Promise<ProcessorOutcome | null> => {
        if (!await stepTransition(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, stepKey, complete, attemptCount: claimed.attemptCount, deadline })) return "stale";
        return checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: `step_${stepKey}_${complete ? "complete" : "start"}`, ordinal: 1 });
      };
      const persistDiscoveryOutcome = async (input: { details: DiscoveryDetail[]; scans: Array<{ sourceId: string; observedDetailIds: string[]; complete: boolean }>; sourceChecks?: JobSourceHealthCheck[]; terminal?: SourceHealthTerminal }) => {
        const stored = input.details.map((detail) => {
          const bytes = canonicalJsonBytes(detail.rawPayload); const sourceIdentifier = discoverySourceIdentifier(detail.sourceId, detail.detailId); const rawContentSha256 = createHash("sha256").update(bytes).digest("hex");
          return { detail, bytes, rawContentSha256, objectKey: `accounts/${job.userId}/agent-runs/${job.runId}/sources/${sourceIdentifier}/${claimed.claimToken}/${rawContentSha256}.json` };
        });
        const putObjectKeys: string[] = [];
        try {
          for (const item of stored) {
            putObjectKeys.push(item.objectKey); const put = deps.contentStore.put({ objectKey: item.objectKey, bytes: item.bytes, mediaType: "application/json", runId: job.runId });
            try { await bounded(deps.clock, deadline, () => put); } catch (error) { void put.then(() => removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), [item.objectKey]), () => removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), [item.objectKey])).catch(() => undefined); throw error; }
            const writeOutcome = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "object_write", ordinal: putObjectKeys.length });
            if (writeOutcome) { await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), putObjectKeys); return writeOutcome; }
          }
        } catch (error) { await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), putObjectKeys); return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: error instanceof AgentRunBudgetError ? "AGENT_RUN_BUDGET_EXCEEDED" : "AGENT_RUN_CONTENT_STORAGE_FAILED", retryable: !(error instanceof AgentRunBudgetError), category: "source", budgetDimension: error instanceof AgentRunBudgetError ? error.budgetDimension : undefined }, deadline }); }
        const commitBefore = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "domain_commit_before", ordinal: 1 });
        if (commitBefore) { await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), putObjectKeys); return commitBefore; }
        let persisted: { cleanupObjectKeys: string[]; completed: boolean };
        try { persisted = await runTransaction(deps, deadline, (transaction) => createJobDiscoveryPersistence({ db: deps.db, id: deps.id, auditTrail: deps.auditTrail }).persistSuccessfulDiscovery({ run: { ...claimed.run, claimToken: claimed.claimToken }, details: input.details, scans: input.scans, storedObjects: stored.map((item) => ({ sourceId: item.detail.sourceId, detailId: item.detail.detailId, objectKey: item.objectKey, rawContentSha256: item.rawContentSha256 })), sourceChecks: input.sourceChecks, terminal: input.terminal, now: deps.clock(), transaction })); }
        catch { await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), putObjectKeys); return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: "AGENT_RUN_PERSIST_FAILED", retryable: true, category: "source" }, deadline }); }
        await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), persisted.cleanupObjectKeys); if (!persisted.completed) return "stale";
        // PostgreSQL queued state is authoritative; the shared queue wakes it immediately and reconciler repairs delivery failures.
        await triggerDeepMatchAfterDiscovery({ db: deps.db, id: deps.id, clock: deps.clock, queue: deps.matchingQueue, userId: job.userId, targetId: claimed.run.targetId, discoveryRunId: job.runId });
        await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "domain_commit_after", ordinal: 1 });
        return input.terminal === "source_failed" ? "failed" : "completed";
      };
      if (claimed.run.workflowVersion === "layered-public-job-discovery-v1") {
        const batchStart = await transition("batch_search", false); if (batchStart) return batchStart;
        let physicalOrdinal = 0;
        let budgetTerminatedByCheckpoint = false;
        let latestDiagnostics: readonly LayeredPublicWorkflowDiagnostic[] = [];
        const controller = layeredController!;
        const abortAtDeadline = setTimeout(() => { trustedStop = "budget_exhausted"; controller.abort(); }, Math.max(0, remainingBudget(deps.clock, deadline)));
        const persistHeartbeatControl = async (diagnostics: readonly LayeredPublicWorkflowDiagnostic[]): Promise<ProcessorOutcome | undefined> => {
          if (heartbeatControl !== "paused" && heartbeatControl !== "cancelled") return undefined;
          const control = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "heartbeat_control", ordinal: ++physicalOrdinal });
          if (control !== heartbeatControl) return control ?? "stale";
          try {
            await persistLayeredPublicOutcome(deps, {
              userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, now: deps.clock(), deadline,
              diagnostics, sourceIssues: [], sourcePostingVersionIds: [], trustedSourcePostingVersionIds: [], trustedSourceIds: [], complete: false, interrupted: heartbeatControl,
            });
          } catch (error) {
            return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline });
          }
          return heartbeatControl;
        };
        try {
          const workflowPromise = layeredWorkflow.run({
            userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, now: deps.clock(), executionSpec: layeredExecutionSpec, attemptCount: claimed.attemptCount, signal: controller.signal,
            onDiagnostics: (snapshot) => { latestDiagnostics = snapshot; },
            beforePhysicalOperation: async (operation) => {
              if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operation.identity)) throw new Error("LAYERED_PUBLIC_OPERATION_IDENTITY_INVALID");
              if (controller.signal.aborted) throw new LayeredPublicWorkflowInterruption(trustedStop ?? "stale");
              const identity = createHash("sha256").update(operation.identity).digest("hex").slice(0, 16);
              const reserve = operation.kind === "search" || operation.kind === "extract" || operation.kind === "fetch" ? { toolCalls: 1, sourceRequests: 1 } : undefined;
              const checkpointOutcome = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: `layered_${operation.kind}_${identity}`, ordinal: ++physicalOrdinal, reserve });
              if (checkpointOutcome) { trustedStop = checkpointOutcome as "paused" | "cancelled" | "budget_exhausted" | "stale"; budgetTerminatedByCheckpoint = trustedStop === "budget_exhausted"; controller.abort(); throw new LayeredPublicWorkflowInterruption(trustedStop); }
              if (controller.signal.aborted) throw new LayeredPublicWorkflowInterruption(trustedStop ?? "stale");
            },
          });
          const outcome = await bounded(deps.clock, deadline, () => workflowPromise);
          const heartbeatControl = await persistHeartbeatControl(outcome.diagnostics);
          if (heartbeatControl) return heartbeatControl;
          if (isLayeredPublicWorkflowInterruption(outcome) && trustedStop === outcome.interruption) {
            try { await persistLayeredPublicOutcome(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, now: deps.clock(), deadline: trustedStop === "budget_exhausted" ? cleanupDeadline(deps) : deadline, diagnostics: outcome.diagnostics, sourceIssues: [], sourcePostingVersionIds: [], trustedSourcePostingVersionIds: [], trustedSourceIds: [], complete: false, interrupted: trustedStop }); }
            catch (error) { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline }); }
            return outcome.interruption;
          }
          const branchOutcome = LayeredPublicWorkflowBranchOutcomeSchema.parse(outcome.branchOutcome);
          const branchSucceeded = branchOutcome.trusted === "succeeded" || branchOutcome.publicDiscovery === "verified" || branchOutcome.publicDiscovery === "clean_zero";
          if (!branchSucceeded) {
            const retryable = outcome.diagnostics.some((diagnostic) => diagnostic.retryable);
            // 可重试尝试只保留 attempt diagnostic；最终投递才冻结 run-level issue/attention，避免随后成功仍被旧问题污染终态。
            try { await persistLayeredPublicOutcome(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, now: deps.clock(), deadline, diagnostics: outcome.diagnostics, sourceIssues: [], sourcePostingVersionIds: [], trustedSourcePostingVersionIds: [], trustedSourceIds: [], complete: false }); }
            catch (error) { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline }); }
            return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: retryable ? "AGENT_RUN_ADAPTER_RETRYABLE" : "AGENT_RUN_ADAPTER_FAILED", retryable, category: "source" }, deadline, discoveryIssues: outcome.sourceIssues ?? [] });
          }
          const batchComplete = await transition("batch_search", true); if (batchComplete) return batchComplete;
          const detailsStart = await transition("fetch_details", false); if (detailsStart) return detailsStart;
          const detailsComplete = await transition("fetch_details", true); if (detailsComplete) return detailsComplete;
          const persistStart = await transition("persist_results", false); if (persistStart) return persistStart;
          const persisted = await persistLayeredPublicOutcome(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, now: deps.clock(), deadline, diagnostics: outcome.diagnostics, sourceIssues: outcome.sourceIssues ?? [], sourcePostingVersionIds: outcome.sourcePostingVersionIds ?? [], trustedSourcePostingVersionIds: outcome.trustedSourcePostingVersionIds ?? [], trustedSourceIds: layeredExecutionSpec.sourceScope.trustedSources.map(({ source }) => source.sourceId) });
          return persisted === "facts" ? "stale" : persisted;
        } catch (error) {
          const heartbeatControl = await persistHeartbeatControl(latestDiagnostics);
          if (heartbeatControl) return heartbeatControl;
          if (error instanceof AgentRunBudgetError) {
            trustedStop = "budget_exhausted";
            controller.abort();
            const terminal = budgetTerminatedByCheckpoint ? "budget_exhausted" : await failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline });
            if (terminal === "budget_exhausted") {
              try { await persistLayeredPublicOutcome(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, now: deps.clock(), deadline: cleanupDeadline(deps), diagnostics: latestDiagnostics, sourceIssues: [], sourcePostingVersionIds: [], trustedSourcePostingVersionIds: [], trustedSourceIds: [], complete: false, interrupted: "budget_exhausted" }); }
              catch { /* 预算终态已经落库；诊断补写不得把 run 留在运行中。 */ }
            }
            return terminal;
          }
          if (error instanceof LayeredPublicWorkflowStop) return error.outcome;
          if (error instanceof LayeredPublicWorkflowInterruption && trustedStop === error.outcome) return error.outcome;
          return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline });
        } finally { clearTimeout(abortAtDeadline); }
      }
      const snapshot = claimed.run.targetSnapshot as import("@job-copilot/contracts/agent-runs").AgentRunDetail["targetSnapshot"];
      let sourceScope: import("@job-copilot/contracts/agent-runs").AgentRunDetail["sourceScope"];
      try { sourceScope = normalizeAgentRunSourceScope(claimed.run.sourceScope); }
      catch (error) { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline }); }
      if (claimed.run.workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION) {
        const v3Scope = sourceScope as import("@job-copilot/contracts/agent-runs").PublicSourceHealthAgentRunSourceScope;
        const batchStart = await transition("batch_search", false); if (batchStart) return batchStart;
        const sourceStates: Array<{ source: typeof v3Scope.sources[number]; observedDetailIds: string[]; candidates: Array<{ sourceId: string; detailId: string }>; requestAttemptCount: number; failure?: Extract<import("@job-copilot/contracts/agent-runs").SourceHealthListResult, { ok: false }>["failure"] }> = [];
        try {
          for (const [index, source] of v3Scope.sources.entries()) {
            const called = await adapterCall("source_list", index + 1, () => sourceHealthAdapter.listSource({ targetSnapshot: snapshot, source }));
            if (called.outcome) return called.outcome;
            const list = parseSourceHealthListResult(called.value, source.sourceId);
            if (!list.ok) { sourceStates.push({ source, observedDetailIds: [], candidates: [], requestAttemptCount: list.failure.attemptCount, failure: list.failure }); continue; }
            sourceStates.push({ source, observedDetailIds: list.data.observedDetailIds, candidates: list.data.candidates.map((candidate) => ({ sourceId: candidate.sourceId, detailId: candidate.detailId })), requestAttemptCount: list.attemptCount });
          }
        } catch (error) { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline }); }
        const batchComplete = await transition("batch_search", true); if (batchComplete) return batchComplete;
        const detailsStart = await transition("fetch_details", false); if (detailsStart) return detailsStart;
        const details: Array<{ sourceId: string; detailId: string; company: string; title: string; location: string; postedAt: string; deadline: string | null; sourceType: "company_careers"; isOfficial: true; rawPayload: Record<string, unknown> }> = [];
        try {
          let detailOrdinal = 0;
          for (const state of sourceStates) {
            if (state.failure) continue;
            for (const candidate of state.candidates) {
              const called = await adapterCall("source_get_detail", ++detailOrdinal, () => sourceHealthAdapter.getSourceDetail({ source: state.source, detailId: candidate.detailId }));
              if (called.outcome) return called.outcome;
              const detail = parseSourceHealthDetailResult(called.value, candidate);
              if (!detail.ok) { state.requestAttemptCount += detail.failure.attemptCount; state.failure = detail.failure; break; }
              state.requestAttemptCount += detail.attemptCount;
              details.push(detail.data);
            }
          }
        } catch (error) { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline }); }
        const checks: JobSourceHealthCheck[] = sourceStates.map((state) => {
          const validDetailCount = details.filter((detail) => detail.sourceId === state.source.sourceId).length;
          const failure = state.failure;
          const status = !failure ? (validDetailCount === 0 ? "zero_valid_results" : "healthy") : failure.category;
          const detailFailure = state.observedDetailIds.length > 0;
          const impact = !failure ? { scope: "none" as const, affectedCount: null }
            : failure.category === "parser_degraded" && detailFailure ? { scope: "job_details" as const, affectedCount: state.candidates.length - validDetailCount }
              : { scope: "entire_source" as const, affectedCount: null };
          return {
            checkId: deps.id(), runId: claimed.run.id, targetId: claimed.run.targetId, watchlistItemId: state.source.watchlistItemId,
            sourceId: state.source.sourceId, status, reasonCodes: failure ? [failure.reasonCode] : [], impact,
            observedPostingCount: state.observedDetailIds.length, selectedDetailCount: state.candidates.length, validDetailCount,
            requestAttemptCount: state.requestAttemptCount, checkedAt: deps.clock().toISOString(),
          };
        });
        const detailsComplete = await transition("fetch_details", true); if (detailsComplete) return detailsComplete;
        const persistStart = await transition("persist_results", false); if (persistStart) return persistStart;
        const detailsForPersistence = details.slice(0, claimed.run.budgetSnapshot.maxResults);
        const terminal = deriveSourceHealthTerminal(checks);
        return persistDiscoveryOutcome({ details: detailsForPersistence, scans: sourceStates.map((state) => ({ sourceId: state.source.sourceId, observedDetailIds: state.observedDetailIds, complete: !state.failure })), sourceChecks: checks, terminal });
      }
      const batchStart = await transition("batch_search", false); if (batchStart) return batchStart;
      let summaries: Array<{ sourceId: string; detailId: string }>;
      let scans: Array<{ sourceId: string; observedDetailIds: string[]; complete: boolean }> = [];
      try {
        if (sourceScope.adapter === "fake") {
          const called = await adapterCall("source_search_batch", 1, () => adapter.searchBatch({ targetSnapshot: snapshot, sourceScope }));
          if (called.outcome) return called.outcome;
          const batch = DiscoveryBatchSearchResultSchema.parse(called.value);
          if (!batch.ok) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: batch.error.retryable ? "AGENT_RUN_ADAPTER_RETRYABLE" : "AGENT_RUN_ADAPTER_FAILED", retryable: batch.error.retryable, category: "source" }, deadline });
          if (batch.data.length > AGENT_RUN_BUDGET.maxResults || batch.data.some((item) => !sourceScope.sources.includes(item.sourceId))) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: "AGENT_RUN_ADAPTER_FAILED", retryable: false, category: "source" }, deadline });
          summaries = batch.data;
        } else {
          const publicScope = sourceScope as import("@job-copilot/contracts/agent-runs").PublicAgentRunSourceScope;
          const ordinals = new Map(publicScope.sources.map((source, index) => [source.sourceId, index + 1]));
          const batch = PublicDiscoveryBatchSearchResultSchema.parse(await bounded(deps.clock, deadline, () => adapter.searchBatch({ targetSnapshot: snapshot, sourceScope: publicScope, beforeList: async (sourceId: string) => {
            const ordinal = ordinals.get(sourceId);
            if (!ordinal) throw new Error("AGENT_RUN_ADAPTER_FAILED");
            const outcome = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "source_search_batch", ordinal, reserve: { toolCalls: 1, sourceRequests: 1 } });
            if (outcome) throw new PublicListCheckpointStop(outcome);
          } })));
          if (!batch.ok) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: batch.error.retryable ? "AGENT_RUN_ADAPTER_RETRYABLE" : "AGENT_RUN_ADAPTER_FAILED", retryable: batch.error.retryable, category: "source" }, deadline });
          const sourceIds = new Set(publicScope.sources.map((source) => source.sourceId));
          if (batch.data.items.some((item) => !sourceIds.has(item.sourceId)) || batch.data.scans.some((scan) => !sourceIds.has(scan.sourceId))) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: "AGENT_RUN_ADAPTER_FAILED", retryable: false, category: "source" }, deadline });
          summaries = batch.data.items;
          scans = batch.data.scans;
        }
      } catch (error) {
        if (error instanceof PublicListCheckpointStop) return error.outcome;
        return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline });
      }
      const batchComplete = await transition("batch_search", true); if (batchComplete) return batchComplete;
      const detailsStart = await transition("fetch_details", false); if (detailsStart) return detailsStart;
      const details: Array<{ sourceId: string; detailId: string; company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; sourceType: string; isOfficial: boolean; rawPayload: Record<string, unknown> }> = [];
      const uniqueSummaries = [...new Map(summaries.map((result) => [discoverySourceIdentifier(result.sourceId, result.detailId), result])).values()];
      for (const result of uniqueSummaries) {
        let detail: import("@job-copilot/contracts/agent-runs").DiscoveryDetailResult;
        try {
          const called = await adapterCall("source_get_detail", details.length + 1, () => adapter.getDetail({ sourceId: result.sourceId, detailId: result.detailId }));
          if (called.outcome) return called.outcome;
          detail = DiscoveryDetailResultSchema.parse(called.value);
        } catch (error) { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline }); }
        if (!detail.ok) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: detail.error.retryable ? "AGENT_RUN_ADAPTER_RETRYABLE" : "AGENT_RUN_ADAPTER_FAILED", retryable: detail.error.retryable, category: "source" }, deadline });
        const allowed = sourceScope.adapter === "fake" ? sourceScope.sources.includes(detail.data.sourceId) : sourceScope.sources.some((source) => source.sourceId === detail.data.sourceId);
        if (detail.data.sourceId !== result.sourceId || detail.data.detailId !== result.detailId || !allowed) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: "AGENT_RUN_ADAPTER_FAILED", retryable: false, category: "source" }, deadline });
        details.push(detail.data);
      }
      const detailsComplete = await transition("fetch_details", true); if (detailsComplete) return detailsComplete;
      const persistStart = await transition("persist_results", false); if (persistStart) return persistStart;
      return persistDiscoveryOutcome({ details, scans });
      } finally {
        await stopHeartbeat().catch(() => undefined);
      }
    },
  };
}
