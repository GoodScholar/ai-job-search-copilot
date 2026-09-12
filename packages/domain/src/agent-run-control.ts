import { and, desc, eq, inArray } from "drizzle-orm";
import {
  agentInboxItems, agentRunControlCommands, agentRunEvents, agentRunSteps, agentRuns, jobTargetRevisions, jobTargets, type Database,
} from "@job-copilot/database";
import {
  AGENT_RUN_JOB_VERSION, ControlAgentRunCommandSchema, StartAgentRunCommandSchema,
  AgentRunExecutionSpecSchema, StartAgentRunResponseSchema, type AgentRunJob, type ControlAgentRunResponse, type StartAgentRunCommand, type StartAgentRunResponse,
} from "@job-copilot/contracts/agent-runs";
import { RunPreflightSnapshotSchema } from "@job-copilot/contracts/run-preflight";
import { LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/job-discovery";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { AuditTrail } from "./audit-trail";
import { reduceControl } from "./agent-run-state";
import { normalizeAgentRunSourceScope } from "./agent-run-source-scope";
import { applyTransactionDeadline } from "./transaction-deadline";
import type { JobDiscoveryExecutionMode } from "./job-discovery-execution-mode";
import { resolveEffectiveAccountRunPolicy } from "./account-run-policies";
import { isDateInBackgroundWindow } from "./account-run-policy-window";
import { authorizeRunPreflight, type RunPreflightEvaluator } from "./run-preflight";
import { AccountRunAdmissionError, accountRunAdmissionReason, readAccountRunControlInTransaction } from "./account-run-admission";
import { AgentRunError } from "./agent-run-errors";
import { buildDiscoveryRunSpecInTransaction, readDiscoveryWatchlistInTransaction } from "./agent-run-discovery-spec";

export { AgentRunError } from "./agent-run-errors";

export interface AgentRunQueue { enqueue(job: AgentRunJob): Promise<void>; }

export class AgentRunControlError extends Error {
  constructor(public readonly code: "AGENT_RUN_COMMAND_ID_CONFLICT" | "AGENT_RUN_CONTROL_CONFLICT" | "AGENT_RUN_NOT_FOUND") { super(code); }
}

type CommandDependencies = {
  db: Database;
  queue: AgentRunQueue;
  auditTrail: AuditTrail;
  id: () => string;
  clock: () => Date;
  /** 所有新运行共享的、在 API/Worker 边界选择的执行规格；省略时保持直接领域测试的 Fake 默认值。 */
  executionMode?: JobDiscoveryExecutionMode;
  runPreflight: RunPreflightEvaluator;
};
export type AgentRunStarter = {
  start(input: {
    userId: string;
    requestId: string;
    command: StartAgentRunCommand;
    trigger?: { kind: "manual" } | { kind: "schedule"; occurrenceId: string; scheduledFor: Date };
    deadline?: Date;
  }): Promise<StartAgentRunResponse>;
};
type RunRow = typeof agentRuns.$inferSelect;
type ControlSnapshot = ControlAgentRunResponse["run"];
const stepKeys = ["batch_search", "fetch_details", "persist_results"] as const;



function summary(row: RunRow, reused: boolean): StartAgentRunResponse {
  const sourceScope = row.workflowVersion === LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION
    ? AgentRunExecutionSpecSchema.parse({ targetSnapshot: row.targetSnapshot, profileSnapshot: row.profileSnapshot, watchlistSnapshot: row.watchlistSnapshot, sourceScope: row.sourceScope, workflowVersion: row.workflowVersion, ruleVersion: row.ruleVersion, adapter: row.adapter, adapterVersion: row.adapterVersion, outputSchemaVersion: row.outputSchemaVersion, toolAllowlist: row.toolAllowlist, model: row.modelSnapshot, budget: row.budgetSnapshot }).sourceScope
    : normalizeAgentRunSourceScope(row.sourceScope);
  return StartAgentRunResponseSchema.parse({
    runId: row.id, targetId: row.targetId, targetVersion: row.targetVersion,
    accountPolicyRevisionNumber: row.accountPolicyRevisionNumber,
    preflightSnapshot: row.preflightSnapshot === null ? null : RunPreflightSnapshotSchema.parse(row.preflightSnapshot),
    targetSnapshot: row.targetSnapshot, sourceScope,
    workflowVersion: row.workflowVersion, adapter: row.adapter,
    adapterVersion: row.adapterVersion, outputSchemaVersion: row.outputSchemaVersion,
    budget: row.budgetSnapshot, status: row.status, currentStep: row.currentStep,
    version: row.version, attemptCount: row.attemptCount, failureCode: row.failureCode,
    queuedAt: row.queuedAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null, cancelledAt: row.cancelledAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(), reused,
  });
}

async function appendEvent(db: any, input: { id: () => string; userId: string; runId: string; version: number; eventType: string; data: Record<string, unknown>; now: Date }) {
  const [latest] = await db.select({ sequence: agentRunEvents.sequence }).from(agentRunEvents)
    .where(and(eq(agentRunEvents.userId, input.userId), eq(agentRunEvents.runId, input.runId))).orderBy(desc(agentRunEvents.sequence)).limit(1);
  const sequence = (latest?.sequence ?? 0) + 1;
  await db.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: input.runId, sequence, runVersion: input.version, eventType: input.eventType, data: input.data, createdAt: input.now });
  return sequence;
}

