import { and, asc, eq } from "drizzle-orm";
import { agentInboxItemActions, agentInboxItems, agentRuns, type Database } from "@job-copilot/database";
import {
  AgentInboxActionCommandSchema, AgentInboxActionResponseSchema, AgentInboxListSchema,
  type AgentInboxActionCommand, type AgentInboxActionResponse, type AgentInboxItem,
} from "@job-copilot/contracts/agent-inbox";
import type { ControlAgentRunResponse, StartAgentRunCommand, StartAgentRunResponse } from "@job-copilot/contracts/agent-runs";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { AuditTrail } from "./audit-trail";

type InboxAction = AgentInboxActionCommand["action"];
type InboxItemRow = typeof agentInboxItems.$inferSelect;
type Commands = {
  start(input: { userId: string; requestId: string; command: StartAgentRunCommand }): Promise<StartAgentRunResponse>;
  control(input: { userId: string; requestId: string; runId: string; command: { commandId: string; action: "pause" | "resume" | "cancel" } }): Promise<ControlAgentRunResponse>;
};

export class AgentInboxError extends Error {
  constructor(public readonly code: "AGENT_INBOX_NOT_FOUND" | "AGENT_INBOX_ACTION_CONFLICT") { super(code); }
}

function projection(item: InboxItemRow): AgentInboxItem {
  const open = item.status === "open";
  const common = {
    itemId: item.id, runId: item.runId, kind: item.kind, status: item.status, reasonCode: item.reasonCode,
    budgetDimension: item.budgetDimension, createdAt: item.createdAt.toISOString(), resolvedAt: item.resolvedAt?.toISOString() ?? null,
  } as const;
  if (item.kind === "decision_required") return { ...common, title: "岗位发现已暂停", message: "选择继续或取消本次岗位发现。", availableActions: open ? ["resume_run", "cancel_run"] : [], targetHref: null } as AgentInboxItem;
  if (item.kind === "run_failed") return { ...common, title: "岗位发现未完成", message: "可以重新运行或标记为已处理。", availableActions: open ? ["restart_run", "dismiss"] : [], targetHref: null } as AgentInboxItem;
  const messages = {
    active_duration: "本次岗位发现达到活跃时间上限。请调整目标后重试。",
    attempts: "本次岗位发现达到重试次数上限。请调整目标后重试。",
    tool_calls: "本次岗位发现达到来源调用上限。请调整目标后重试。",
    model_calls: "本次岗位发现达到模型调用上限。请调整目标后重试。",
    tokens: "本次岗位发现达到 Token 上限。请调整目标后重试。",
  } as const;
  return { ...common, title: "岗位发现预算已用尽", message: messages[item.budgetDimension as keyof typeof messages], availableActions: open ? ["dismiss"] : [], targetHref: "/profile/targets" } as AgentInboxItem;
}

function accepts(item: InboxItemRow, action: InboxAction) {
  return (item.kind === "decision_required" && (action === "resume_run" || action === "cancel_run"))
    || (item.kind === "run_failed" && (action === "restart_run" || action === "dismiss"))
    || (item.kind === "budget_exhausted" && action === "dismiss");
}

function snapshot(run: typeof agentRuns.$inferSelect) {
  return { runId: run.id, status: run.status, currentStep: run.currentStep, controlState: run.controlState, version: run.version } as ControlAgentRunResponse["run"];
}

async function itemFor(database: Pick<Database, "select">, userId: string, itemId: string) {
  const [item] = await database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.id, itemId)));
  return item;
}

