import { createHash } from "node:crypto";
import { and, asc, desc, eq, lte, or } from "drizzle-orm";
import {
  agentRunEvents, agentRunJobResults, agentRunSteps, agentRuns, jobOpportunities, jobSourcePostings,
  jobSourcePostingVersions, jobTargetRevisions, jobTargets, type Database,
} from "@job-copilot/database";
import {
  AGENT_RUN_BUDGET, AGENT_RUN_JOB_VERSION, FAKE_JOB_DISCOVERY_ADAPTER, FAKE_JOB_DISCOVERY_ADAPTER_VERSION,
  FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, FAKE_JOB_DISCOVERY_SOURCE_IDS, FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
  StartAgentRunCommandSchema, type AgentRunDetail, type AgentRunJob, type StartAgentRunCommand, type StartAgentRunResponse,
} from "@job-copilot/contracts/agent-runs";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { discoveryNormalizedData, persistJobOpportunity } from "./job-opportunity-persistence";

export interface AgentRunQueue { enqueue(job: AgentRunJob): Promise<void>; }
export interface DiscoveryContentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "application/json"; runId: string }): Promise<void>;
  delete(input: { objectKey: string }): Promise<void>;
}

export interface JobDiscoveryAdapter {
  search(input: import("@job-copilot/contracts/agent-runs").DiscoverySearchInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoverySearchResult>;
  searchBatch(input: import("@job-copilot/contracts/agent-runs").DiscoveryBatchSearchInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoveryBatchSearchResult>;
  getDetail(input: import("@job-copilot/contracts/agent-runs").DiscoveryDetailInput): Promise<import("@job-copilot/contracts/agent-runs").DiscoveryDetailResult>;
}

export class AgentRunError extends Error {
  constructor(public readonly code: "AGENT_RUN_TARGET_NOT_FOUND") { super(code); }
}

type CommandDependencies = { db: Database; queue: AgentRunQueue; auditTrail: AuditTrail; id: () => string; clock: () => Date };
const sourceScope = { kind: "company_watchlist", adapter: FAKE_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION, sources: FAKE_JOB_DISCOVERY_SOURCE_IDS } as const;
const stepKeys = ["batch_search", "fetch_details", "persist_results"] as const;

type RunRow = typeof agentRuns.$inferSelect;

function summary(row: RunRow, reused: boolean): StartAgentRunResponse {
  return {
    runId: row.id, targetId: row.targetId, targetVersion: row.targetVersion,
    targetSnapshot: row.targetSnapshot as StartAgentRunResponse["targetSnapshot"], sourceScope: row.sourceScope as StartAgentRunResponse["sourceScope"],
    workflowVersion: row.workflowVersion as StartAgentRunResponse["workflowVersion"], adapter: row.adapter as StartAgentRunResponse["adapter"],
    adapterVersion: row.adapterVersion as StartAgentRunResponse["adapterVersion"], outputSchemaVersion: row.outputSchemaVersion as StartAgentRunResponse["outputSchemaVersion"],
    budget: row.budgetSnapshot as StartAgentRunResponse["budget"], status: row.status as StartAgentRunResponse["status"], currentStep: row.currentStep as StartAgentRunResponse["currentStep"],
    version: row.version, attemptCount: row.attemptCount, failureCode: row.failureCode as StartAgentRunResponse["failureCode"],
    queuedAt: row.queuedAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(), reused,
  };
}

function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, jsonValue(item)]));
  return value;
}

