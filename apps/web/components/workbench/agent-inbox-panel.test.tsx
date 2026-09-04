import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AgentInboxPanel } from "./agent-inbox-panel";

const itemId = "4a1b0207-b852-4f86-8b1f-3b9615655ed8";
const actionId = "355eec35-befa-44ee-ac34-1e3614975d4f";
const now = "2026-09-04T08:00:00.000Z";
const item: AgentInboxItem = {
  itemId, runId: null, kind: "candidate_fact", status: "unread", reasonCode: "CANDIDATE_FACT_PENDING", budgetDimension: null,
  title: "确认工作经历", message: "发现一条候选工作经历。", basis: "来自已导入资料的可追溯片段。", impact: "确认前不会用于推荐或材料生成。", suggestedAction: "核对后确认、修改或拒绝这条事实。",
  target: { type: "candidate_fact", candidateFactId: "1a1b0207-b852-4f86-8b1f-3b9615655ed8", href: "/profile#candidate-facts" }, availableActions: ["dismiss"], createdAt: now, readAt: null, resolvedAt: null,
};

beforeEach(() => vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(actionId));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("用语义 article 呈现依据、影响、建议与可追溯目标", () => {
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);
  expect(screen.getByRole("region", { name: "需要你决定的事项" })).toBeVisible();
  expect(screen.getByRole("article", { name: "确认工作经历" })).toHaveTextContent("来自已导入资料的可追溯片段。");
  expect(screen.getByRole("article", { name: "确认工作经历" })).toHaveTextContent("确认前不会用于推荐或材料生成。");
  expect(screen.getByRole("link", { name: "查看相关记录" })).toHaveAttribute("href", "/profile#candidate-facts");
});

it("提供未读、已读、已处理筛选，并对诚实空状态说明没有事项", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [] })));
  render(<AgentInboxPanel items={[]} onResolved={vi.fn()} />);
  expect(screen.getByText("目前没有需要你决定的事项。新的确认、异常或推荐会显示在这里。")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "已处理" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/agent-inbox?status=resolved", { cache: "no-store" }));
  expect(screen.getByText("没有已处理事项。")).toBeVisible();
});

it("处理后恢复到可预测焦点，并保留拒绝或暂不可用的说明", async () => {
  const user = userEvent.setup();
  const resolved = { ...item, status: "resolved" as const, availableActions: [], readAt: now, resolvedAt: now };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ applied: true, item: resolved, run: null })));
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "标记已处理：确认工作经历" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("事项已处理。"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "待处理" })));
});

it("动作失败时保留事项并提供可恢复的错误信息", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 409 })));
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "标记已处理：确认工作经历" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("该事项状态已变化，请刷新后查看。"));
  expect(screen.getByRole("article", { name: "确认工作经历" })).toBeVisible();
});