export function createAgentInbox(deps: { db: Database; commands: Commands; auditTrail: AuditTrail; id: () => string; clock: () => Date }): {
  list(input: { userId: string; status: "open" | "resolved" }): Promise<{ items: AgentInboxItem[] }>;
  act(input: { userId: string; requestId: string; itemId: string; command: AgentInboxActionCommand }): Promise<AgentInboxActionResponse>;
} {
  async function response(userId: string, itemId: string, relatedRunId: string | null, applied: boolean): Promise<AgentInboxActionResponse> {
    const item = await itemFor(deps.db, userId, itemId);
    if (!item) throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
    const [run] = relatedRunId ? await deps.db.select().from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.id, relatedRunId))) : [];
    return AgentInboxActionResponseSchema.parse({ applied, item: projection(item), run: run ? snapshot(run) : null });
  }

  async function recordFailure(input: { userId: string; requestId: string; itemId: string; actionId: string; action: InboxAction }) {
    const now = deps.clock();
    await deps.db.transaction(async (transaction) => {
      await acquireAccountAdvisoryLock(transaction, input.userId);
      const item = await itemFor(transaction, input.userId, input.itemId);
      if (!item || item.status !== "open") return;
      const [prior] = await transaction.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, input.userId), eq(agentInboxItemActions.itemId, input.itemId), eq(agentInboxItemActions.actionId, input.actionId)));
      if (prior) return;
      await transaction.insert(agentInboxItemActions).values({ id: deps.id(), userId: input.userId, itemId: item.id, actionId: input.actionId, action: input.action, outcome: "failed", relatedRunId: null, reasonCode: item.reasonCode, createdAt: now });
      const reasonCode = item.reasonCode as AgentInboxItem["reasonCode"];
      await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_action_applied", occurredAt: now, requestId: input.requestId, outcome: "failure", reasonCode, resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: input.action, outcome: "failed", reasonCode } });
    });
  }

  async function resolveAndRecord(input: { userId: string; requestId: string; itemId: string; actionId: string; action: InboxAction; relatedRunId: string | null; retryOfRunId?: string; alreadyResolved?: boolean }) {
    const now = deps.clock();
    return deps.db.transaction(async (transaction) => {
      await acquireAccountAdvisoryLock(transaction, input.userId);
      const item = await itemFor(transaction, input.userId, input.itemId);
      if (!item) throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
      const [prior] = await transaction.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, input.userId), eq(agentInboxItemActions.itemId, input.itemId), eq(agentInboxItemActions.actionId, input.actionId)));
      if (prior) {
        if (prior.action !== input.action) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT");
        return { replay: true, applied: prior.outcome === "applied", relatedRunId: prior.relatedRunId };
      }
      if (!accepts(item, input.action)) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT");
      if (item.status !== "open") {
        const outcome = input.alreadyResolved ? "applied" : "no_change";
        await transaction.insert(agentInboxItemActions).values({ id: deps.id(), userId: input.userId, itemId: item.id, actionId: input.actionId, action: input.action, outcome, relatedRunId: input.relatedRunId, reasonCode: item.reasonCode, createdAt: now });
        if (input.alreadyResolved) {
          const reasonCode = item.reasonCode as AgentInboxItem["reasonCode"];
          await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_action_applied", occurredAt: now, requestId: input.requestId, outcome: "success", reasonCode, resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: input.action, outcome: "applied", reasonCode } });
        }
        return { replay: false, applied: input.alreadyResolved ?? false, relatedRunId: input.relatedRunId };
      }
      if (input.retryOfRunId && input.relatedRunId) await transaction.update(agentRuns).set({ retryOfRunId: input.retryOfRunId }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.relatedRunId)));
      if (item.status === "open") {
        await transaction.update(agentInboxItems).set({ status: "resolved", resolvedAt: now }).where(and(eq(agentInboxItems.userId, input.userId), eq(agentInboxItems.id, item.id), eq(agentInboxItems.status, "open")));
        const reasonCode = item.reasonCode as AgentInboxItem["reasonCode"];
        await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_resolved", occurredAt: now, requestId: input.requestId, outcome: "success", reasonCode, resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: input.action, reasonCode } });
      }
      await transaction.insert(agentInboxItemActions).values({ id: deps.id(), userId: input.userId, itemId: item.id, actionId: input.actionId, action: input.action, outcome: "applied", relatedRunId: input.relatedRunId, reasonCode: item.reasonCode, createdAt: now });
      const reasonCode = item.reasonCode as AgentInboxItem["reasonCode"];
      await deps.auditTrail.bind(transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "agent.inbox_action_applied", occurredAt: now, requestId: input.requestId, outcome: "success", reasonCode, resourceType: "agent_inbox_item", resourceId: item.id, metadata: { itemId: item.id, runId: item.runId, action: input.action, outcome: "applied", reasonCode } });
      return { replay: false, applied: true, relatedRunId: input.relatedRunId };
    });
  }

  return {
    async list({ userId, status }) {
      const rows = await deps.db.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.status, status))).orderBy(asc(agentInboxItems.createdAt), asc(agentInboxItems.id));
      return AgentInboxListSchema.parse({ items: rows.map(projection) });
    },
    async act(input) {
      const command = AgentInboxActionCommandSchema.parse(input.command);
      const item = await itemFor(deps.db, input.userId, input.itemId);
      if (!item) throw new AgentInboxError("AGENT_INBOX_NOT_FOUND");
      const [prior] = await deps.db.select().from(agentInboxItemActions).where(and(eq(agentInboxItemActions.userId, input.userId), eq(agentInboxItemActions.itemId, item.id), eq(agentInboxItemActions.actionId, command.actionId)));
      if (prior) {
        if (prior.action !== command.action) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT");
        return response(input.userId, item.id, prior.relatedRunId, prior.outcome === "applied");
      }
      if (!accepts(item, command.action)) throw new AgentInboxError("AGENT_INBOX_ACTION_CONFLICT");
      if (item.status !== "open") {
        const settled = await resolveAndRecord({ userId: input.userId, requestId: input.requestId, itemId: item.id, actionId: command.actionId, action: command.action, relatedRunId: null });
        return response(input.userId, item.id, settled.relatedRunId, settled.applied);
      }
      if (command.action === "dismiss") {
        const settled = await resolveAndRecord({ userId: input.userId, requestId: input.requestId, itemId: item.id, actionId: command.actionId, action: command.action, relatedRunId: null });
        return response(input.userId, item.id, settled.relatedRunId, settled.applied);
      }
      if (command.action === "restart_run") {
        let started: StartAgentRunResponse;
        try {
          started = await deps.commands.start({ userId: input.userId, requestId: input.requestId, command: { targetId: (await deps.db.select({ targetId: agentRuns.targetId }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, item.runId))))[0]?.targetId ?? "", idempotencyKey: command.actionId } });
        } catch (error) {
          await recordFailure({ userId: input.userId, requestId: input.requestId, itemId: item.id, actionId: command.actionId, action: command.action });
          throw error;
        }
        const settled = await resolveAndRecord({ userId: input.userId, requestId: input.requestId, itemId: item.id, actionId: command.actionId, action: command.action, relatedRunId: started.runId, retryOfRunId: item.runId });
        return response(input.userId, item.id, settled.relatedRunId, settled.applied);
      }
      let controlled: ControlAgentRunResponse;
      try {
        controlled = await deps.commands.control({ userId: input.userId, requestId: input.requestId, runId: item.runId, command: { commandId: command.actionId, action: command.action === "resume_run" ? "resume" : "cancel" } });
      } catch (error) {
        await recordFailure({ userId: input.userId, requestId: input.requestId, itemId: item.id, actionId: command.actionId, action: command.action });
        throw error;
      }
      const settled = await resolveAndRecord({ userId: input.userId, requestId: input.requestId, itemId: item.id, actionId: command.actionId, action: command.action, relatedRunId: controlled.run.runId, alreadyResolved: controlled.applied });
      return response(input.userId, item.id, settled.relatedRunId, settled.applied);
    },
  };
}
