import { describe, expect, it } from "vitest";
import {
  AgentInboxActionCommandSchema,
  AgentInboxItemSchema,
  AgentInboxListSchema,
} from "./agent-inbox";

const itemId = "9d482ff6-a614-4ed0-bc14-97ce888c1559";
const runId = "1e764df5-19f3-49f3-b16e-512147298baa";
const targetId = "6f33fc64-1a9f-4d02-b18e-8cf403d98d20";
const actionId = "d1e8d370-16c8-44c2-bad5-483a8c0f0f0f";
const now = "2026-08-29T00:00:00.000Z";

describe("agent inbox contracts", () => {
  it("projects strict open decision items and actions", () => {
    const item = AgentInboxItemSchema.parse({
      itemId, runId, kind: "decision_required", status: "open", reasonCode: "AGENT_RUN_PAUSED",
      budgetDimension: null, title: "岗位发现已暂停", message: "选择继续或取消本次岗位发现。",
      availableActions: ["resume_run", "cancel_run"], targetHref: null, createdAt: now, resolvedAt: null,
    });
    expect(item).toMatchObject({ itemId, availableActions: ["resume_run", "cancel_run"] });
    expect(AgentInboxActionCommandSchema.parse({ actionId, action: "resume_run" }))
      .toEqual({ actionId, action: "resume_run" });
    expect(() => AgentInboxItemSchema.parse({ ...item, rawError: "secret" })).toThrow();
  });

  it("projects fixed budget and ordinary failure messages without writable text", () => {
    expect(AgentInboxItemSchema.parse({
      itemId, runId, kind: "budget_exhausted", status: "open", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED",
      budgetDimension: "tokens", title: "岗位发现预算已用尽", message: "本次岗位发现达到 Token 上限。请调整目标后重试。",
      availableActions: ["dismiss"], targetHref: "/profile/targets", createdAt: now, resolvedAt: null,
    })).toMatchObject({ kind: "budget_exhausted" });
    expect(AgentInboxItemSchema.safeParse({
      itemId, runId, kind: "run_failed", status: "open", reasonCode: "AGENT_RUN_ADAPTER_FAILED",
      budgetDimension: null, title: "任意标题", message: "任意消息", availableActions: ["restart_run", "dismiss"],
      targetHref: null, createdAt: now, resolvedAt: null,
    }).success).toBe(false);
    expect(AgentInboxListSchema.parse({ items: [] })).toEqual({ items: [] });
  });

  it("projects a redacted source-attention item only to its target watchlist diagnostics", () => {
    expect(AgentInboxItemSchema.parse({
      itemId, runId, kind: "source_attention", status: "open", reasonCode: "SOURCE_HEALTH_ATTENTION",
      budgetDimension: null, title: "部分来源需要关注", message: "部分岗位来源未完成检查。可查看诊断、稍后重试或停用来源。",
      availableActions: ["dismiss"], targetHref: `/profile/targets/${targetId}/watchlist#source-health`, createdAt: now, resolvedAt: null,
    })).toMatchObject({ kind: "source_attention", targetHref: `/profile/targets/${targetId}/watchlist#source-health` });
    expect(AgentInboxItemSchema.safeParse({
      itemId, runId, kind: "source_attention", status: "open", reasonCode: "SOURCE_HEALTH_ATTENTION",
      budgetDimension: null, title: "部分来源需要关注", message: "部分岗位来源未完成检查。可查看诊断、稍后重试或停用来源。",
      availableActions: ["dismiss"], targetHref: "/profile/targets/not-a-uuid/watchlist#source-health", createdAt: now, resolvedAt: null,
    }).success).toBe(false);
  });

  it("uses strict parameterless discriminated actions", () => {
    for (const action of ["restart_run", "resume_run", "cancel_run", "dismiss"] as const) {
      expect(AgentInboxActionCommandSchema.parse({ actionId, action })).toEqual({ actionId, action });
      expect(AgentInboxActionCommandSchema.safeParse({ actionId, action, extra: true }).success).toBe(false);
    }
  });
});
