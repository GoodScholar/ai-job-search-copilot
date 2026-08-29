import { createHash } from "node:crypto";
import { and, asc, desc, eq, lte, or, sql } from "drizzle-orm";
import {
  agentInboxItems, agentRunEvents, agentRunJobResults, agentRunSteps, agentRunUsageEntries, agentRuns, jobOpportunities, jobSourcePostings, jobSourcePostingVersions,
  type Database,
} from "@job-copilot/database";
import {
  AGENT_RUN_BUDGET, AGENT_RUN_JOB_VERSION, DiscoveryBatchSearchResultSchema, DiscoveryDetailResultSchema,
  type AgentRunJob,
} from "@job-copilot/contracts/agent-runs";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { discoveryNormalizedData, persistJobOpportunity } from "./job-opportunity-persistence";
import { decideRetry } from "./agent-run-state";
import { agentRunUsageSnapshot, appendBudgetFacts, settleActiveSlice, terminateBudgetRun, type BudgetDimension } from "./agent-run-lifecycle";
import type { AgentRunCheckpoint } from "./agent-run-checkpoint";

export interface DiscoveryContentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "application/json"; runId: string }): Promise<void>;
  delete(input: { objectKey: string }): Promise<void>;
}

export interface JobDiscoveryAdapter {
  search(input: import("@job-copilot/contracts/agent-runs").DiscoverySearchInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoverySearchResult>;
  searchBatch(input: import("@job-copilot/contracts/agent-runs").DiscoveryBatchSearchInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoveryBatchSearchResult>;
  getDetail(input: import("@job-copilot/contracts/agent-runs").DiscoveryDetailInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoveryDetailResult>;
}

/** Resolves the adapter strictly from the immutable run execution spec. */
export interface JobDiscoveryAdapterResolver {
  resolve(input: { runId: string; idempotencyKey: string; adapter: string; adapterVersion: string; attemptCount: number }): JobDiscoveryAdapter;
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
export function discoverySourceIdentifier(sourceId: string, detailId: string): string { return canonicalJsonSha256({ sourceId, detailId }); }

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
        await transaction.execute(sql.raw(`set local transaction_timeout = ${Math.max(1, Math.floor(remaining))}`));
        await transaction.execute(sql.raw(`set local statement_timeout = ${Math.max(1, Math.floor(remaining))}`));
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
  checkpoint: AgentRunCheckpoint;
  contentStore: DiscoveryContentStore;
  auditTrail: AuditTrail;
  id: () => string;
  clock: () => Date;
  cleanupTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatStopTimeoutMs?: number;
  heartbeatRenew?: (input: { userId: string; runId: string; claimToken: string; deadline: Date }) => Promise<boolean>;
};
type FailureCode = "AGENT_RUN_ADAPTER_RETRYABLE" | "AGENT_RUN_ADAPTER_FAILED" | "AGENT_RUN_CONTENT_STORAGE_FAILED" | "AGENT_RUN_PERSIST_FAILED" | "AGENT_RUN_BUDGET_EXCEEDED";
type NonBudgetFailureCode = Exclude<FailureCode, "AGENT_RUN_BUDGET_EXCEEDED">;
const CLEANUP_TIMEOUT_MS = 1_000;
class AgentRunBudgetError extends Error {
  constructor(public readonly budgetDimension: BudgetDimension) { super("AGENT_RUN_BUDGET_EXCEEDED"); }
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
    const timeout = Math.max(1, Math.floor(remaining));
    // PostgreSQL 17 的 transaction_timeout 覆盖整个事务，statement/lock timeout 覆盖单次慢语句和锁等待。
    await connection.execute(sql.raw(`set local transaction_timeout = ${timeout}`));
    await connection.execute(sql.raw(`set local statement_timeout = ${timeout}`));
    await connection.execute(sql.raw(`set local lock_timeout = ${timeout}`));
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

async function renewClaim(deps: AgentRunProcessorDependencies, input: { userId: string; runId: string; claimToken: string; deadline: Date }): Promise<boolean> {
  const [renewed] = await runTransaction<Array<{ id: string }>>(deps, input.deadline, async (transaction) => {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const now = deps.clock();
    if (remainingBudget(deps.clock, input.deadline) <= 0) throw new AgentRunBudgetError("active_duration");
    const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.claimToken)));
    if (!run) return [];
    const elapsed = await settleActiveSlice(transaction, { id: deps.id, userId: input.userId, run, now });
    const activeDurationMs = run.activeDurationMs + elapsed;
    const version = elapsed > 0 ? run.version + 1 : run.version;
    const updated = await transaction.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() + 30_000), activeDurationMs, activeSliceStartedAt: now, version, updatedAt: now })
      .where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.claimToken))).returning({ id: agentRuns.id });
    if (updated[0] && elapsed > 0) await appendBudgetFacts(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: input.userId, requestId: input.runId, runId: input.runId, version, currentStep: run.currentStep, usage: agentRunUsageSnapshot(run, { activeDurationMs }), consumed: { activeDurationMs: elapsed, toolCalls: 0, sourceRequests: 0, modelCalls: 0 }, now });
    return updated;
  });
  return Boolean(renewed);
}

