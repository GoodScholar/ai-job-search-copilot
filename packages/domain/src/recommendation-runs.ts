import { createHash } from "node:crypto";
import { and, desc, eq, exists, inArray, isNull, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentRunControlCommands, agentRunSteps, agentRuns, jobDiscoveryScheduleOccurrences, jobDiscoverySchedules, jobDiscoverySourceIssues, recommendationResults, recommendationRunControlCommands, recommendationRunStartCommands, type Database } from "@job-copilot/database";
import { ControlRecommendationRunCommandSchema, RecommendationResultSchema, RecommendationRunSchema, StartRecommendationRunCommandSchema, type ControlRecommendationRunCommand, type RecommendationRun, type RecommendationRunFailureCode, type RecommendationRunStageKey, type StartRecommendationRunCommand } from "@job-copilot/contracts/recommendation-runs";
import { JobTargetConstraintsSchema } from "@job-copilot/contracts/job-targets";
import { authorizeRunPreflight, type RunPreflightEvaluator } from "./run-preflight";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { applyTransactionDeadline } from "./transaction-deadline";
import { applyAgentRunControlInTransaction, insertAgentRunInTransaction, type AgentRunQueue } from "./agent-run-control";
import { prepareRecommendationRunInTransaction } from "./recommendation-runs-preparation";
import { discoverySourceScopeCounts } from "./agent-run-discovery-spec";
import type { AuditTrail } from "./audit-trail";
import type { JobDiscoveryExecutionMode } from "./job-discovery-execution-mode";
import { projectRecommendationFailure } from "./recommendation-failure-projection";
import { AccountRunAdmissionError, accountRunAdmissionReason, readAccountRunControlInTransaction } from "./account-run-admission";

type PhysicalStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
type StageStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
type PhysicalRun = typeof agentRuns.$inferSelect;
type PhysicalStep = typeof agentRunSteps.$inferSelect;
const rootStepKeys = ["batch_search", "fetch_details", "persist_results"] as const;

export class RecommendationRunError extends Error {
  constructor(readonly code: "RECOMMENDATION_RUN_NOT_FOUND" | "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT" | "RECOMMENDATION_RUN_CONTROL_CONFLICT") { super(code); }
}

export type RecommendationRunStarter = {
  start(input: {
    userId: string;
    requestId: string;
    command: StartRecommendationRunCommand;
    trigger?: { kind: "manual" } | { kind: "schedule"; occurrenceId: string; scheduledFor: Date; targetId: string };
    deadline?: Date;
  }): Promise<{ run: RecommendationRun; reused: boolean }>;
};

function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function physicalStage(run: PhysicalRun, steps: readonly PhysicalStep[]): StageStatus {
  if (run.status === "failed" || run.status === "cancelled") return run.status;
  if (steps.length > 0 && steps.every((step) => step.status === "completed")) return "completed";
  return run.status === "queued" && !run.startedAt && !steps.some((step) => step.startedAt || step.completedAt) ? "pending" : "running";
}

/** Small pure seam for the five-stage projection contract. */
export function projectRecommendationRun(facts: {
  root: { status: PhysicalStatus; steps: readonly StageStatus[]; started?: boolean }; qualificationCompleted: boolean; selectionCompleted: boolean;
  child: { status: PhysicalStatus; steps: readonly StageStatus[]; started?: boolean } | null; resultPublished: boolean;
}) {
  const physical = (run: { status: PhysicalStatus; steps: readonly StageStatus[]; started?: boolean }): StageStatus => run.status === "failed" || run.status === "cancelled" ? run.status : run.steps.length > 0 && run.steps.every((status) => status === "completed") ? "completed" : run.status === "queued" && !run.started ? "pending" : "running";
  const handoffMissing = physical(facts.root) === "completed" && !facts.child && !facts.resultPublished;
  const matchingSteps = facts.child?.steps.slice(0, 2) ?? [];
  const matching = !facts.child ? "pending" : matchingSteps.length > 0 && matchingSteps.every((status) => status === "completed") ? "completed" : physical({ status: facts.child.status, steps: matchingSteps, started: facts.child.started });
  const publication = facts.resultPublished ? "completed" as const
    : !facts.child || matching !== "completed" ? "pending" as const
      : facts.child.status === "failed" ? "failed" as const
        : facts.child.status === "cancelled" ? "cancelled" as const
          : facts.child.status === "completed" ? "failed" as const
            : facts.child.steps[2] === "pending" && facts.child.status === "queued" && !facts.child.started ? "pending" as const : "running" as const;
  return [
    { key: "discovery" as const, status: physical(facts.root) },
    { key: "qualification" as const, status: handoffMissing ? "failed" as const : facts.qualificationCompleted ? "completed" as const : "pending" as const },
    { key: "coarse_ranking" as const, status: facts.selectionCompleted ? "completed" as const : "pending" as const },
    { key: "deep_matching" as const, status: matching },
    { key: "result_publication" as const, status: publication },
  ];
}

