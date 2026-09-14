import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { agentInboxItemActions, agentInboxItems, agentRunSteps, agentRuns, calibrationProposals, jobDiscoverySourceIssues, jobSourceHealthChecks, recommendationLists, recommendationResults, type Database } from "@job-copilot/database";
import { AgentInboxActionCommandSchema, AgentInboxActionResponseSchema, AgentInboxListSchema, AgentInboxReasonCodeSchema, type AgentInboxActionCommand, type AgentInboxActionResponse, type AgentInboxItem, type AgentInboxTarget } from "@job-copilot/contracts/agent-inbox";
import type { ControlAgentRunResponse, StartAgentRunCommand, StartAgentRunResponse } from "@job-copilot/contracts/agent-runs";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { AuditTrail } from "./audit-trail";
import { RunPreflightRejectedError } from "./run-preflight";
import { projectRecommendationFailure, type RecommendationFailureProjection } from "./recommendation-failure-projection";
import { AccountRunAdmissionError } from "./account-run-admission";
import { AgentRunControlError, AgentRunError } from "./agent-run-control";
import { RecommendationRunError, type createRecommendationRunCommands } from "./recommendation-runs";

type Action = AgentInboxActionCommand["action"];
type Row = typeof agentInboxItems.$inferSelect;
type Commands = { start(input: { userId: string; requestId: string; command: StartAgentRunCommand }): Promise<StartAgentRunResponse>; control(input: { userId: string; requestId: string; runId: string; command: { commandId: string; action: "pause" | "resume" | "cancel" } }): Promise<ControlAgentRunResponse> };
type RecommendationStarter = Pick<ReturnType<typeof createRecommendationRunCommands>, "start">;

export class AgentInboxError extends Error { constructor(public readonly code: "AGENT_INBOX_NOT_FOUND" | "AGENT_INBOX_ACTION_CONFLICT") { super(code); } }
export class AgentInboxActionError extends Error { constructor(public readonly code: "AGENT_INBOX_ACTION_FAILED") { super(code); } }

function isRecoverableRejection(error: unknown): error is RunPreflightRejectedError | AccountRunAdmissionError | AgentRunControlError | RecommendationRunError | AgentRunError {
  return error instanceof RunPreflightRejectedError
    || error instanceof AccountRunAdmissionError && error.code === "ACCOUNT_RUN_STOPPED"
    || error instanceof AgentRunError && error.code === "ACCOUNT_RUN_STOPPED"
    || error instanceof AgentRunControlError && error.code === "AGENT_RUN_COMMAND_ID_CONFLICT"
    || error instanceof RecommendationRunError && error.code === "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT";
}