function startClaimHeartbeat(deps: AgentRunProcessorDependencies, input: { userId: string; runId: string; claimToken: string; deadline: Date }) {
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const tick = () => {
    if (stopped || inFlight) return;
    const renew = deps.heartbeatRenew ?? ((renewInput) => renewClaim(deps, renewInput));
    inFlight = renew(input).then(() => undefined, () => undefined).finally(() => { inFlight = undefined; });
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

async function persistDiscoverySource(db: any, input: { id: () => string; userId: string; detail: { sourceId: string; detailId: string; sourceType: string; isOfficial: boolean }; contentSha256: string; rawContentSha256: string; objectKey: string; now: Date }) {
  const sourceIdentifier = discoverySourceIdentifier(input.detail.sourceId, input.detail.detailId);
  let [posting] = await db.select({ id: jobSourcePostings.id, isOfficial: jobSourcePostings.isOfficial }).from(jobSourcePostings).where(and(eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.sourceType, input.detail.sourceType), eq(jobSourcePostings.sourceIdentifier, sourceIdentifier)));
  if (!posting) {
    const [created] = await db.insert(jobSourcePostings).values({ id: input.id(), userId: input.userId, sourceType: input.detail.sourceType, sourceIdentifier, sourceIdentity: { sourceId: input.detail.sourceId, detailId: input.detail.detailId }, isOfficial: input.detail.isOfficial, createdAt: input.now, updatedAt: input.now }).returning({ id: jobSourcePostings.id, isOfficial: jobSourcePostings.isOfficial });
    if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
    posting = created;
  }
  // 摘要字段相同不足以证明来源正文未变；两个内容指纹共同定义不可变版本身份。
  let [version] = await db.select({ id: jobSourcePostingVersions.id, version: jobSourcePostingVersions.version }).from(jobSourcePostingVersions).where(and(
    eq(jobSourcePostingVersions.userId, input.userId),
    eq(jobSourcePostingVersions.sourcePostingId, posting.id),
    eq(jobSourcePostingVersions.contentSha256, input.contentSha256),
    eq(jobSourcePostingVersions.rawContentSha256, input.rawContentSha256),
  ));
  let sourceVersionCreated = false;
  if (!version) {
    const [latest] = await db.select({ version: jobSourcePostingVersions.version }).from(jobSourcePostingVersions).where(and(eq(jobSourcePostingVersions.userId, input.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id))).orderBy(desc(jobSourcePostingVersions.version)).limit(1);
    const [created] = await db.insert(jobSourcePostingVersions).values({ id: input.id(), userId: input.userId, sourcePostingId: posting.id, version: (latest?.version ?? 0) + 1, contentSha256: input.contentSha256, rawContentSha256: input.rawContentSha256, rawObjectReference: { objectKey: input.objectKey }, retrievedAt: input.now, createdAt: input.now }).returning({ id: jobSourcePostingVersions.id });
    if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
    version = created;
    sourceVersionCreated = true;
  }
  return { sourcePostingId: posting.id, sourcePostingVersionId: version.id, isOfficial: posting.isOfficial || input.detail.isOfficial, sourceVersionCreated };
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

async function failOrRetry(deps: AgentRunProcessorDependencies, input: { userId: string; runId: string; claimToken: string; attemptCount: number; failure: Failure; deadline: Date }): Promise<"retry" | "budget_exhausted" | "failed" | "stale"> {
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
      await terminateBudgetRun(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: input.userId, requestId: input.runId, run, now, budgetDimension: decision.budgetDimension, activeDurationMs });
      return "budget_exhausted";
    }
    const terminationKind = failureCode === "AGENT_RUN_CONTENT_STORAGE_FAILED" ? "content_storage_failed" : failureCode === "AGENT_RUN_PERSIST_FAILED" ? "persistence_failed" : "source_failed";
    await transaction.update(agentRuns).set({ status: "failed", currentStep: "failed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, activeDurationMs, failureCode, terminationKind, terminationBudgetDimension: null, failedAt: now, version, updatedAt: now }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.claimToken, input.claimToken)));
    const sequence = await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: input.attemptCount, failureCode }, now });
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