/** 用稳定字节串保存外部原始对象，避免 JSON 键顺序造成伪版本。 */
export function canonicalJsonBytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(jsonValue(value))); }
export function canonicalJsonSha256(value: unknown): string { return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex"); }

export function createAgentRunCommands(deps: CommandDependencies): {
  start(input: { userId: string; requestId: string; command: StartAgentRunCommand }): Promise<StartAgentRunResponse>;
} {
  return {
    async start(input) {
      const command = StartAgentRunCommandSchema.parse(input.command);
      const now = deps.clock();
      let reused = false;
      const run = await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [existing] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.idempotencyKey, command.idempotencyKey)));
        if (existing) { reused = true; return existing; }
        const [target] = await transaction.select({ id: jobTargets.id, version: jobTargets.version, priority: jobTargets.priority, state: jobTargets.state, constraints: jobTargetRevisions.constraints })
          .from(jobTargets).innerJoin(jobTargetRevisions, and(eq(jobTargetRevisions.userId, jobTargets.userId), eq(jobTargetRevisions.targetId, jobTargets.id), eq(jobTargetRevisions.version, jobTargets.version)))
          .where(and(eq(jobTargets.userId, input.userId), eq(jobTargets.id, command.targetId), eq(jobTargets.state, "active")));
        if (!target) throw new AgentRunError("AGENT_RUN_TARGET_NOT_FOUND");
        const runId = deps.id();
        const targetSnapshot = { targetId: target.id, version: target.version, priority: target.priority, state: target.state, constraints: target.constraints };
        const [created] = await transaction.insert(agentRuns).values({
          id: runId, userId: input.userId, targetId: target.id, idempotencyKey: command.idempotencyKey, targetVersion: target.version,
          targetSnapshot, sourceScope, budgetSnapshot: AGENT_RUN_BUDGET, workflowVersion: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION,
          adapter: FAKE_JOB_DISCOVERY_ADAPTER, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: FAKE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
          status: "queued", currentStep: "queued", version: 1, attemptCount: 0, queuedAt: now, createdAt: now, updatedAt: now,
        }).returning();
        if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
        await transaction.insert(agentRunSteps).values(stepKeys.map((stepKey, index) => ({ id: deps.id(), userId: input.userId, runId, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
        await transaction.insert(agentRunEvents).values({ id: deps.id(), userId: input.userId, runId, sequence: 1, runVersion: 1, eventType: "run.queued", data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 }, createdAt: now });
        await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_queued", occurredAt: now, requestId: input.requestId, outcome: "success", reasonCode: "AGENT_RUN_QUEUED", resourceType: "agent_run", resourceId: runId, metadata: { runId, targetId: target.id, targetVersion: target.version, workflowVersion: FAKE_JOB_DISCOVERY_WORKFLOW_VERSION, adapterVersion: FAKE_JOB_DISCOVERY_ADAPTER_VERSION } });
        return created;
      });
      const response = summary(run, reused);
      try { await deps.queue.enqueue({ version: AGENT_RUN_JOB_VERSION, runId: response.runId, userId: input.userId }); } catch { /* 提交后的唤醒可由恢复扫描补偿。 */ }
      return response;
    },
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
  const base = summary(run, false);
  return { ...base, steps: steps.map((step) => ({ stepKey: step.stepKey as AgentRunDetail["steps"][number]["stepKey"], ordinal: step.ordinal, status: step.status as AgentRunDetail["steps"][number]["status"], attemptCount: step.attemptCount, startedAt: step.startedAt?.toISOString() ?? null, completedAt: step.completedAt?.toISOString() ?? null, failedAt: step.failedAt?.toISOString() ?? null, failureCode: step.failureCode as AgentRunDetail["steps"][number]["failureCode"] })), events: events.map((event) => ({ sequence: event.sequence, runVersion: event.runVersion, eventType: event.eventType as AgentRunDetail["events"][number]["eventType"], data: event.data as AgentRunDetail["events"][number]["data"], createdAt: event.createdAt.toISOString() })), results: results.map((result) => ({ ...result, postedAt: result.postedAt?.toISOString() ?? null, deadline: result.deadline?.toISOString() ?? null })) };
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

export function createAgentRunRecoveryQueries(deps: { db: Database; clock: () => Date }): {
  listRecoverable(): Promise<AgentRunJob[]>;
} {
  return {
    async listRecoverable() {
      const now = deps.clock();
      const rows = await deps.db.select({ runId: agentRuns.id, userId: agentRuns.userId }).from(agentRuns)
        .where(or(eq(agentRuns.status, "queued"), and(eq(agentRuns.status, "running"), lte(agentRuns.claimExpiresAt, now))))
        .orderBy(asc(agentRuns.queuedAt), asc(agentRuns.id));
      return rows.map((row) => ({ version: AGENT_RUN_JOB_VERSION, runId: row.runId, userId: row.userId }));
    },
  };
}

type ProcessorDependencies = { db: Database; adapter: JobDiscoveryAdapter; contentStore: DiscoveryContentStore; auditTrail: AuditTrail; id: () => string; clock: () => Date };
type FailureCode = "AGENT_RUN_ADAPTER_RETRYABLE" | "AGENT_RUN_ADAPTER_FAILED" | "AGENT_RUN_CONTENT_STORAGE_FAILED" | "AGENT_RUN_PERSIST_FAILED" | "AGENT_RUN_BUDGET_EXCEEDED";

async function appendEvent(db: any, input: { id: () => string; userId: string; runId: string; version: number; eventType: string; data: Record<string, unknown>; now: Date }) {
  const [latest] = await db.select({ sequence: agentRunEvents.sequence }).from(agentRunEvents).where(and(eq(agentRunEvents.userId, input.userId), eq(agentRunEvents.runId, input.runId))).orderBy(desc(agentRunEvents.sequence)).limit(1);
  await db.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: input.runId, sequence: (latest?.sequence ?? 0) + 1, runVersion: input.version, eventType: input.eventType, data: input.data, createdAt: input.now });
}