const runCopy = {
  decision_required: ["岗位发现已暂停", "选择继续或取消本次岗位发现。", "本次运行已暂停。", "继续前不会再发现新岗位。", "选择继续或取消本次运行。"],
  run_failed: ["岗位发现未完成", "可以重新运行或标记为已处理。", "本次运行未能完成。", "本次结果可能不完整。", "重新运行，或在确认后标记为已处理。"],
  source_attention: ["部分来源需要关注", "部分岗位来源未完成检查。", "来源健康检查需要关注。", "该来源的岗位发现可能不完整。", "查看来源诊断并决定后续处理。"],
  discovery_attention: ["公开岗位发现需要关注", "部分公开岗位发现未完成。", "本次公开岗位发现需要关注。", "本次运行结果可能不完整。", "查看本次运行诊断。"],
  candidate_fact: ["有待确认的画像事实", "新的画像事实等待确认。", "已生成一条待确认的结构化画像事实。", "确认后可用于后续匹配。", "查看并确认画像事实。"],
  recommendation_list: ["新的推荐清单已生成", "可以查看最新推荐岗位。", "已生成一份新的结构化推荐清单。", "可据此安排后续求职行动。", "查看推荐清单。"],
  recommendation_result: ["本次推荐暂无合适岗位", "已完成可信推荐检查，暂未找到合适岗位。", "已发布可信的暂无推荐结果。", "本次推荐没有生成岗位清单。", "查看本次推荐结果。"],
  calibration_proposal: ["推荐校准建议待查看", "有一项推荐校准建议可供查看。", "已生成结构化校准建议。", "建议可能影响后续推荐排序。", "查看校准建议。"],
} as const;
function copyFor(item: Row) {
  if (item.kind !== "budget_exhausted") { const [title, message, basis, impact, suggestedAction] = runCopy[item.kind as keyof typeof runCopy]; return { title, message, basis, impact, suggestedAction }; }
  const message = ({ active_duration: "本次岗位发现达到活跃时间上限。", attempts: "本次岗位发现达到重试次数上限。", tool_calls: "本次岗位发现达到来源调用上限。", model_calls: "本次岗位发现达到模型调用上限。", tokens: "本次岗位发现达到 Token 上限。" } as const)[item.budgetDimension as "active_duration" | "attempts" | "tool_calls" | "model_calls" | "tokens"];
  return { title: "岗位发现预算已用尽", message, basis: "本次运行达到已配置的预算上限。", impact: "本次运行已停止，结果可能不完整。", suggestedAction: "调整目标后重新运行。" };
}
function actions(item: Row, retryable: boolean): Action[] {
  const terminalActions: Action[] = item.kind === "decision_required" ? ["resume_run", "cancel_run"] : item.kind === "run_failed" && retryable ? ["restart_run", "dismiss"] : ["dismiss"];
  return item.status === "unread" ? ["mark_read", ...terminalActions] : terminalActions;
}
function snapshot(run: typeof agentRuns.$inferSelect) { return { runId: run.id, status: run.status, currentStep: run.currentStep, controlState: run.controlState, version: run.version } as ControlAgentRunResponse["run"]; }
async function itemFor(db: Pick<Database, "select">, userId: string, itemId: string) { return (await db.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.id, itemId))))[0]; }
function auditReason(item: Row) { return AgentInboxReasonCodeSchema.parse(item.reasonCode); }