async function appendControlAudit(auditTrail: AuditTrail, input: { userId: string; requestId: string; runId: string; eventType: "run.pause_requested" | "run.paused" | "run.resume_requested" | "run.resumed" | "run.cancel_requested" | "run.cancelled"; version: number; action: "pause" | "resume" | "cancel"; attemptCount: number; now: Date }) {
  const base = { userId: input.userId, actorUserId: input.userId, occurredAt: input.now, requestId: input.requestId, outcome: "success" as const, resourceType: "agent_run" as const, resourceId: input.runId, metadata: { runId: input.runId, version: input.version, action: input.action, attemptCount: input.attemptCount } };
  switch (input.eventType) {
    case "run.pause_requested": return auditTrail.append({ ...base, eventType: "agent.run_pause_requested", reasonCode: "AGENT_RUN_PAUSE_REQUESTED" });
    case "run.paused": return auditTrail.append({ ...base, eventType: "agent.run_paused", reasonCode: "AGENT_RUN_PAUSED" });
    case "run.resume_requested": return auditTrail.append({ ...base, eventType: "agent.run_resume_requested", reasonCode: "AGENT_RUN_RESUME_REQUESTED" });
    case "run.resumed": return auditTrail.append({ ...base, eventType: "agent.run_resumed", reasonCode: "AGENT_RUN_RESUMED" });
    case "run.cancel_requested": return auditTrail.append({ ...base, eventType: "agent.run_cancel_requested", reasonCode: "AGENT_RUN_CANCEL_REQUESTED" });
    case "run.cancelled": return auditTrail.append({ ...base, eventType: "agent.run_cancelled", reasonCode: "AGENT_RUN_CANCELLED" });
  }
}

async function resolveDecisionItems(transaction: any, auditTrail: AuditTrail, input: { userId: string; requestId: string; runId: string; action: "resume_run" | "cancel_run"; now: Date }) {
  const items = await transaction.select({ id: agentInboxItems.id, reasonCode: agentInboxItems.reasonCode }).from(agentInboxItems).where(and(
    eq(agentInboxItems.userId, input.userId), eq(agentInboxItems.runId, input.runId), eq(agentInboxItems.kind, "decision_required"), inArray(agentInboxItems.status, ["unread", "read"]),
  ));
  for (const item of items) {
    await transaction.update(agentInboxItems).set({ status: "resolved", resolvedAt: input.now }).where(and(eq(agentInboxItems.userId, input.userId), eq(agentInboxItems.id, item.id), inArray(agentInboxItems.status, ["unread", "read"])));
    await auditTrail.append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_resolved", occurredAt: input.now, requestId: input.requestId, outcome: "success", reasonCode: item.reasonCode as "AGENT_RUN_PAUSED", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: input.runId, action: input.action, reasonCode: item.reasonCode } });
  }
}