function stageTime(status: StageStatus, startedAt: Date | null | undefined, completedAt: Date | null | undefined, fallback: Date) {
  if (status === "pending") return { startedAt: null, completedAt: null };
  if (status === "running") return { startedAt: (startedAt ?? fallback).toISOString(), completedAt: null };
  return { startedAt: (startedAt ?? fallback).toISOString(), completedAt: (completedAt ?? fallback).toISOString() };
}

async function readLogicalFacts(db: any, userId: string, rootId: string) {
  const [root] = await db.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, rootId), eq(agentRuns.runPurpose, "recommendation"), isNull(agentRuns.parentRunId))).limit(1);
  if (!root) return null;
  const [rootSteps, childRows, resultRows, rootSourceIssues] = await Promise.all([
    db.select().from(agentRunSteps).where(and(eq(agentRunSteps.userId, userId), eq(agentRunSteps.runId, root.id))).orderBy(agentRunSteps.ordinal),
    db.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.parentRunId, root.id), eq(agentRuns.runPurpose, "recommendation"))).limit(1),
    db.select().from(recommendationResults).where(and(eq(recommendationResults.userId, userId), eq(recommendationResults.rootRunId, root.id))).limit(1),
    db.select({ code: jobDiscoverySourceIssues.code }).from(jobDiscoverySourceIssues).where(and(eq(jobDiscoverySourceIssues.userId, userId), eq(jobDiscoverySourceIssues.runId, root.id))),
  ]);
  const child = childRows[0] ?? null;
  const [childSteps, childSourceIssues] = child ? await Promise.all([
    db.select().from(agentRunSteps).where(and(eq(agentRunSteps.userId, userId), eq(agentRunSteps.runId, child.id))).orderBy(agentRunSteps.ordinal),
    db.select({ code: jobDiscoverySourceIssues.code }).from(jobDiscoverySourceIssues).where(and(eq(jobDiscoverySourceIssues.userId, userId), eq(jobDiscoverySourceIssues.runId, child.id))),
  ]) : [[], []];
  return { root, rootSteps, child, childSteps, result: resultRows[0] ?? null, rootSourceIssues, childSourceIssues };
}