async function targetFor(db: Pick<Database, "select">, userId: string, item: Row): Promise<AgentInboxTarget> {
  if (item.kind === "candidate_fact" && item.candidateFactId) return { type: "candidate_fact", candidateFactId: item.candidateFactId, href: "/profile#candidate-facts" };
  if (item.kind === "recommendation_list" && item.recommendationListId) { const list = (await db.select({ targetId: recommendationLists.targetId }).from(recommendationLists).where(and(eq(recommendationLists.userId, userId), eq(recommendationLists.id, item.recommendationListId))))[0]; if (list) return { type: "recommendation_list", recommendationListId: item.recommendationListId, targetId: list.targetId, href: `/recommendations?targetId=${list.targetId}&recommendationListId=${item.recommendationListId}#recommendation-list` }; }
  if (item.kind === "recommendation_result" && item.recommendationResultId) {
    const result = (await db.select({ rootRunId: recommendationResults.rootRunId, targetId: recommendationResults.targetId }).from(recommendationResults).where(and(eq(recommendationResults.userId, userId), eq(recommendationResults.id, item.recommendationResultId))))[0];
    if (result) return { type: "recommendation_result", recommendationResultId: item.recommendationResultId, rootRunId: result.rootRunId, targetId: result.targetId, href: `/recommendations?runId=${result.rootRunId}&resultId=${item.recommendationResultId}#recommendation-result` };
  }
  if (item.kind === "calibration_proposal" && item.calibrationProposalId) { const proposal = (await db.select({ targetId: calibrationProposals.targetId }).from(calibrationProposals).where(and(eq(calibrationProposals.userId, userId), eq(calibrationProposals.id, item.calibrationProposalId))))[0]; if (proposal) return { type: "calibration_proposal", proposalId: item.calibrationProposalId, targetId: proposal.targetId, href: `/recommendations?targetId=${proposal.targetId}#calibration-proposal` }; }
  if (item.kind === "source_attention" && item.runId && item.watchlistItemId && item.sourceHealthCheckId) { const check = (await db.select({ targetId: jobSourceHealthChecks.targetId }).from(jobSourceHealthChecks).where(and(eq(jobSourceHealthChecks.userId, userId), eq(jobSourceHealthChecks.runId, item.runId), eq(jobSourceHealthChecks.watchlistItemId, item.watchlistItemId), eq(jobSourceHealthChecks.id, item.sourceHealthCheckId))))[0]; if (check) return { type: "job_source", watchlistItemId: item.watchlistItemId, targetId: check.targetId, href: `/profile/targets/${check.targetId}/watchlist#source-health` }; }
  if (item.runId) {
    const physical = (await db.select({ id: agentRuns.id, parentRunId: agentRuns.parentRunId, runPurpose: agentRuns.runPurpose, targetId: agentRuns.targetId }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, item.runId))))[0];
    if (!physical) throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
    if (physical.runPurpose === "recommendation") {
      const rootRunId = physical.parentRunId ?? physical.id;
      const root = (await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, rootRunId), eq(agentRuns.targetId, physical.targetId), eq(agentRuns.runPurpose, "recommendation"), isNull(agentRuns.parentRunId)))).at(0);
      if (root) return { type: "recommendation_run", physicalRunId: physical.id, rootRunId: root.id, targetId: physical.targetId, href: `/home?runId=${root.id}#recommendation-run` };
      throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
    }
    return { type: "agent_run", runId: item.runId, href: `/home?runId=${item.runId}#agent-run` };
  }
  throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
}
function stageForPhysicalRun(input: { parentRunId: string | null; currentStep: string; failedStepKey: string | null }) {
  if (!input.parentRunId) return "discovery" as const;
  return input.failedStepKey === "create_recommendations" || input.currentStep === "create_recommendations" ? "result_publication" as const : "deep_matching" as const;
}
async function recommendationFailureFor(db: Pick<Database, "select">, userId: string, item: Row, target: AgentInboxTarget): Promise<RecommendationFailureProjection | null> {
  if (target.type !== "recommendation_run" || (item.kind !== "run_failed" && item.kind !== "budget_exhausted")) return null;
  const physical = (await db.select({ parentRunId: agentRuns.parentRunId, currentStep: agentRuns.currentStep, failureCode: agentRuns.failureCode }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, target.physicalRunId))))[0];
  if (!physical) throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
  const [failedStep] = await db.select({ stepKey: agentRunSteps.stepKey }).from(agentRunSteps).where(and(eq(agentRunSteps.userId, userId), eq(agentRunSteps.runId, target.physicalRunId), eq(agentRunSteps.status, "failed"))).limit(1);
  const failureCode = (item.kind === "budget_exhausted" ? "AGENT_RUN_BUDGET_EXCEEDED" : physical.failureCode ?? item.reasonCode) as Parameters<typeof projectRecommendationFailure>[0]["failureCode"];
  const hasSourceCapabilityDiagnosis = failureCode === "AGENT_RUN_ADAPTER_FAILED" && (await db.select({ id: jobDiscoverySourceIssues.id }).from(jobDiscoverySourceIssues).where(and(eq(jobDiscoverySourceIssues.userId, userId), eq(jobDiscoverySourceIssues.runId, target.physicalRunId), inArray(jobDiscoverySourceIssues.code, ["SOURCE_CAPABILITY_UNSUPPORTED", "SOURCE_CAPABILITY_DECLARATION_MISMATCH"]))).limit(1)).length > 0;
  return projectRecommendationFailure({ failureCode, stage: stageForPhysicalRun({ parentRunId: physical.parentRunId, currentStep: physical.currentStep, failedStepKey: failedStep?.stepKey ?? null }), hasSourceCapabilityDiagnosis });
}
async function projectionFor(db: Pick<Database, "select">, userId: string, item: Row) {
  const target = await targetFor(db, userId, item);
  const recommendationFailure = await recommendationFailureFor(db, userId, item, target);
  const fallback = copyFor(item);
  const retryable = recommendationFailure?.retryable ?? (item.kind === "run_failed");
  return {
    target, retryable, suggestedActions: recommendationFailure?.suggestedActions ?? [],
    ...(recommendationFailure ? { title: recommendationFailure.summary, message: recommendationFailure.summary, basis: recommendationFailure.basis, impact: recommendationFailure.impact, suggestedAction: recommendationFailure.suggestedAction } : fallback),
  };
}
async function actionsFor(db: Pick<Database, "select">, userId: string, item: Row) { const projection = await projectionFor(db, userId, item); return actions(item, projection.retryable); }
async function accepts(db: Pick<Database, "select">, userId: string, item: Row, action: Action) { return action !== "mark_read" && (await actionsFor(db, userId, item)).includes(action); }
async function project(db: Pick<Database, "select">, userId: string, item: Row): Promise<AgentInboxItem> { const projection = await projectionFor(db, userId, item); return { itemId: item.id, runId: item.runId, kind: item.kind as AgentInboxItem["kind"], status: item.status as AgentInboxItem["status"], reasonCode: item.reasonCode as AgentInboxItem["reasonCode"], budgetDimension: item.budgetDimension as AgentInboxItem["budgetDimension"], ...projection, availableActions: item.status === "resolved" ? [] : actions(item, projection.retryable), createdAt: item.createdAt.toISOString(), readAt: item.readAt?.toISOString() ?? null, resolvedAt: item.resolvedAt?.toISOString() ?? null } as AgentInboxItem; }