async function persistDiscoverySource(db: any, input: { id: () => string; userId: string; detail: { sourceId: string; detailId: string; sourceType: string; isOfficial: boolean }; contentSha256: string; rawContentSha256: string; objectKey: string; now: Date }) {
  const sourceIdentifier = `${input.detail.sourceId}:${input.detail.detailId}`;
  let [posting] = await db.select({ id: jobSourcePostings.id, isOfficial: jobSourcePostings.isOfficial }).from(jobSourcePostings).where(and(eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.sourceType, input.detail.sourceType), eq(jobSourcePostings.sourceIdentifier, sourceIdentifier)));
  if (!posting) {
    const [created] = await db.insert(jobSourcePostings).values({ id: input.id(), userId: input.userId, sourceType: input.detail.sourceType, sourceIdentifier, sourceIdentity: { sourceId: input.detail.sourceId, detailId: input.detail.detailId }, isOfficial: input.detail.isOfficial, createdAt: input.now, updatedAt: input.now }).returning({ id: jobSourcePostings.id, isOfficial: jobSourcePostings.isOfficial });
    if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
    posting = created;
  }
  let [version] = await db.select({ id: jobSourcePostingVersions.id, version: jobSourcePostingVersions.version }).from(jobSourcePostingVersions).where(and(eq(jobSourcePostingVersions.userId, input.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id), eq(jobSourcePostingVersions.contentSha256, input.contentSha256)));
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

async function stepTransition(deps: ProcessorDependencies, input: { userId: string; runId: string; claimToken: string; stepKey: typeof stepKeys[number]; complete: boolean; attemptCount: number }) {
  const now = deps.clock();
  return deps.db.transaction(async (transaction) => {
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

async function failOrRetry(deps: ProcessorDependencies, input: { userId: string; runId: string; claimToken: string; attemptCount: number; finalAttempt: boolean; failureCode: FailureCode }): Promise<"retry" | "failed" | "stale"> {
  const now = deps.clock();
  return deps.db.transaction(async (transaction) => {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.claimToken)));
    if (!run) return "stale";
    const terminal = input.finalAttempt || input.attemptCount >= AGENT_RUN_BUDGET.maxAttempts || input.failureCode !== "AGENT_RUN_ADAPTER_RETRYABLE";
    const version = run.version + 1;
    if (!terminal) {
      await transaction.update(agentRunSteps).set({ status: "pending", startedAt: null, completedAt: null, failedAt: null, failureCode: null }).where(and(eq(agentRunSteps.userId, input.userId), eq(agentRunSteps.runId, input.runId)));
      await transaction.update(agentRuns).set({ status: "queued", claimToken: null, claimExpiresAt: null, startedAt: null, completedAt: null, failedAt: null, failureCode: null, version, updatedAt: now }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.claimToken, input.claimToken)));
      await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.retry_scheduled", data: { eventType: "run.retry_scheduled", status: "queued", currentStep: run.currentStep, attemptCount: input.attemptCount, failureCode: input.failureCode }, now });
      return "retry";
    }
    await transaction.update(agentRuns).set({ status: "failed", currentStep: "failed", claimToken: null, claimExpiresAt: null, failureCode: input.failureCode, failedAt: now, version, updatedAt: now }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.claimToken, input.claimToken)));
    await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: input.attemptCount, failureCode: input.failureCode }, now });
    await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_failed", occurredAt: now, requestId: input.runId, outcome: "failure", reasonCode: input.failureCode, resourceType: "agent_run", resourceId: input.runId, metadata: { runId: input.runId, targetId: run.targetId, attemptCount: input.attemptCount, failureCode: input.failureCode } });
    return "failed";
  });
}

