import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { agentRunEvents, agentRunSteps, agentRuns, jobTargets, jobTargetRevisions, type Database } from "@job-copilot/database";
import { DEEP_MATCH_AGENT_RUN_BUDGET, DEEP_MATCH_AGENT_RUN_STEPS, DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION, type AgentRunJob } from "@job-copilot/contracts/agent-runs";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { createDeepMatchCommands, createDeepMatchQueries } from "./deep-match-persistence";
import { runDeepMatchWorkflow } from "./deep-match-workflow";

export type DeepMatchRunQueue = { enqueue(job: AgentRunJob): Promise<void> };

/** A discovery completion gets one stable queued matching run; queue delivery is deliberately non-authoritative. */
export function deepMatchDiscoveryIdempotencyKey(discoveryRunId: string): string {
  const hash = createHash("sha256").update(`deep-match:${discoveryRunId}`).digest("hex");
  const variant = (Number.parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, "0");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

export async function triggerDeepMatchAfterDiscovery(input: { db: Database; id: () => string; clock: () => Date; queue?: DeepMatchRunQueue; userId: string; targetId: string; discoveryRunId: string }) {
  const starter = createDeepMatchRunStarter({ db: input.db, id: input.id, clock: input.clock, queue: input.queue ?? { enqueue: async () => undefined } });
  return starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: deepMatchDiscoveryIdempotencyKey(input.discoveryRunId), trigger: "automatic" });
}

export function createDeepMatchRunStarter(deps: { db: Database; queue: DeepMatchRunQueue; id: () => string; clock: () => Date }) {
  return {
    async start(input: { userId: string; targetId: string; idempotencyKey: string; trigger: "automatic" | "manual" }) {
      const now = deps.clock();
      const run = await deps.db.transaction(async (tx) => {
        await acquireAccountAdvisoryLock(tx, input.userId);
        const [existing] = await tx.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.idempotencyKey, input.idempotencyKey)));
        if (existing) return { run: existing, reused: true };
        const [target] = await tx.select({ id: jobTargets.id, version: jobTargets.version, priority: jobTargets.priority, state: jobTargets.state, constraints: jobTargetRevisions.constraints }).from(jobTargets).innerJoin(jobTargetRevisions, and(eq(jobTargetRevisions.userId, jobTargets.userId), eq(jobTargetRevisions.targetId, jobTargets.id), eq(jobTargetRevisions.version, jobTargets.version))).where(and(eq(jobTargets.userId, input.userId), eq(jobTargets.id, input.targetId)));
        if (!target || target.state !== "active") throw new Error("DEEP_MATCH_TARGET_UNAVAILABLE");
        const id = deps.id();
        const [created] = await tx.insert(agentRuns).values({ id, userId: input.userId, targetId: target.id, idempotencyKey: input.idempotencyKey, targetVersion: target.version, targetSnapshot: { targetId: target.id, version: target.version, priority: target.priority, state: target.state, constraints: target.constraints }, profileSnapshot: null, watchlistSnapshot: null, sourceScope: { kind: "deep_match", trigger: input.trigger }, budgetSnapshot: DEEP_MATCH_AGENT_RUN_BUDGET, workflowVersion: DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION, ruleVersion: "deep-match-rules-v1", adapter: "fake-deep-match", adapterVersion: "fake-deep-match-v1", outputSchemaVersion: "deep-match-result-v1", toolAllowlist: [], modelSnapshot: { provider: "fake", model: "fake-deep-match-model-v1" }, status: "queued", currentStep: "queued", controlState: "none", version: 1, attemptCount: 0, activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: true, queuedAt: now, createdAt: now, updatedAt: now }).returning();
        if (!created) throw new Error("DEEP_MATCH_RUN_PERSIST_FAILED");
        await tx.insert(agentRunSteps).values(DEEP_MATCH_AGENT_RUN_STEPS.map((stepKey, index) => ({ id: deps.id(), userId: input.userId, runId: id, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
        await tx.insert(agentRunEvents).values({ id: deps.id(), userId: input.userId, runId: id, sequence: 1, runVersion: 1, eventType: "run.queued", data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 }, createdAt: now });
        return { run: created, reused: false };
      });
      if (!run.reused) { try { await deps.queue.enqueue({ version: 1, runId: run.run.id, userId: input.userId }); } catch { /* reconciler reads the persisted queued row */ } }
      return { runId: run.run.id, reused: run.reused };
    },
  };
}

export function createDeepMatchRunProcessor(deps: { db: Database; id: () => string; clock: () => Date }) {
  const commands = createDeepMatchCommands(deps);
  const queries = createDeepMatchQueries(deps);
  return {
    async process(job: AgentRunJob): Promise<"completed" | "stale" | "failed"> {
      const [run] = await deps.db.select().from(agentRuns).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.workflowVersion, DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION)));
      if (!run || run.status === "completed") return "stale";
      try {
        await deps.db.transaction(async (tx) => { await tx.update(agentRuns).set({ status: "running", currentStep: "select_candidates", startedAt: deps.clock(), updatedAt: deps.clock(), version: run.version + 1 }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId), eq(agentRuns.status, "queued"))); });
        const candidates = await queries.selectCandidates({ userId: job.userId, targetId: run.targetId });
        await deps.db.update(agentRuns).set({ currentStep: "assess_matches", updatedAt: deps.clock() }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        const list = await runDeepMatchWorkflow({ userId: job.userId, targetId: run.targetId, queries: { selectCandidates: async () => candidates }, commands });
        await deps.db.update(agentRuns).set({ status: "completed", currentStep: "completed", resultCount: list.items.length, completedAt: deps.clock(), updatedAt: deps.clock(), terminationKind: "completed" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        return "completed";
      } catch {
        await deps.db.update(agentRuns).set({ status: "failed", currentStep: "failed", failureCode: "AGENT_RUN_MODEL_INVALID_RESPONSE", failedAt: deps.clock(), updatedAt: deps.clock(), terminationKind: "source_failed" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        return "failed";
      }
    },
  };
}
