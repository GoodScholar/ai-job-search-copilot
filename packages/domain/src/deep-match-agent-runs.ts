import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { agentRunEvents, agentRunSteps, agentRuns, deepMatchRunCandidates, jobTargets, jobTargetRevisions, type Database } from "@job-copilot/database";
import { DEEP_MATCH_AGENT_RUN_BUDGET, DEEP_MATCH_AGENT_RUN_STEPS, DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION, type AgentRunJob } from "@job-copilot/contracts/agent-runs";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { createDeepMatchQueries } from "./deep-match-persistence";

export type DeepMatchRunQueue = { enqueue(job: AgentRunJob): Promise<void> };

export async function ensureDeepMatchRunInTransaction(input: { transaction: any; id: () => string; clock: () => Date; userId: string; targetId: string; idempotencyKey: string; trigger: "automatic" | "manual"; opportunityId?: string; discoveryRunId?: string }) {
  await acquireAccountAdvisoryLock(input.transaction, input.userId);
  const [existing] = await input.transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.idempotencyKey, input.idempotencyKey)));
  if (existing) return { run: existing, reused: true };
  const [target] = await input.transaction.select({ id: jobTargets.id, version: jobTargets.version, priority: jobTargets.priority, state: jobTargets.state, constraints: jobTargetRevisions.constraints }).from(jobTargets).innerJoin(jobTargetRevisions, and(eq(jobTargetRevisions.userId, jobTargets.userId), eq(jobTargetRevisions.targetId, jobTargets.id), eq(jobTargetRevisions.version, jobTargets.version))).where(and(eq(jobTargets.userId, input.userId), eq(jobTargets.id, input.targetId)));
  if (!target || target.state !== "active") throw new Error("DEEP_MATCH_TARGET_UNAVAILABLE");
  if (input.trigger === "manual" && !input.opportunityId) throw new Error("DEEP_MATCH_OPPORTUNITY_REQUIRED");
  if (input.trigger === "automatic" && !input.discoveryRunId) throw new Error("DEEP_MATCH_DISCOVERY_PROVENANCE_REQUIRED");
  // This query runs on the same transaction as the child insertion.  A queued child can
  // therefore never exist without a complete candidate/exclusion snapshot, including a
  // legitimate empty selection.
  const selection = await createDeepMatchQueries({ db: input.transaction }).selectCandidateSelection({
    userId: input.userId, targetId: input.targetId, targetVersion: target.version, ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
  });
  const now = input.clock(); const id = input.id();
  const [run] = await input.transaction.insert(agentRuns).values({ id, userId: input.userId, targetId: target.id, idempotencyKey: input.idempotencyKey, targetVersion: target.version, targetSnapshot: { targetId: target.id, version: target.version, priority: target.priority, state: target.state, constraints: target.constraints }, profileSnapshot: null, watchlistSnapshot: null, sourceScope: { kind: "deep_match", trigger: input.trigger, opportunityId: input.opportunityId ?? null, discoveryRunId: input.discoveryRunId ?? null, initialized: true, selectionExclusions: selection.exclusions }, budgetSnapshot: DEEP_MATCH_AGENT_RUN_BUDGET, workflowVersion: DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION, ruleVersion: "deep-match-rules-v1", adapter: "fake-deep-match", adapterVersion: "fake-deep-match-v1", outputSchemaVersion: "deep-match-result-v1", toolAllowlist: [], modelSnapshot: { provider: "fake", model: "fake-deep-match-model-v1" }, status: "queued", currentStep: "queued", controlState: "none", version: 1, attemptCount: 0, activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: false, queuedAt: now, createdAt: now, updatedAt: now }).returning();
  if (!run) throw new Error("DEEP_MATCH_RUN_PERSIST_FAILED");
  if (selection.candidates.length) await input.transaction.insert(deepMatchRunCandidates).values(selection.candidates.map((candidate, index) => ({
    id: input.id(), userId: input.userId, runId: id, opportunityId: candidate.opportunityId, sourcePostingVersionId: candidate.sourcePostingVersionId,
    ordinal: index + 1, candidateSnapshot: candidate, createdAt: now,
  })));
  await input.transaction.insert(agentRunSteps).values(DEEP_MATCH_AGENT_RUN_STEPS.map((stepKey, index) => ({ id: input.id(), userId: input.userId, runId: id, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
  await input.transaction.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: id, sequence: 1, runVersion: 1, eventType: "run.queued", data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 }, createdAt: now });
  return { run, reused: false };
}

/** A discovery completion gets one stable queued matching run; queue delivery is deliberately non-authoritative. */
export function deepMatchDiscoveryIdempotencyKey(discoveryRunId: string): string {
  const hash = createHash("sha256").update(`deep-match:${discoveryRunId}`).digest("hex");
  const variant = (Number.parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, "0");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

export async function triggerDeepMatchAfterDiscovery(input: { db: Database; id: () => string; clock: () => Date; queue?: DeepMatchRunQueue; userId: string; targetId: string; discoveryRunId: string }) {
  const starter = createDeepMatchRunStarter({ db: input.db, id: input.id, clock: input.clock, queue: input.queue ?? { enqueue: async () => undefined } });
  return starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: deepMatchDiscoveryIdempotencyKey(input.discoveryRunId), trigger: "automatic", discoveryRunId: input.discoveryRunId });
}

export function createDeepMatchRunStarter(deps: { db: Database; queue: DeepMatchRunQueue; id: () => string; clock: () => Date }) {
  return {
    async start(input: { userId: string; targetId: string; opportunityId?: string; discoveryRunId?: string; idempotencyKey: string; trigger: "automatic" | "manual" }) {
      const run = await deps.db.transaction(async (tx) => {
        return ensureDeepMatchRunInTransaction({ transaction: tx, id: deps.id, clock: deps.clock, ...input });
      });
      if (run.run.status === "queued") { try { await deps.queue.enqueue({ version: 1, runId: run.run.id, userId: input.userId }); } catch { /* reconciler reads the persisted queued row */ } }
      return { runId: run.run.id, reused: run.reused };
    },
  };
}