function projectFacts(facts: NonNullable<Awaited<ReturnType<typeof readLogicalFacts>>>): RecommendationRun {
  const context = facts.root.recommendationContext as { budgets: RecommendationRun["budgets"]; preflight: RecommendationRun["preflightSnapshot"]; accountPolicyRevisionNumber: number };
  const target = JobTargetConstraintsSchema.parse((facts.root.targetSnapshot as { constraints: unknown }).constraints);
  const rootStage = physicalStage(facts.root, facts.rootSteps);
  const matchingSteps = facts.childSteps.filter((step: PhysicalStep) => step.stepKey === "select_candidates" || step.stepKey === "assess_matches");
  const publicationStep = facts.childSteps.find((step: PhysicalStep) => step.stepKey === "create_recommendations");
  const childStarted = Boolean(facts.child?.startedAt || facts.childSteps.some((step: PhysicalStep) => step.startedAt || step.completedAt));
  const statuses = projectRecommendationRun({ root: { status: facts.root.status as PhysicalStatus, steps: facts.rootSteps.map((step: PhysicalStep) => step.status as StageStatus), started: Boolean(facts.root.startedAt) }, qualificationCompleted: facts.child !== null || facts.result !== null, selectionCompleted: facts.child !== null || facts.result !== null, child: facts.child ? { status: facts.child.status as PhysicalStatus, steps: [...matchingSteps, publicationStep].filter(Boolean).map((step: PhysicalStep) => step.status as StageStatus), started: childStarted } : null, resultPublished: facts.result !== null });
  const rootTerminal = facts.root.status === "failed" || facts.root.status === "cancelled";
  const handoffMissing = rootStage === "completed" && !facts.child && !facts.result;
  const publicationMissing = Boolean(facts.child && facts.child.status === "completed" && !facts.result);
  const terminalStage = rootTerminal ? "discovery" : handoffMissing ? "qualification" : publicationMissing ? "result_publication" : statuses.find((stage) => stage.status === "failed" || stage.status === "cancelled")?.key ?? null;
  const terminalStatus = terminalStage ? statuses.find((stage) => stage.key === terminalStage)?.status : null;
  const initiallyQueued = facts.root.status === "queued" && !facts.root.startedAt && facts.rootSteps.every((step: PhysicalStep) => step.status === "pending") && !facts.child;
  const status = facts.result ? "completed" : rootTerminal ? facts.root.status : handoffMissing || publicationMissing ? "failed" : terminalStatus === "failed" || terminalStatus === "cancelled" ? terminalStatus : initiallyQueued ? "queued" : facts.child?.status === "paused" || facts.root.status === "paused" ? "paused" : "running";
  const currentStage = facts.result || status === "cancelled" ? null : terminalStage ?? (rootStage !== "completed" ? "discovery" : facts.child ? statuses.find((stage) => stage.status !== "completed")?.key ?? "result_publication" : "qualification");
  const stages = statuses.map((stage) => {
    const run = stage.key === "discovery" ? facts.root : stage.key === "deep_matching" || stage.key === "result_publication" ? facts.child : null;
    const steps: PhysicalStep[] = stage.key === "discovery" ? facts.rootSteps : stage.key === "deep_matching" ? matchingSteps : stage.key === "result_publication" && publicationStep ? [publicationStep] : [];
    const step = steps.find((row: PhysicalStep) => row.status !== "completed") ?? steps.at(-1);
    const fallback = stage.key === "deep_matching" || stage.key === "result_publication" ? facts.child?.updatedAt ?? facts.root.updatedAt : facts.root.updatedAt;
    return { key: stage.key, status: stage.status, ...stageTime(stage.status, run?.startedAt ?? step?.startedAt, stage.key === "result_publication" ? facts.result?.createdAt : run?.completedAt ?? step?.completedAt, fallback) };
  });
  if (facts.result) for (const stage of stages) Object.assign(stage, { status: "completed" }, stageTime("completed", facts.root.createdAt, facts.result.createdAt, facts.result.createdAt));
  const result = facts.result ? RecommendationResultSchema.parse(facts.result.kind === "recommendation_list" ? { kind: "recommendation_list", resultId: facts.result.id, recommendationListId: facts.result.recommendationListId, itemCount: facts.result.itemCount, evidence: facts.result.evidence, publishedAt: facts.result.createdAt.toISOString() } : { kind: "no_recommendations", resultId: facts.result.id, evidence: facts.result.evidence, publishedAt: facts.result.createdAt.toISOString() }) : null;
  const failure = status === "failed" ? (() => {
    const failureCode = (handoffMissing ? "RECOMMENDATION_HANDOFF_FAILED" : publicationMissing ? "RECOMMENDATION_PUBLICATION_FAILED" : facts.child?.failureCode ?? facts.root.failureCode ?? "AGENT_RUN_PERSIST_FAILED") as RecommendationRunFailureCode;
    const physicalSourceIssues = facts.child?.status === "failed" ? facts.childSourceIssues : facts.rootSourceIssues;
    const projected = projectRecommendationFailure({
      failureCode,
      stage: terminalStage! as RecommendationRunStageKey,
      hasSourceCapabilityDiagnosis: failureCode === "AGENT_RUN_ADAPTER_FAILED" && physicalSourceIssues.some((issue: { code: string }) => issue.code === "SOURCE_CAPABILITY_UNSUPPORTED" || issue.code === "SOURCE_CAPABILITY_DECLARATION_MISMATCH"),
    });
    return { code: projected.code, stage: projected.stage, summary: projected.summary, impact: projected.impact, retryable: projected.retryable, suggestedActions: projected.suggestedActions };
  })() : null;
  return RecommendationRunSchema.parse({ runId: facts.root.id, status, currentStage, stages, target: { targetId: facts.root.targetId, targetVersion: facts.root.targetVersion, roleFamily: target.roleFamily }, sourceScope: discoverySourceScopeCounts(facts.root.sourceScope, facts.root.workflowVersion === "layered-public-job-discovery-v1" ? "layered_public" : "greenhouse"), accountPolicyRevisionNumber: context.accountPolicyRevisionNumber, budgets: context.budgets, preflightSnapshot: context.preflight, result, failure, createdAt: facts.root.createdAt.toISOString(), updatedAt: (facts.result?.createdAt ?? facts.child?.updatedAt ?? facts.root.updatedAt).toISOString() });
}