export type AgentInbox = { list(input: { userId: string; status: "unread" | "read" | "resolved" | "pending" }): Promise<{ items: AgentInboxItem[] }>; act(input: { userId: string; requestId: string; itemId: string; command: AgentInboxActionCommand }): Promise<AgentInboxActionResponse> };
export function createAgentInbox(deps: { db: Database; commands: Commands; recommendationCommands?: RecommendationStarter; auditTrail: AuditTrail; id: () => string; clock: () => Date }): AgentInbox {
  const response = async (userId: string, itemId: string, relatedRunId: string | null, applied: boolean) => { const item = await itemFor(deps.db, userId, itemId); if (!item) throw new AgentInboxError("AGENT_INBOX_NOT_FOUND"); const run = relatedRunId ? (await deps.db.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, relatedRunId))))[0] : undefined; return AgentInboxActionResponseSchema.parse({ applied, item: await project(deps.db, userId, item), run: run ? snapshot(run) : null }); };
  const claim = async (userId: string, itemId: string, actionId: string, action: Action) => deps.db.transaction(async (tx) => {
    await acquireAccountAdvisoryLock(tx, userId); const item = await itemFor(tx, userId, itemId); if (!item) throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
    const prior = (await tx.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, userId), eq(agentInboxItemActions.itemId, itemId), eq(agentInboxItemActions.actionId, actionId))))[0];
    if (prior) { if (prior.action !== action) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT"); if (prior.outcome === "failed") throw new AgentInboxActionError("AGENT_INBOX_ACTION_FAILED"); if (prior.outcome === "pending" && action !== "mark_read" && !(await accepts(tx, userId, item, action))) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT"); return { item, replay: prior.outcome !== "pending", applied: prior.outcome === "applied", relatedRunId: prior.relatedRunId }; }
    if (item.status === "resolved" || !(await accepts(tx, userId, item, action)) && action !== "mark_read") throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT");
    const others = await tx.select({ action: agentInboxItemActions.action, outcome: agentInboxItemActions.outcome }).from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, userId), eq(agentInboxItemActions.itemId, itemId)));
    if (action !== "mark_read" && others.some((other) => other.action !== "mark_read" && other.outcome !== "failed")) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT");
    await tx.insert(agentInboxItemActions).values({ id: deps.id(), userId, itemId, actionId, action, outcome: "pending", relatedRunId: null, reasonCode: null, createdAt: deps.clock() }); return { item, replay: false, applied: false, relatedRunId: null };
  });
  const markRead = async (userId: string, requestId: string, itemId: string, actionId: string) => deps.db.transaction(async (tx) => { await acquireAccountAdvisoryLock(tx, userId); const item = await itemFor(tx, userId, itemId); const prior = (await tx.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, userId), eq(agentInboxItemActions.itemId, itemId), eq(agentInboxItemActions.actionId, actionId))))[0]; if (!item || !prior) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT"); if (prior.outcome !== "pending") return prior.outcome === "applied"; const applied = item.status === "unread"; if (applied) await tx.update(agentInboxItems).set({ status: "read", readAt: deps.clock() }).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.id, itemId), eq(agentInboxItems.status, "unread"))); await tx.update(agentInboxItemActions).set({ outcome: applied ? "applied" : "no_change", reasonCode: item.reasonCode }).where(eq(agentInboxItemActions.id, prior.id)); await deps.auditTrail.bind(tx).append({ userId, actorUserId: userId, eventType: "agent.inbox_action_applied", occurredAt: deps.clock(), requestId, outcome: "success", reasonCode: auditReason(item), resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: "mark_read", outcome: applied ? "applied" : "no_change", reasonCode: auditReason(item) } }); return applied; });
  const failAction = async (input: { userId: string; requestId: string; itemId: string; actionId: string; action: Exclude<Action, "mark_read"> }) => deps.db.transaction(async (tx) => {
    await acquireAccountAdvisoryLock(tx, input.userId);
    const item = await itemFor(tx, input.userId, input.itemId);
    if (!item) throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
    const [failed] = await tx.update(agentInboxItemActions).set({ outcome: "failed", reasonCode: "AGENT_INBOX_ACTION_FAILED" }).where(and(eq(agentInboxItemActions.userId, input.userId), eq(agentInboxItemActions.itemId, input.itemId), eq(agentInboxItemActions.actionId, input.actionId), eq(agentInboxItemActions.action, input.action), eq(agentInboxItemActions.outcome, "pending"))).returning({ outcome: agentInboxItemActions.outcome, relatedRunId: agentInboxItemActions.relatedRunId });
    if (failed) {
      await deps.auditTrail.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_action_applied", occurredAt: deps.clock(), requestId: input.requestId, outcome: "failure", reasonCode: "AGENT_INBOX_ACTION_FAILED", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: input.action, outcome: "failed", reasonCode: "AGENT_INBOX_ACTION_FAILED" } });
      return { applied: false, relatedRunId: null };
    }
    const [prior] = await tx.select({ outcome: agentInboxItemActions.outcome, relatedRunId: agentInboxItemActions.relatedRunId }).from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, input.userId), eq(agentInboxItemActions.itemId, input.itemId), eq(agentInboxItemActions.actionId, input.actionId), eq(agentInboxItemActions.action, input.action)));
    if (!prior) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT");
    return { applied: prior.outcome === "applied", relatedRunId: prior.relatedRunId };
  });
  // 预检拒绝尚未执行任何动作：只释放本次 owner 的 pending claim，不能写失败审计或影响其他 claim。
  const releaseRecoverableClaim = async (input: { userId: string; itemId: string; actionId: string; action: Exclude<Action, "mark_read"> }) => deps.db.transaction(async (tx) => {
    await acquireAccountAdvisoryLock(tx, input.userId);
    await tx.delete(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, input.userId), eq(agentInboxItemActions.itemId, input.itemId), eq(agentInboxItemActions.actionId, input.actionId), eq(agentInboxItemActions.action, input.action), eq(agentInboxItemActions.outcome, "pending")));
  });
  const settle = async (input: { userId: string; requestId: string; itemId: string; actionId: string; action: Exclude<Action, "mark_read">; relatedRunId: string | null; retryOfRunId?: string }) => deps.db.transaction(async (tx) => { await acquireAccountAdvisoryLock(tx, input.userId); const item = await itemFor(tx, input.userId, input.itemId); if (!item || !(await accepts(tx, input.userId, item, input.action))) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT"); const reasonCode = auditReason(item); const [settled] = await tx.update(agentInboxItemActions).set({ outcome: "applied", relatedRunId: input.relatedRunId, reasonCode: item.reasonCode }).where(and(eq(agentInboxItemActions.userId, input.userId), eq(agentInboxItemActions.itemId, input.itemId), eq(agentInboxItemActions.actionId, input.actionId), eq(agentInboxItemActions.action, input.action), eq(agentInboxItemActions.outcome, "pending"))).returning({ id: agentInboxItemActions.id }); if (!settled) { const [prior] = await tx.select({ outcome: agentInboxItemActions.outcome }).from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, input.userId), eq(agentInboxItemActions.itemId, input.itemId), eq(agentInboxItemActions.actionId, input.actionId), eq(agentInboxItemActions.action, input.action))); if (prior?.outcome === "applied") return true; throw new AgentInboxActionError("AGENT_INBOX_ACTION_FAILED"); } if (item.status === "resolved") { await deps.auditTrail.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_action_applied", occurredAt: deps.clock(), requestId: input.requestId, outcome: "success", reasonCode, resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: input.action, outcome: "applied", reasonCode } }); return true; } if (input.retryOfRunId && input.relatedRunId) await tx.update(agentRuns).set({ retryOfRunId: input.retryOfRunId }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.relatedRunId))); await tx.update(agentInboxItems).set({ status: "resolved", resolvedAt: deps.clock() }).where(and(eq(agentInboxItems.userId, input.userId), eq(agentInboxItems.id, input.itemId), inArray(agentInboxItems.status, ["unread", "read"]))); await deps.auditTrail.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_resolved", occurredAt: deps.clock(), requestId: input.requestId, outcome: "success", reasonCode, resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: input.action, reasonCode } }); await deps.auditTrail.bind(tx).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_action_applied", occurredAt: deps.clock(), requestId: input.requestId, outcome: "success", reasonCode, resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: input.action, outcome: "applied", reasonCode } }); return true; });
  return {
    async list({ userId, status }) { const where = status === "pending" ? and(eq(agentInboxItems.userId, userId), inArray(agentInboxItems.status, ["unread", "read"])) : and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.status, status)); const rows = await deps.db.select().from(agentInboxItems).where(where).orderBy(desc(agentInboxItems.createdAt), desc(agentInboxItems.id)); return AgentInboxListSchema.parse({ items: await Promise.all(rows.map((item) => project(deps.db, userId, item))) }); },
    async act(input) { const command = AgentInboxActionCommandSchema.parse(input.command); const owned = await claim(input.userId, input.itemId, command.actionId, command.action); if (owned.replay) return response(input.userId, input.itemId, owned.relatedRunId, owned.applied); if (command.action === "mark_read") return response(input.userId, input.itemId, null, await markRead(input.userId, input.requestId, input.itemId, command.actionId)); if (command.action === "dismiss") return response(input.userId, input.itemId, null, await settle({ userId: input.userId, requestId: input.requestId, itemId: input.itemId, actionId: command.actionId, action: command.action, relatedRunId: null })); if (command.action === "restart_run") { let relatedRunId: string; let recommendation = false; try { const target = await targetFor(deps.db, input.userId, owned.item); if (target.type === "recommendation_run") { if (!deps.recommendationCommands) throw new Error("RECOMMENDATION_COMMANDS_UNAVAILABLE"); recommendation = true; const started = await deps.recommendationCommands.start({ userId: input.userId, requestId: input.requestId, command: { idempotencyKey: command.actionId, warningFingerprint: command.warningFingerprint ?? null } }); relatedRunId = started.run.runId; } else { const run = (await deps.db.select({ targetId: agentRuns.targetId }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, owned.item.runId!))))[0]; const started = await deps.commands.start({ userId: input.userId, requestId: input.requestId, command: { targetId: run?.targetId ?? "", idempotencyKey: command.actionId, warningFingerprint: command.warningFingerprint ?? null } }); relatedRunId = started.runId; } } catch (error) { if (isRecoverableRejection(error)) { await releaseRecoverableClaim({ userId: input.userId, itemId: input.itemId, actionId: command.actionId, action: command.action }); throw error; } const terminal = await failAction({ userId: input.userId, requestId: input.requestId, itemId: input.itemId, actionId: command.actionId, action: command.action }); if (terminal.applied) return response(input.userId, input.itemId, terminal.relatedRunId, true); throw new AgentInboxActionError("AGENT_INBOX_ACTION_FAILED"); } await settle({ userId: input.userId, requestId: input.requestId, itemId: input.itemId, actionId: command.actionId, action: command.action, relatedRunId, ...(recommendation ? {} : { retryOfRunId: owned.item.runId! }) }); return response(input.userId, input.itemId, relatedRunId, true); } let controlled: ControlAgentRunResponse; try { controlled = await deps.commands.control({ userId: input.userId, requestId: input.requestId, runId: owned.item.runId!, command: { commandId: command.actionId, action: command.action === "resume_run" ? "resume" : "cancel" } }); } catch (error) { if (isRecoverableRejection(error)) { await releaseRecoverableClaim({ userId: input.userId, itemId: input.itemId, actionId: command.actionId, action: command.action }); throw error; } const terminal = await failAction({ userId: input.userId, requestId: input.requestId, itemId: input.itemId, actionId: command.actionId, action: command.action }); if (terminal.applied) return response(input.userId, input.itemId, terminal.relatedRunId, true); throw new AgentInboxActionError("AGENT_INBOX_ACTION_FAILED"); } await settle({ userId: input.userId, requestId: input.requestId, itemId: input.itemId, actionId: command.actionId, action: command.action, relatedRunId: controlled.run.runId }); return response(input.userId, input.itemId, controlled.run.runId, true); },
  };
}
