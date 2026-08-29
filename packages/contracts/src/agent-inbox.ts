import { z } from "zod";
import {
  AgentRunBudgetDimensionSchema,
  AgentRunControlSnapshotSchema,
  AgentRunFailureCodeSchema,
} from "./agent-runs";

export const AgentInboxKindSchema = z.enum(["run_failed", "budget_exhausted", "decision_required"]);
export const AgentInboxStatusSchema = z.enum(["open", "resolved"]);
export const AgentInboxActionSchema = z.enum(["restart_run", "resume_run", "cancel_run", "dismiss"]);
export const AgentInboxReasonCodeSchema = z.union([z.literal("AGENT_RUN_PAUSED"), AgentRunFailureCodeSchema]);

const budgetMessages = {
  active_duration: "本次岗位发现达到活跃时间上限。请调整目标后重试。",
  attempts: "本次岗位发现达到重试次数上限。请调整目标后重试。",
  tool_calls: "本次岗位发现达到来源调用上限。请调整目标后重试。",
  model_calls: "本次岗位发现达到模型调用上限。请调整目标后重试。",
  tokens: "本次岗位发现达到 Token 上限。请调整目标后重试。",
} as const;

const sameActions = (actual: readonly string[], expected: readonly string[]) => actual.length === expected.length && actual.every((action, index) => action === expected[index]);
const nonBudgetFailureCodes = new Set<string>(AgentRunFailureCodeSchema.options.filter((code) => code !== "AGENT_RUN_BUDGET_EXCEEDED"));

export const AgentInboxItemSchema = z.object({
  itemId: z.uuid(), runId: z.uuid(), kind: AgentInboxKindSchema, status: AgentInboxStatusSchema,
  reasonCode: AgentInboxReasonCodeSchema, budgetDimension: AgentRunBudgetDimensionSchema.nullable(),
  title: z.string().trim().min(1).max(200), message: z.string().trim().min(1).max(500),
  availableActions: z.array(AgentInboxActionSchema).max(2), targetHref: z.string().startsWith("/").nullable(),
  createdAt: z.iso.datetime(), resolvedAt: z.iso.datetime().nullable(),
}).strict().superRefine((item, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  const isOpen = item.status === "open";
  if (isOpen !== (item.resolvedAt === null)) issue("resolvedAt", "open items require null resolvedAt");
  if (!isOpen && item.availableActions.length !== 0) issue("availableActions", "resolved items have no actions");
  if (item.kind === "decision_required") {
    if (item.reasonCode !== "AGENT_RUN_PAUSED" || item.budgetDimension !== null || item.title !== "岗位发现已暂停" || item.message !== "选择继续或取消本次岗位发现。" || item.targetHref !== null) issue("kind", "invalid decision projection");
    if (isOpen && !sameActions(item.availableActions, ["resume_run", "cancel_run"])) issue("availableActions", "invalid decision actions");
  }
  if (item.kind === "run_failed") {
    if (!nonBudgetFailureCodes.has(item.reasonCode) || item.budgetDimension !== null || item.title !== "岗位发现未完成" || item.message !== "可以重新运行或标记为已处理。" || item.targetHref !== null) issue("kind", "invalid failure projection");
    if (isOpen && !sameActions(item.availableActions, ["restart_run", "dismiss"])) issue("availableActions", "invalid failure actions");
  }
  if (item.kind === "budget_exhausted") {
    if (item.reasonCode !== "AGENT_RUN_BUDGET_EXCEEDED" || item.budgetDimension === null || item.title !== "岗位发现预算已用尽" || item.targetHref !== "/profile/targets" || item.message !== budgetMessages[item.budgetDimension]) issue("kind", "invalid budget projection");
    if (isOpen && !sameActions(item.availableActions, ["dismiss"])) issue("availableActions", "invalid budget actions");
  }
});

export const AgentInboxListSchema = z.object({ items: z.array(AgentInboxItemSchema) }).strict();
export const AgentInboxActionCommandSchema = z.discriminatedUnion("action", [
  z.object({ actionId: z.uuid(), action: z.literal("restart_run") }).strict(),
  z.object({ actionId: z.uuid(), action: z.literal("resume_run") }).strict(),
  z.object({ actionId: z.uuid(), action: z.literal("cancel_run") }).strict(),
  z.object({ actionId: z.uuid(), action: z.literal("dismiss") }).strict(),
]);
export const AgentInboxActionResponseSchema = z.object({
  applied: z.boolean(), item: AgentInboxItemSchema, run: AgentRunControlSnapshotSchema.nullable(),
}).strict();

export type AgentInboxItem = z.infer<typeof AgentInboxItemSchema>;
export type AgentInboxActionCommand = z.infer<typeof AgentInboxActionCommandSchema>;