async function project(db: any, userId: string, rootId: string) { const facts = await readLogicalFacts(db, userId, rootId); if (!facts) throw new RecommendationRunError("RECOMMENDATION_RUN_NOT_FOUND"); return projectFacts(facts); }

async function projectUnderAccountLock(db: Database, userId: string, rootId: string, deadline?: Date, clock: () => Date = () => new Date()) {
  return db.transaction(async (transaction) => { if (deadline) await applyTransactionDeadline(transaction, { deadline, clock }); await acquireAccountAdvisoryLock(transaction, userId); return project(transaction, userId, rootId); });
}

async function findActiveRoot(transaction: any, userId: string) {
  const active = ["queued", "running", "paused"] as const;
  const child = alias(agentRuns, "recommendation_active_child");
  const childActive = transaction.select({ id: child.id }).from(child).where(and(eq(child.userId, userId), eq(child.parentRunId, agentRuns.id), eq(child.runPurpose, "recommendation"), inArray(child.status, active)));
  const hasResult = transaction.select({ id: recommendationResults.id }).from(recommendationResults).where(and(eq(recommendationResults.userId, userId), eq(recommendationResults.rootRunId, agentRuns.id)));
  const [root] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.runPurpose, "recommendation"), isNull(agentRuns.parentRunId), notExists(hasResult), or(inArray(agentRuns.status, active), exists(childActive)))).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(1);
  return root ?? null;
}

export function createRecommendationRunQueries(deps: { db: Database }) {
  return {
    async latest(input: { userId: string }): Promise<RecommendationRun | null> {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [root] = await transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.runPurpose, "recommendation"), isNull(agentRuns.parentRunId))).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(1);
        return root ? project(transaction, input.userId, root.id) : null;
      });
    },
    async latestPublished(input: { userId: string }): Promise<RecommendationRun | null> {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [result] = await transaction.select({ rootRunId: recommendationResults.rootRunId }).from(recommendationResults)
          .where(eq(recommendationResults.userId, input.userId))
          .orderBy(desc(recommendationResults.createdAt), desc(recommendationResults.id))
          .limit(1);
        return result ? project(transaction, input.userId, result.rootRunId) : null;
      });
    },
    async get(input: { userId: string; runId: string }): Promise<RecommendationRun | null> {
      return deps.db.transaction(async (transaction) => { await acquireAccountAdvisoryLock(transaction, input.userId); const facts = await readLogicalFacts(transaction, input.userId, input.runId); return facts ? projectFacts(facts) : null; });
    },
  };
}