export function createAgentRunProcessor(deps: AgentRunProcessorDependencies): { process(job: AgentRunJob & { finalAttempt?: boolean }): Promise<ProcessorOutcome> } {
  return {
    async process(job) {
      const now = deps.clock();
      const deadline = new Date(now.getTime() + AGENT_RUN_BUDGET.maxActiveDurationMs);
      const claimed = await runTransaction(deps, deadline, async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, job.userId);
        const claimNow = deps.clock();
        if (remainingBudget(deps.clock, deadline) <= 0) throw new AgentRunBudgetError("active_duration");
        let [current] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        if (!current || current.status === "completed") return { kind: "stale" as const };
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
      const checkpoint = deps.checkpoint;
      const claimOutcome = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "claim", ordinal: 1 });
      if (claimOutcome) return claimOutcome;
      let adapter: JobDiscoveryAdapter;
      try {
        adapter = deps.adapterResolver.resolve({
          runId: claimed.run.id,
          idempotencyKey: claimed.run.idempotencyKey,
          adapter: claimed.run.adapter,
          adapterVersion: claimed.run.adapterVersion,
          attemptCount: claimed.attemptCount,
        });
      } catch (error) {
        return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline });
      }
      const stopHeartbeat = startClaimHeartbeat(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, deadline });
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
      const snapshot = claimed.run.targetSnapshot as import("@job-copilot/contracts/agent-runs").AgentRunDetail["targetSnapshot"];
      const batchStart = await transition("batch_search", false); if (batchStart) return batchStart;
      let batch: import("@job-copilot/contracts/agent-runs").DiscoveryBatchSearchResult;
      try {
        const called = await adapterCall("source_search_batch", 1, () => adapter.searchBatch({ targetSnapshot: snapshot, sourceScope: claimed.run.sourceScope as import("@job-copilot/contracts/agent-runs").AgentRunDetail["sourceScope"] }));
        if (called.outcome) return called.outcome;
        batch = DiscoveryBatchSearchResultSchema.parse(called.value);
      } catch (error) { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline }); }
      if (!batch.ok) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: batch.error.retryable ? "AGENT_RUN_ADAPTER_RETRYABLE" : "AGENT_RUN_ADAPTER_FAILED", retryable: batch.error.retryable, category: "source" }, deadline });
      if (batch.data.length > AGENT_RUN_BUDGET.maxResults || batch.data.some((item) => !(claimed.run.sourceScope as { sources: string[] }).sources.includes(item.sourceId))) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: "AGENT_RUN_ADAPTER_FAILED", retryable: false, category: "source" }, deadline });
      const batchComplete = await transition("batch_search", true); if (batchComplete) return batchComplete;
      const detailsStart = await transition("fetch_details", false); if (detailsStart) return detailsStart;
      const details: Array<{ sourceId: string; detailId: string; company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; sourceType: string; isOfficial: boolean; rawPayload: Record<string, unknown> }> = [];
      const uniqueSummaries = [...new Map(batch.data.map((result) => [discoverySourceIdentifier(result.sourceId, result.detailId), result])).values()];
      for (const result of uniqueSummaries) {
        let detail: import("@job-copilot/contracts/agent-runs").DiscoveryDetailResult;
        try {
          const called = await adapterCall("source_get_detail", details.length + 1, () => adapter.getDetail({ sourceId: result.sourceId, detailId: result.detailId }));
          if (called.outcome) return called.outcome;
          detail = DiscoveryDetailResultSchema.parse(called.value);
        } catch (error) { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: adapterFailure(error), deadline }); }
        if (!detail.ok) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: detail.error.retryable ? "AGENT_RUN_ADAPTER_RETRYABLE" : "AGENT_RUN_ADAPTER_FAILED", retryable: detail.error.retryable, category: "source" }, deadline });
        if (detail.data.sourceId !== result.sourceId || detail.data.detailId !== result.detailId || !(claimed.run.sourceScope as { sources: string[] }).sources.includes(detail.data.sourceId)) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: "AGENT_RUN_ADAPTER_FAILED", retryable: false, category: "source" }, deadline });
        details.push(detail.data);
      }
      const detailsComplete = await transition("fetch_details", true); if (detailsComplete) return detailsComplete;
      const persistStart = await transition("persist_results", false); if (persistStart) return persistStart;
      const stored = details.map((detail) => {
        const bytes = canonicalJsonBytes(detail.rawPayload);
        const sourceIdentifier = discoverySourceIdentifier(detail.sourceId, detail.detailId);
        const rawContentSha256 = createHash("sha256").update(bytes).digest("hex");
        return { detail, bytes, sourceIdentifier, rawContentSha256, objectKey: `accounts/${job.userId}/agent-runs/${job.runId}/sources/${sourceIdentifier}/${claimed.claimToken}/${rawContentSha256}.json` };
      });
      const putObjectKeys: string[] = [];
      try {
        for (const item of stored) {
          putObjectKeys.push(item.objectKey);
          const put = deps.contentStore.put({ objectKey: item.objectKey, bytes: item.bytes, mediaType: "application/json", runId: job.runId });
          try { await bounded(deps.clock, deadline, () => put); } catch (error) {
            void put.then(
              () => removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), [item.objectKey]),
              () => removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), [item.objectKey]),
            ).catch(() => undefined);
            throw error;
          }
          const writeOutcome = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "object_write", ordinal: putObjectKeys.length });
          if (writeOutcome) {
            await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), putObjectKeys);
            return writeOutcome;
          }
        }
      } catch (error) { await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), putObjectKeys); return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: error instanceof AgentRunBudgetError ? "AGENT_RUN_BUDGET_EXCEEDED" : "AGENT_RUN_CONTENT_STORAGE_FAILED", retryable: !(error instanceof AgentRunBudgetError), category: "source", budgetDimension: error instanceof AgentRunBudgetError ? error.budgetDimension : undefined }, deadline }); }
      const commitBefore = await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "domain_commit_before", ordinal: 1 });
      if (commitBefore) { await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), putObjectKeys); return commitBefore; }
      try {
        const completed = await runTransaction(deps, deadline, async (transaction) => {
          const completedAt = deps.clock();
          await acquireAccountAdvisoryLock(transaction, job.userId);
          const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, claimed.claimToken), eq(agentRuns.controlState, "none")));
          if (!run) return { completed: false, cleanup: putObjectKeys };
          const elapsed = await settleActiveSlice(transaction, { id: deps.id, userId: job.userId, run, now: completedAt });
          const cleanup: string[] = [];
          for (const [index, item] of stored.entries()) {
            const source = await persistDiscoverySource(transaction, { id: deps.id, userId: job.userId, detail: item.detail, contentSha256: canonicalJsonSha256({ sourceId: item.detail.sourceId, detailId: item.detail.detailId, company: item.detail.company, title: item.detail.title, location: item.detail.location, postedAt: item.detail.postedAt, deadline: item.detail.deadline, sourceType: item.detail.sourceType, isOfficial: item.detail.isOfficial }), rawContentSha256: item.rawContentSha256, objectKey: item.objectKey, now: completedAt });
            if (!source.sourceVersionCreated) cleanup.push(item.objectKey);
            const evidence = await persistJobOpportunity(transaction, { id: deps.id, userId: job.userId, importId: null, sourcePostingVersionId: source.sourcePostingVersionId, isOfficial: source.isOfficial, company: item.detail.company, title: item.detail.title, location: item.detail.location, postedAt: item.detail.postedAt, deadline: item.detail.deadline, description: null, normalizedData: discoveryNormalizedData(item.detail), now: completedAt });
            await transaction.insert(agentRunJobResults).values({ id: deps.id(), userId: job.userId, runId: job.runId, opportunityId: evidence.opportunityId, sourcePostingVersionId: source.sourcePostingVersionId, ordinal: index + 1, createdAt: completedAt });
            await transaction.insert(agentRunUsageEntries).values({ id: deps.id(), userId: job.userId, runId: job.runId, usageKey: `${claimed.claimToken}:result:${index + 1}`, category: "result", amount: 1, stepKey: "persist_results", attemptCount: claimed.attemptCount, createdAt: completedAt }).onConflictDoNothing();
          }
          const resultCount = run.resultCount + stored.length;
          const activeDurationMs = run.activeDurationMs + elapsed;
          const budgetChanged = elapsed > 0 || stored.length > 0;
          const budgetVersion = budgetChanged ? run.version + 1 : run.version;
          if (budgetChanged) {
            const usage = agentRunUsageSnapshot(run, { activeDurationMs, resultCount });
            await transaction.update(agentRuns).set({ activeDurationMs, resultCount, version: budgetVersion, updatedAt: completedAt }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.claimToken, claimed.claimToken), eq(agentRuns.controlState, "none")));
            await appendBudgetFacts(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: job.userId, requestId: job.runId, runId: job.runId, version: budgetVersion, currentStep: "persist_results", usage, consumed: { activeDurationMs: elapsed, toolCalls: 0, sourceRequests: 0, modelCalls: 0 }, now: completedAt });
          }
          const stepVersion = budgetVersion + 1;
          await transaction.update(agentRunSteps).set({ status: "completed", completedAt }).where(and(eq(agentRunSteps.userId, job.userId), eq(agentRunSteps.runId, job.runId), eq(agentRunSteps.stepKey, "persist_results")));
          await transaction.update(agentRuns).set({ currentStep: "persist_results", version: stepVersion, updatedAt: completedAt }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.claimToken, claimed.claimToken), eq(agentRuns.controlState, "none")));
          await appendEvent(transaction, { id: deps.id, userId: job.userId, runId: job.runId, version: stepVersion, eventType: "step.completed", data: { eventType: "step.completed", status: "running", currentStep: "persist_results", stepKey: "persist_results", attemptCount: claimed.attemptCount }, now: completedAt });
          const terminalVersion = stepVersion + 1;
          await transaction.update(agentRuns).set({ status: "completed", currentStep: "completed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, activeDurationMs, completedAt, failureCode: null, terminationKind: "completed", terminationBudgetDimension: null, resultCount, version: terminalVersion, updatedAt: completedAt }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.claimToken, claimed.claimToken), eq(agentRuns.controlState, "none")));
          await appendEvent(transaction, { id: deps.id, userId: job.userId, runId: job.runId, version: terminalVersion, eventType: "run.completed", data: { eventType: "run.completed", status: "completed", currentStep: "completed", attemptCount: claimed.attemptCount, resultCount }, now: completedAt });
          await deps.auditTrail.bind(transaction).append({ userId: job.userId, actorUserId: job.userId, eventType: "agent.run_completed", occurredAt: completedAt, requestId: job.runId, outcome: "success", reasonCode: "AGENT_RUN_COMPLETED", resourceType: "agent_run", resourceId: job.runId, metadata: { runId: job.runId, targetId: run.targetId, attemptCount: claimed.attemptCount, resultCount } });
          return { completed: true, cleanup };
        });
        await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), completed.cleanup);
        if (!completed.completed) return "stale";
        // A completed run has no active claim, so this final durable boundary is
        // intentionally observational and cannot turn the committed result stale.
        await checkPoint(checkpoint, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, operation: "domain_commit_after", ordinal: 1 });
        return "completed";
      } catch { await removeBestEffort(deps.contentStore, deps.clock, cleanupDeadline(deps), putObjectKeys); return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, failure: { failureCode: "AGENT_RUN_PERSIST_FAILED", retryable: true, category: "source" }, deadline }); }
      } finally {
        await stopHeartbeat().catch(() => undefined);
      }
    },
  };
}