async function openDecisionItem(transaction: any, auditTrail: AuditTrail, input: { id: () => string; userId: string; runId: string; sequence: number; requestId: string; now: Date }) {
  const [item] = await transaction.insert(agentInboxItems).values({ id: input.id(), userId: input.userId, runId: input.runId, triggerEventSequence: input.sequence, kind: "decision_required", status: "unread", reasonCode: "AGENT_RUN_PAUSED", budgetDimension: null, createdAt: input.now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
  if (item) await auditTrail.append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_opened", occurredAt: input.now, requestId: input.requestId, outcome: "success", reasonCode: "AGENT_RUN_PAUSED", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: input.runId, kind: "decision_required", reasonCode: "AGENT_RUN_PAUSED", budgetDimension: null } });
}

function createAgentRunStarter(deps: CommandDependencies): AgentRunStarter {
  return {
    async start(input) {
      const command = StartAgentRunCommandSchema.parse(input.command);
      let reused = false;
      const run = await deps.db.transaction(async (transaction) => {
        if (input.deadline) await applyTransactionDeadline(transaction, { deadline: input.deadline, clock: deps.clock });
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [existing] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.idempotencyKey, command.idempotencyKey)));
        if (existing) { reused = true; return existing; }
        const admission = accountRunAdmissionReason(await readAccountRunControlInTransaction(transaction, input.userId), input.trigger?.kind === "schedule" ? input.trigger.scheduledFor : undefined);
        if (admission) throw new AgentRunError(admission);
        const evaluation = await deps.runPreflight.evaluate(transaction, {
          userId: input.userId,
          workflow: "discovery",
          trigger: input.trigger?.kind === "schedule" ? "schedule" : "manual",
          targetId: command.targetId,
          ...(input.trigger?.kind === "schedule" ? { scheduledFor: input.trigger.scheduledFor } : {}),
        });
        authorizeRunPreflight({ evaluation, warningFingerprint: command.warningFingerprint });
        // 账户锁等待可能跨越后台窗口边界；仅在确定不是幂等重放后读取当前时刻。
        const now = deps.clock();
        const [target] = await transaction.select({ id: jobTargets.id, version: jobTargets.version, priority: jobTargets.priority, state: jobTargets.state, constraints: jobTargetRevisions.constraints })
          .from(jobTargets).innerJoin(jobTargetRevisions, and(eq(jobTargetRevisions.userId, jobTargets.userId), eq(jobTargetRevisions.targetId, jobTargets.id), eq(jobTargetRevisions.version, jobTargets.version)))
          .where(and(eq(jobTargets.userId, input.userId), eq(jobTargets.id, command.targetId)));
        if (!target) throw new AgentRunError("AGENT_RUN_TARGET_NOT_FOUND");
        if (target.state !== "active") throw new AgentRunError("AGENT_RUN_TARGET_INACTIVE");
        const runId = deps.id();
        const targetSnapshot = { targetId: target.id, version: target.version, priority: target.priority, state: target.state, constraints: target.constraints };
        const executionMode = deps.executionMode ?? "fake";
        const policy = { revisionNumber: evaluation.policy.revisionNumber, effective: evaluation.policy.snapshot };
        const watchlist = await readDiscoveryWatchlistInTransaction(transaction, { userId: input.userId, targetId: target.id });
        const discoverySpec = await buildDiscoveryRunSpecInTransaction(transaction, { userId: input.userId, targetSnapshot, watchlist, policy: policy.effective, executionMode });
        const { execution } = discoverySpec;
        const [created] = await transaction.insert(agentRuns).values({
          id: runId, userId: input.userId, targetId: target.id, idempotencyKey: command.idempotencyKey, targetVersion: target.version,
          targetSnapshot, ...(discoverySpec.profileSnapshot ? { profileSnapshot: discoverySpec.profileSnapshot, watchlistSnapshot: discoverySpec.watchlistSnapshot } : {}),
          sourceScope: discoverySpec.sourceScope, budgetSnapshot: execution.budget, accountPolicyRevisionNumber: policy.revisionNumber, accountPolicySnapshot: policy.effective, preflightSnapshot: evaluation.report, workflowVersion: execution.workflowVersion,
          ruleVersion: execution.ruleVersion, toolAllowlist: discoverySpec.toolAllowlist, modelSnapshot: null,
          adapter: execution.adapter, adapterVersion: execution.adapterVersion, outputSchemaVersion: execution.outputSchemaVersion,
          status: "queued", currentStep: "queued", controlState: "none", version: 1, attemptCount: 0,
          activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: true,
          queuedAt: now, createdAt: now, updatedAt: now,
        }).returning();
        if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
        await transaction.insert(agentRunSteps).values(stepKeys.map((stepKey, index) => ({ id: deps.id(), userId: input.userId, runId, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
        await transaction.insert(agentRunEvents).values({ id: deps.id(), userId: input.userId, runId, sequence: 1, runVersion: 1, eventType: "run.queued", data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 }, createdAt: now });
        await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.run_queued", occurredAt: now, requestId: input.requestId, outcome: "success", reasonCode: "AGENT_RUN_QUEUED", resourceType: "agent_run", resourceId: runId, metadata: { runId, targetId: target.id, targetVersion: target.version, workflowVersion: execution.workflowVersion, adapterVersion: execution.adapterVersion } });
        return created;
      });
      const response = summary(run, reused);
      try { await deps.queue.enqueue({ version: AGENT_RUN_JOB_VERSION, runId: response.runId, userId: input.userId }); } catch { /* 提交后的唤醒可由恢复扫描补偿。 */ }
      return response;
    },
  };
}

export async function applyAgentRunControlInTransaction(
  transaction: any,
  input: { userId: string; requestId: string; runId: string; command: { commandId: string; action: "pause" | "resume" | "cancel" } },
  deps: Pick<CommandDependencies, "auditTrail" | "id" | "clock">,
): Promise<{ response: ControlAgentRunResponse; wake: boolean }> {
  const command = ControlAgentRunCommandSchema.parse(input.command);
  const [run] = await transaction.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
  if (!run) throw new AgentRunControlError("AGENT_RUN_NOT_FOUND");
  const [prior] = await transaction.select().from(agentRunControlCommands).where(and(eq(agentRunControlCommands.userId, input.userId), eq(agentRunControlCommands.runId, input.runId), eq(agentRunControlCommands.commandId, command.commandId)));
  if (prior) {
    if (prior.action !== command.action) throw new AgentRunControlError("AGENT_RUN_COMMAND_ID_CONFLICT");
    return { response: { applied: prior.applied, run: prior.resultSnapshot as ControlSnapshot }, wake: false };
  }
  if (command.action === "resume" && (await readAccountRunControlInTransaction(transaction, input.userId)).stoppedAt !== null) {
    throw new AccountRunAdmissionError("ACCOUNT_RUN_STOPPED");
  }
  const transition = reduceControl({ status: run.status as "queued" | "running" | "paused" | "completed" | "failed" | "cancelled", controlState: run.controlState as "none" | "pause_requested" | "cancel_requested" }, command.action);
  if (transition.kind === "conflict") throw new AgentRunControlError(transition.code);
  const now = deps.clock();
  let snapshot: ControlSnapshot = { runId: run.id, status: run.status as ControlSnapshot["status"], currentStep: run.currentStep as ControlSnapshot["currentStep"], controlState: run.controlState as ControlSnapshot["controlState"], version: run.version };
  if (transition.kind === "transition") {
    const version = run.version + 1;
    const immediateCancel = transition.eventType === "run.cancelled";
    snapshot = { runId: run.id, status: transition.status, currentStep: immediateCancel ? "cancelled" : transition.eventType === "run.resumed" ? "queued" : run.currentStep as ControlSnapshot["currentStep"], controlState: transition.controlState, version };
    await transaction.update(agentRuns).set({ status: snapshot.status, currentStep: snapshot.currentStep, controlState: snapshot.controlState, version, claimToken: immediateCancel || transition.eventType === "run.paused" ? null : run.claimToken, claimExpiresAt: immediateCancel || transition.eventType === "run.paused" ? null : run.claimExpiresAt, activeSliceStartedAt: immediateCancel || transition.eventType === "run.paused" ? null : run.activeSliceStartedAt, cancelledAt: immediateCancel ? now : run.cancelledAt, terminationKind: immediateCancel ? "cancelled_by_user" : run.terminationKind, terminationBudgetDimension: immediateCancel ? null : run.terminationBudgetDimension, usageComplete: run.usageComplete, updatedAt: now }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId)));
    const sequence = await appendEvent(transaction, { id: deps.id, userId: input.userId, runId: input.runId, version, eventType: transition.eventType, data: { eventType: transition.eventType, status: snapshot.status, currentStep: snapshot.currentStep, attemptCount: run.attemptCount }, now });
    if (transition.eventType === "run.paused") await openDecisionItem(transaction, deps.auditTrail.bind(transaction), { id: deps.id, userId: input.userId, runId: input.runId, sequence, requestId: input.requestId, now });
    if (transition.eventType === "run.resumed" || transition.eventType === "run.cancelled") await resolveDecisionItems(transaction, deps.auditTrail.bind(transaction), { userId: input.userId, requestId: input.requestId, runId: input.runId, action: transition.eventType === "run.resumed" ? "resume_run" : "cancel_run", now });
  }
  await transaction.insert(agentRunControlCommands).values({ id: deps.id(), userId: input.userId, runId: input.runId, commandId: command.commandId, action: command.action, applied: transition.kind === "transition", resultRunVersion: snapshot.version, resultSnapshot: snapshot, createdAt: now });
  if (transition.kind === "transition") await appendControlAudit(deps.auditTrail.bind(transaction), { userId: input.userId, requestId: input.requestId, runId: input.runId, eventType: transition.eventType, version: snapshot.version, action: command.action, attemptCount: run.attemptCount, now });
  return { response: { applied: transition.kind === "transition", run: snapshot }, wake: transition.kind === "transition" && transition.eventType === "run.resumed" };
}

export function createAgentRunCommands(deps: CommandDependencies): {
  start: AgentRunStarter["start"];
  control(input: { userId: string; requestId: string; runId: string; command: { commandId: string; action: "pause" | "resume" | "cancel" } }): Promise<ControlAgentRunResponse>;
} {
  const starter = createAgentRunStarter(deps);
  return {
    start: starter.start,
    async control(input) {
      const command = ControlAgentRunCommandSchema.parse(input.command);
      const result = await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        return applyAgentRunControlInTransaction(transaction, { ...input, command }, deps);
      });
      if (result.wake) { try { await deps.queue.enqueue({ version: AGENT_RUN_JOB_VERSION, runId: input.runId, userId: input.userId }); } catch { /* recovery scan is authoritative */ } }
      return result.response;
    },
  };
}