export function createRecommendationRunCommands(deps: { db: Database; queue: AgentRunQueue; auditTrail: AuditTrail; runPreflight: RunPreflightEvaluator; executionMode: JobDiscoveryExecutionMode; id: () => string; clock: () => Date }): RecommendationRunStarter & {
  control(input: { userId: string; requestId: string; runId: string; command: ControlRecommendationRunCommand }): Promise<{ applied: boolean; run: RecommendationRun }>;
} {
  return {
    async start(input) {
      const command = StartRecommendationRunCommandSchema.parse(input.command);
      const commandFingerprint = input.trigger?.kind === "schedule"
        ? fingerprint({ warningFingerprint: command.warningFingerprint, trigger: "schedule", occurrenceId: input.trigger.occurrenceId, scheduledFor: input.trigger.scheduledFor.toISOString(), targetId: input.trigger.targetId })
        : fingerprint({ warningFingerprint: command.warningFingerprint });
      const outcome = await deps.db.transaction(async (transaction) => {
        if (input.deadline) await applyTransactionDeadline(transaction, { deadline: input.deadline, clock: deps.clock });
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [prior] = await transaction.select().from(recommendationRunStartCommands).where(and(eq(recommendationRunStartCommands.userId, input.userId), eq(recommendationRunStartCommands.idempotencyKey, command.idempotencyKey))).limit(1);
        if (prior) { if (prior.commandFingerprint !== commandFingerprint) throw new RecommendationRunError("RECOMMENDATION_RUN_COMMAND_ID_CONFLICT"); return { rootId: prior.rootRunId, reused: true, wake: false }; }
        if (input.trigger?.kind === "schedule") {
          const control = await readAccountRunControlInTransaction(transaction, input.userId);
          const admission = accountRunAdmissionReason(control, input.trigger.scheduledFor);
          if (admission) throw new AccountRunAdmissionError(admission);
          const [occurrence] = await transaction.select({ status: jobDiscoveryScheduleOccurrences.status, scheduledFor: jobDiscoveryScheduleOccurrences.scheduledFor, scheduleState: jobDiscoverySchedules.state })
            .from(jobDiscoveryScheduleOccurrences)
            .innerJoin(jobDiscoverySchedules, and(eq(jobDiscoverySchedules.userId, jobDiscoveryScheduleOccurrences.userId), eq(jobDiscoverySchedules.id, jobDiscoveryScheduleOccurrences.scheduleId), eq(jobDiscoverySchedules.targetId, jobDiscoveryScheduleOccurrences.targetId)))
            .where(and(eq(jobDiscoveryScheduleOccurrences.userId, input.userId), eq(jobDiscoveryScheduleOccurrences.id, input.trigger.occurrenceId), eq(jobDiscoveryScheduleOccurrences.targetId, input.trigger.targetId)))
            .limit(1);
          if (!occurrence || occurrence.status !== "pending" || occurrence.scheduleState !== "enabled" || occurrence.scheduledFor.getTime() !== input.trigger.scheduledFor.getTime()) throw new AccountRunAdmissionError("ACCOUNT_RUN_SCHEDULE_SKIPPED");
        }
        const preparation = await prepareRecommendationRunInTransaction(transaction, { userId: input.userId, executionMode: deps.executionMode, ...(input.trigger?.kind === "schedule" ? { targetId: input.trigger.targetId, trigger: "schedule" as const, scheduledFor: input.trigger.scheduledFor } : {}) }, deps);
        authorizeRunPreflight({ evaluation: { report: preparation.preparation.preflight } as any, warningFingerprint: command.warningFingerprint });
        if (!preparation.startSpec || !preparation.recommendationContext) throw new Error("RECOMMENDATION_RUN_PREPARATION_UNAVAILABLE");
        const active = await findActiveRoot(transaction, input.userId);
        const root = active ?? await insertAgentRunInTransaction(transaction, { userId: input.userId, requestId: input.requestId, idempotencyKey: command.idempotencyKey, targetId: preparation.startSpec.targetId, targetVersion: preparation.startSpec.targetVersion, targetSnapshot: preparation.startSpec.targetSnapshot, profileSnapshot: (preparation.startSpec.executionSpec as any).profileSnapshot, watchlistSnapshot: (preparation.startSpec.executionSpec as any).watchlistSnapshot, sourceScope: preparation.startSpec.executionSpec.sourceScope, budgetSnapshot: preparation.startSpec.executionSpec.budget, accountPolicyRevisionNumber: preparation.recommendationContext.accountPolicyRevisionNumber, accountPolicySnapshot: preparation.startSpec.accountPolicySnapshot, preflightSnapshot: preparation.recommendationContext.preflight, workflowVersion: preparation.startSpec.executionSpec.workflowVersion, ruleVersion: preparation.startSpec.executionSpec.ruleVersion, adapter: preparation.startSpec.executionSpec.adapter, adapterVersion: preparation.startSpec.executionSpec.adapterVersion, outputSchemaVersion: preparation.startSpec.executionSpec.outputSchemaVersion, toolAllowlist: preparation.startSpec.executionSpec.toolAllowlist, modelSnapshot: preparation.startSpec.executionSpec.model, stepKeys: rootStepKeys, runPurpose: "recommendation", recommendationContext: preparation.recommendationContext }, deps);
        await transaction.insert(recommendationRunStartCommands).values({ userId: input.userId, idempotencyKey: command.idempotencyKey, rootRunId: root.id, commandFingerprint, createdAt: deps.clock() });
        return { rootId: root.id, reused: active !== null, wake: true };
      });
      if (outcome.wake) try { await deps.queue.enqueue({ version: 1, runId: outcome.rootId, userId: input.userId }); } catch { /* reconciler owns recovery */ }
      return { run: await projectUnderAccountLock(deps.db, input.userId, outcome.rootId, input.deadline, deps.clock), reused: outcome.reused };
    },
    async control(input: { userId: string; requestId: string; runId: string; command: ControlRecommendationRunCommand }): Promise<{ applied: boolean; run: RecommendationRun }> {
      const command = ControlRecommendationRunCommandSchema.parse(input.command); const commandFingerprint = fingerprint({ action: command.action });
      const outcome = await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId); const facts = await readLogicalFacts(transaction, input.userId, input.runId);
        if (!facts) throw new RecommendationRunError("RECOMMENDATION_RUN_NOT_FOUND");
        const [prior] = await transaction.select().from(recommendationRunControlCommands).where(and(eq(recommendationRunControlCommands.userId, input.userId), eq(recommendationRunControlCommands.rootRunId, facts.root.id), eq(recommendationRunControlCommands.commandId, command.commandId))).limit(1);
        if (prior) {
          if (prior.commandFingerprint !== commandFingerprint) throw new RecommendationRunError("RECOMMENDATION_RUN_COMMAND_ID_CONFLICT");
          const [physical] = await transaction.select({ applied: agentRunControlCommands.applied }).from(agentRunControlCommands).where(and(eq(agentRunControlCommands.userId, input.userId), eq(agentRunControlCommands.runId, prior.physicalRunId), eq(agentRunControlCommands.commandId, command.commandId))).limit(1);
          return { applied: physical?.applied ?? false, wake: false, rootId: facts.root.id };
        }
        const physical = facts.child && ["queued", "running", "paused"].includes(facts.child.status) ? facts.child : ["queued", "running", "paused"].includes(facts.root.status) ? facts.root : null;
        if (!physical) throw new RecommendationRunError("RECOMMENDATION_RUN_CONTROL_CONFLICT");
        const applied = await applyAgentRunControlInTransaction(transaction, { userId: input.userId, requestId: input.requestId, runId: physical.id, command }, deps);
        await transaction.insert(recommendationRunControlCommands).values({ userId: input.userId, rootRunId: facts.root.id, commandId: command.commandId, physicalRunId: physical.id, action: command.action, commandFingerprint, resultSnapshot: applied.response.run, createdAt: deps.clock() });
        return { applied: applied.response.applied, wake: applied.wake, rootId: facts.root.id, physicalId: physical.id };
      });
      if (outcome.wake && outcome.physicalId) try { await deps.queue.enqueue({ version: 1, runId: outcome.physicalId, userId: input.userId }); } catch { /* reconciler owns recovery */ }
      return { applied: outcome.applied, run: await projectUnderAccountLock(deps.db, input.userId, outcome.rootId) };
    },
  };
}