export function createAgentRunProcessor(deps: ProcessorDependencies): { process(job: AgentRunJob & { finalAttempt: boolean }): Promise<"completed" | "retry" | "failed" | "stale"> } {
  return {
    async process(job) {
      const now = deps.clock();
      const claimed = await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, job.userId);
        const [current] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        if (!current || current.status === "completed" || current.status === "failed") return { kind: "stale" as const };
        if (current.status === "running" && current.claimExpiresAt && current.claimExpiresAt > now) return { kind: "retry" as const };
        const claimToken = deps.id();
        const attemptCount = current.attemptCount + 1;
        const version = current.version + 1;
        const [run] = await transaction.update(agentRuns).set({ status: "running", currentStep: "batch_search", claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), attemptCount, startedAt: now, completedAt: null, failedAt: null, failureCode: null, version, updatedAt: now }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), or(eq(agentRuns.status, "queued"), and(eq(agentRuns.status, "running"), lte(agentRuns.claimExpiresAt, now))))).returning();
        if (!run) return { kind: "stale" as const };
        await appendEvent(transaction, { id: deps.id, userId: job.userId, runId: job.runId, version, eventType: "run.started", data: { eventType: "run.started", status: "running", currentStep: "batch_search", attemptCount }, now });
        return { kind: "claimed" as const, run, claimToken, attemptCount };
      });
      if (claimed.kind !== "claimed") return claimed.kind;
      const snapshot = claimed.run.targetSnapshot as import("@job-copilot/contracts/agent-runs").AgentRunDetail["targetSnapshot"];
      if (!await stepTransition(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, stepKey: "batch_search", complete: false, attemptCount: claimed.attemptCount })) return "stale";
      let batch: import("@job-copilot/contracts/agent-runs").DiscoveryBatchSearchResult;
      try { batch = await deps.adapter.searchBatch({ targetSnapshot: snapshot, sourceScope: claimed.run.sourceScope as import("@job-copilot/contracts/agent-runs").AgentRunDetail["sourceScope"] }); } catch { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, finalAttempt: job.finalAttempt, failureCode: "AGENT_RUN_ADAPTER_RETRYABLE" }); }
      if (!batch.ok) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, finalAttempt: job.finalAttempt, failureCode: batch.error.retryable ? "AGENT_RUN_ADAPTER_RETRYABLE" : "AGENT_RUN_ADAPTER_FAILED" });
      if (batch.data.length > AGENT_RUN_BUDGET.maxResults) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, finalAttempt: job.finalAttempt, failureCode: "AGENT_RUN_BUDGET_EXCEEDED" });
      if (!await stepTransition(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, stepKey: "batch_search", complete: true, attemptCount: claimed.attemptCount })) return "stale";
      if (!await stepTransition(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, stepKey: "fetch_details", complete: false, attemptCount: claimed.attemptCount })) return "stale";
      const details: Array<{ sourceId: string; detailId: string; company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; sourceType: string; isOfficial: boolean; rawPayload: Record<string, unknown> }> = [];
      for (const result of batch.data) {
        let detail: import("@job-copilot/contracts/agent-runs").DiscoveryDetailResult;
        try { detail = await deps.adapter.getDetail({ sourceId: result.sourceId, detailId: result.detailId }); } catch { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, finalAttempt: job.finalAttempt, failureCode: "AGENT_RUN_ADAPTER_RETRYABLE" }); }
        if (!detail.ok) return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, finalAttempt: job.finalAttempt, failureCode: detail.error.retryable ? "AGENT_RUN_ADAPTER_RETRYABLE" : "AGENT_RUN_ADAPTER_FAILED" });
        details.push(detail.data);
      }
      if (!await stepTransition(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, stepKey: "fetch_details", complete: true, attemptCount: claimed.attemptCount })) return "stale";
      if (!await stepTransition(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, stepKey: "persist_results", complete: false, attemptCount: claimed.attemptCount })) return "stale";
      const stored = details.map((detail) => ({ detail, bytes: canonicalJsonBytes(detail.rawPayload), objectKey: `accounts/${job.userId}/agent-runs/${job.runId}/raw/${encodeURIComponent(`${detail.sourceId}:${detail.detailId}`)}.json` }));
      try { for (const item of stored) await deps.contentStore.put({ objectKey: item.objectKey, bytes: item.bytes, mediaType: "application/json", runId: job.runId }); } catch { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, finalAttempt: job.finalAttempt, failureCode: "AGENT_RUN_CONTENT_STORAGE_FAILED" }); }
      try {
        const completed = await deps.db.transaction(async (transaction) => {
          await acquireAccountAdvisoryLock(transaction, job.userId);
          const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, claimed.claimToken)));
          if (!run) return false;
          for (const [index, item] of stored.entries()) {
            const source = await persistDiscoverySource(transaction, { id: deps.id, userId: job.userId, detail: item.detail, contentSha256: canonicalJsonSha256({ sourceId: item.detail.sourceId, detailId: item.detail.detailId, company: item.detail.company, title: item.detail.title, location: item.detail.location, postedAt: item.detail.postedAt, deadline: item.detail.deadline, sourceType: item.detail.sourceType, isOfficial: item.detail.isOfficial }), rawContentSha256: createHash("sha256").update(item.bytes).digest("hex"), objectKey: item.objectKey, now });
            const evidence = await persistJobOpportunity(transaction, { id: deps.id, userId: job.userId, importId: null, sourcePostingVersionId: source.sourcePostingVersionId, isOfficial: source.isOfficial, company: item.detail.company, title: item.detail.title, location: item.detail.location, postedAt: item.detail.postedAt, deadline: item.detail.deadline, description: null, normalizedData: discoveryNormalizedData(item.detail), now });
            await transaction.insert(agentRunJobResults).values({ id: deps.id(), userId: job.userId, runId: job.runId, opportunityId: evidence.opportunityId, sourcePostingVersionId: source.sourcePostingVersionId, ordinal: index + 1, createdAt: now }).onConflictDoNothing();
          }
          const stepVersion = run.version + 1;
          await transaction.update(agentRunSteps).set({ status: "completed", completedAt: now }).where(and(eq(agentRunSteps.userId, job.userId), eq(agentRunSteps.runId, job.runId), eq(agentRunSteps.stepKey, "persist_results")));
          await transaction.update(agentRuns).set({ currentStep: "persist_results", version: stepVersion, updatedAt: now }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.claimToken, claimed.claimToken)));
          await appendEvent(transaction, { id: deps.id, userId: job.userId, runId: job.runId, version: stepVersion, eventType: "step.completed", data: { eventType: "step.completed", status: "running", currentStep: "persist_results", stepKey: "persist_results", attemptCount: claimed.attemptCount }, now });
          const terminalVersion = stepVersion + 1;
          await transaction.update(agentRuns).set({ status: "completed", currentStep: "completed", claimToken: null, claimExpiresAt: null, completedAt: now, failureCode: null, version: terminalVersion, updatedAt: now }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
          await appendEvent(transaction, { id: deps.id, userId: job.userId, runId: job.runId, version: terminalVersion, eventType: "run.completed", data: { eventType: "run.completed", status: "completed", currentStep: "completed", attemptCount: claimed.attemptCount, resultCount: stored.length }, now });
          await deps.auditTrail.bind(transaction).append({ userId: job.userId, actorUserId: job.userId, eventType: "agent.run_completed", occurredAt: now, requestId: job.runId, outcome: "success", reasonCode: "AGENT_RUN_COMPLETED", resourceType: "agent_run", resourceId: job.runId, metadata: { runId: job.runId, targetId: run.targetId, attemptCount: claimed.attemptCount, resultCount: stored.length } });
          return true;
        });
        return completed ? "completed" : "stale";
      } catch { return failOrRetry(deps, { userId: job.userId, runId: job.runId, claimToken: claimed.claimToken, attemptCount: claimed.attemptCount, finalAttempt: job.finalAttempt, failureCode: "AGENT_RUN_PERSIST_FAILED" }); }
    },
  };
}
