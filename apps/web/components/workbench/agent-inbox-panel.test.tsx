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
  target: { type: "candidate_fact", candidateFactId: "1a1b0207-b852-4f86-8b1f-3b9615655ed8", href: "/profile#candidate-facts" }, availableActions: ["mark_read", "dismiss"], createdAt: now, readAt: null, resolvedAt: null,
};

beforeEach(() => vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(actionId));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("用语义 article 呈现依据、影响、建议与可追溯目标", () => {
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);
  expect(screen.getByRole("region", { name: "需要你决定的事项" })).toBeVisible();
  expect(screen.getByRole("article", { name: "确认工作经历" })).toHaveTextContent("来自已导入资料的可追溯片段。");
  expect(screen.getByRole("article", { name: "确认工作经历" })).toHaveTextContent("确认前不会用于推荐或材料生成。");
  expect(screen.getByRole("link", { name: "查看相关记录" })).toHaveAttribute("href", "/profile#candidate-facts");
  expect(screen.getByRole("button", { name: "标记为已读：确认工作经历" })).toBeVisible();
  expect(screen.getByText("核对后确认、修改或拒绝这条事实。")).toBeVisible();
});

it("restart 收到 warning 预检后只允许以同一 actionId 明确确认", async () => {
  const user = userEvent.setup();
  const failed: AgentInboxItem = { ...item, runId: "7a1b0207-b852-4f86-8b1f-3b9615655ed8", kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED", title: "岗位发现未完成", target: { type: "agent_run", runId: "7a1b0207-b852-4f86-8b1f-3b9615655ed8", href: "/home?runId=7a1b0207-b852-4f86-8b1f-3b9615655ed8#agent-run" }, availableActions: ["mark_read", "restart_run", "dismiss"] };
  const fingerprint = "a".repeat(64);
  const preflight = { code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", message: "请确认当前运行前检查提示", preflight: { version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId: "8a1b0207-b852-4f86-8b1f-3b9615655ed8", status: "ready_with_warnings", warningFingerprint: fingerprint, checkedAt: now, items: [{ code: "SOURCE_HEALTH_UNCHECKED", severity: "warning", summary: "来源尚未完成健康检查", impact: "运行可以继续，建议稍后查看来源健康状态。", retryable: true, suggestedActions: ["review_source_health"], evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null } }] } };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(preflight, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ applied: true, item: { ...failed, status: "resolved", availableActions: [], resolvedAt: now }, run: null })));
  render(<AgentInboxPanel items={[failed]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "重新开始岗位发现：岗位发现未完成" }));
  expect(await screen.findByText("来源尚未完成健康检查")).toBeVisible();
  expect(screen.queryByRole("button", { name: "重新开始岗位发现：岗位发现未完成" })).not.toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "确认当前提示并重新开始岗位发现" });
  await user.click(confirm);

  const requests = (fetch as ReturnType<typeof vi.fn>).mock.calls;
  expect(JSON.parse(String(requests[0]![1]?.body))).toEqual({ actionId, action: "restart_run" });
  expect(JSON.parse(String(requests[1]![1]?.body))).toEqual({ actionId, action: "restart_run", warningFingerprint: fingerprint });
});

it("隔离各状态缓存并忽略乱序响应，往返后仍显示权威 pending 项", async () => {
  const user = userEvent.setup();
  let resolveUnread!: (response: Response) => void;
  let resolveRead!: (response: Response) => void;
  const unread = new Promise<Response>((resolve) => { resolveUnread = resolve; });
  const read = new Promise<Response>((resolve) => { resolveRead = resolve; });
  const readItem = { ...item, itemId: "5a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "已读事项", status: "read" as const, availableActions: ["dismiss"] as const, readAt: now };
  const unreadItem = { ...item, itemId: "6a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "未读事项" };
  const resolvedItem = { ...item, itemId: "7a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "已处理事项", status: "resolved" as const, readAt: now, resolvedAt: now, availableActions: [] };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url.includes("status=unread")) return unread;
    if (url.includes("status=read")) return read;
    if (url.includes("status=resolved")) return Promise.resolve(Response.json({ items: [resolvedItem] }));
    throw new Error(`unexpected request: ${url}`);
  }));
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "未读" }));
  await user.click(screen.getByRole("button", { name: "已读" }));
  resolveRead(Response.json({ items: [readItem] }));
  await screen.findByRole("article", { name: "已读事项" });
  resolveUnread(Response.json({ items: [unreadItem] }));
  await waitFor(() => expect(screen.getByRole("article", { name: "已读事项" })).toBeVisible());
  await user.click(screen.getByRole("button", { name: "已处理" }));
  await screen.findByRole("article", { name: "已处理事项" });
  await user.click(screen.getByRole("button", { name: "待处理" }));
  expect(screen.getByRole("article", { name: "确认工作经历" })).toBeVisible();
});

it("切回命中缓存的筛选时忽略旧请求的失败", async () => {
  const user = userEvent.setup();
  let resolveUnread!: (response: Response) => void;
  const unread = new Promise<Response>((resolve) => { resolveUnread = resolve; });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    if (String(input).includes("status=unread")) return unread;
    throw new Error(`unexpected request: ${String(input)}`);
  }));
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "未读" }));
  await user.click(screen.getByRole("button", { name: "待处理" }));
  resolveUnread(new Response(null, { status: 503 }));

  await waitFor(() => expect(screen.getByRole("article", { name: "确认工作经历" })).toBeVisible());
  expect(screen.queryByText("事项暂时无法读取，请稍后重试。")).not.toBeInTheDocument();
});

it("权威 props 更新时在未读筛选中重建未读缓存，而非显示空态", async () => {
  const user = userEvent.setup();
  const refreshed = { ...item, title: "刷新后的未读事项" };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [item] })));
  const view = render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "未读" }));
  await screen.findByRole("article", { name: "确认工作经历" });
  view.rerender(<AgentInboxPanel items={[refreshed]} onResolved={vi.fn()} />);

  expect(screen.getByRole("article", { name: "刷新后的未读事项" })).toBeVisible();
  expect(screen.queryByText("没有未读事项。")).not.toBeInTheDocument();
});

it("权威 props 更新时在已读筛选中重建已读缓存，而非显示空态", async () => {
  const user = userEvent.setup();
  const read: AgentInboxItem = { ...item, status: "read", availableActions: ["dismiss"], readAt: now };
  const refreshed = { ...read, title: "刷新后的已读事项" };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [read] })));
  const view = render(<AgentInboxPanel items={[read]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "已读" }));
  await screen.findByRole("article", { name: "确认工作经历" });
  view.rerender(<AgentInboxPanel items={[refreshed]} onResolved={vi.fn()} />);

  expect(screen.getByRole("article", { name: "刷新后的已读事项" })).toBeVisible();
  expect(screen.queryByText("没有已读事项。")).not.toBeInTheDocument();
});

it("权威 props 更新时使已处理缓存失效并在读取期间不显示空态", async () => {
  const user = userEvent.setup();
  const oldResolved = { ...item, title: "旧已处理事项", status: "resolved" as const, availableActions: [] as const, readAt: now, resolvedAt: now };
  const freshResolved = { ...oldResolved, itemId: "5a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "刷新后的已处理事项" };
  let resolveRefresh!: (response: Response) => void;
  const refresh = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => ++calls === 1 ? Promise.resolve(Response.json({ items: [oldResolved] })) : refresh));
  const view = render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "已处理" }));
  await screen.findByRole("article", { name: "旧已处理事项" });
  view.rerender(<AgentInboxPanel items={[{ ...item, title: "新的权威待处理事项" }]} onResolved={vi.fn()} />);

  await screen.findByText("正在读取事项…");
  expect(screen.queryByText("没有已处理事项。")).not.toBeInTheDocument();
  resolveRefresh(Response.json({ items: [freshResolved] }));
  await screen.findByRole("article", { name: "刷新后的已处理事项" });
});

it.each(["success", "failure"] as const)("权威 props 更新后忽略旧来源在途未读请求的 %s 结果", async (outcome) => {
  const user = userEvent.setup();
  const refreshed = { ...item, title: "新来源未读事项" };
  let resolveOld!: (response: Response) => void;
  const oldRequest = new Promise<Response>((resolve) => { resolveOld = resolve; });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(oldRequest));
  const view = render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "未读" }));
  expect(screen.getByText("正在读取事项…")).toBeVisible();
  view.rerender(<AgentInboxPanel items={[refreshed]} onResolved={vi.fn()} />);
  expect(screen.getByRole("article", { name: "新来源未读事项" })).toBeVisible();

  resolveOld(outcome === "success" ? Response.json({ items: [item] }) : new Response(null, { status: 503 }));
  await waitFor(() => expect(screen.getByRole("article", { name: "新来源未读事项" })).toBeVisible());
  expect(screen.queryByText("事项暂时无法读取，请稍后重试。")).not.toBeInTheDocument();
});

it("相同内容但新数组身份的权威 props 也淘汰旧来源在途请求", async () => {
  const user = userEvent.setup();
  let resolveOld!: (response: Response) => void;
  const oldRequest = new Promise<Response>((resolve) => { resolveOld = resolve; });
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(oldRequest));
  const view = render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "未读" }));
  expect(screen.getByText("正在读取事项…")).toBeVisible();
  view.rerender(<AgentInboxPanel items={[{ ...item }]} onResolved={vi.fn()} />);
  expect(screen.getByRole("article", { name: "确认工作经历" })).toBeVisible();

  resolveOld(new Response(null, { status: 503 }));
  await waitFor(() => expect(screen.getByRole("article", { name: "确认工作经历" })).toBeVisible());
  expect(screen.queryByText("事项暂时无法读取，请稍后重试。")).not.toBeInTheDocument();
});

it("读取筛选期间不伪造空态，失败时只显示问题和可操作重试", async () => {
  const user = userEvent.setup();
  let rejectUnread!: (reason?: unknown) => void;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    if (String(input).includes("status=unread")) return new Promise<Response>((_resolve, reject) => { rejectUnread = reject; });
    throw new Error(`unexpected request: ${String(input)}`);
  }));
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "未读" }));
  expect(screen.getByText("正在读取事项…")).toBeVisible();
  expect(screen.queryByText("没有未读事项。")).not.toBeInTheDocument();
  rejectUnread(new Error("offline"));
  await expect(screen.findByText("事项暂时无法读取，请稍后重试。")).resolves.toBeVisible();
  expect(screen.queryByText("没有未读事项。")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重试读取未读事项" })).toBeVisible();
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

it("标记已读后把焦点交给同一事项的可追溯目标", async () => {
  const user = userEvent.setup();
  const read = { ...item, status: "read" as const, availableActions: ["dismiss"] as const, readAt: now };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ applied: true, item: read, run: null })));
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);
  const markRead = screen.getByRole("button", { name: "标记为已读：确认工作经历" });
  await user.click(markRead);
  await waitFor(() => expect(screen.queryByRole("button", { name: "标记为已读：确认工作经历" })).not.toBeInTheDocument());
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "查看相关记录" }));
});

it("标记已读后按服务端稳定顺序 upsert 已加载的已读缓存", async () => {
  const user = userEvent.setup();
  const later = "2026-09-04T10:00:00.000Z";
  const newer = { ...item, itemId: "2a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "更新已读事项", status: "read" as const, availableActions: ["dismiss"] as const, createdAt: "2026-09-04T09:00:00.000Z", readAt: later };
  const sameCreatedHigher = { ...item, itemId: "5a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "同秒较大 ID 事项", status: "read" as const, availableActions: ["dismiss"] as const, readAt: later };
  const sameCreatedLower = { ...item, itemId: "3a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "同秒较小 ID 事项", status: "read" as const, availableActions: ["dismiss"] as const, readAt: later };
  const older = { ...item, itemId: "1a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "更旧已读事项", status: "read" as const, availableActions: ["dismiss"] as const, createdAt: "2026-09-04T07:00:00.000Z", readAt: later };
  const replacementUnread: AgentInboxItem = { ...item, itemId: "6a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "待替换已读事项", createdAt: "2026-09-04T06:00:00.000Z" };
  const staleRead = { ...replacementUnread, title: "旧待替换已读事项", status: "read" as const, availableActions: ["dismiss"] as const, readAt: now };
  const markedRead = { ...item, title: "新标记已读事项", status: "read" as const, availableActions: ["dismiss"] as const, readAt: now };
  const replacementRead = { ...staleRead, title: "更新后的已读事项" };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url.includes("status=unread")) return Promise.resolve(Response.json({ items: [item, replacementUnread] }));
    if (url.includes("status=read")) return Promise.resolve(Response.json({ items: [newer, sameCreatedHigher, sameCreatedLower, older, staleRead] }));
    if (url.includes(`/api/agent-inbox/${itemId}/actions`)) return Promise.resolve(Response.json({ applied: true, item: markedRead, run: null }));
    if (url.includes(`/api/agent-inbox/${replacementUnread.itemId}/actions`)) return Promise.resolve(Response.json({ applied: true, item: replacementRead, run: null }));
    throw new Error(`unexpected request: ${url}`);
  }));
  render(<AgentInboxPanel items={[item, replacementUnread]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "已读" }));
  await screen.findByRole("article", { name: "更新已读事项" });
  await user.click(screen.getByRole("button", { name: "未读" }));
  await screen.findByRole("article", { name: "确认工作经历" });
  await user.click(screen.getByRole("button", { name: "标记为已读：确认工作经历" }));
  await user.click(screen.getByRole("button", { name: "已读" }));

  await waitFor(() => expect(screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual([
    "更新已读事项", "同秒较大 ID 事项", "新标记已读事项", "同秒较小 ID 事项", "更旧已读事项", "旧待替换已读事项",
  ]));

  await user.click(screen.getByRole("button", { name: "未读" }));
  await user.click(screen.getByRole("button", { name: "标记为已读：待替换已读事项" }));
  await user.click(screen.getByRole("button", { name: "已读" }));

  await waitFor(() => expect(screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual([
    "更新已读事项", "同秒较大 ID 事项", "新标记已读事项", "同秒较小 ID 事项", "更旧已读事项", "更新后的已读事项",
  ]));
  expect(screen.queryByRole("article", { name: "旧待替换已读事项" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("article", { name: "更新后的已读事项" })).toHaveLength(1);
});

it("标记已读时在所有已加载缓存中迁移投影，并安全回退未读筛选焦点", async () => {
  const user = userEvent.setup();
  const priorRead = { ...item, itemId: "8a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "原有已读事项", status: "read" as const, availableActions: ["dismiss"] as const, readAt: now };
  const resolved = { ...item, itemId: "9a1b0207-b852-4f86-8b1f-3b9615655ed8", title: "已处理事项", status: "resolved" as const, availableActions: [] as const, readAt: now, resolvedAt: now };
  const read = { ...item, status: "read" as const, availableActions: ["dismiss"] as const, readAt: now };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    const url = String(input);
    if (url.includes("status=unread")) return Promise.resolve(Response.json({ items: [item] }));
    if (url.includes("status=read")) return Promise.resolve(Response.json({ items: [priorRead] }));
    if (url.includes("status=resolved")) return Promise.resolve(Response.json({ items: [resolved] }));
    if (url.includes(`/api/agent-inbox/${itemId}/actions`)) return Promise.resolve(Response.json({ applied: true, item: read, run: null }));
    throw new Error(`unexpected request: ${url}`);
  }));
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "未读" }));
  await screen.findByRole("article", { name: "确认工作经历" });
  await user.click(screen.getByRole("button", { name: "已读" }));
  await screen.findByRole("article", { name: "原有已读事项" });
  await user.click(screen.getByRole("button", { name: "已处理" }));
  await screen.findByRole("article", { name: "已处理事项" });
  await user.click(screen.getByRole("button", { name: "未读" }));
  await user.click(screen.getByRole("button", { name: "标记为已读：确认工作经历" }));

  await waitFor(() => expect(screen.queryByRole("article", { name: "确认工作经历" })).not.toBeInTheDocument());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "未读" }));
  await user.click(screen.getByRole("button", { name: "待处理" }));
  expect(screen.getByRole("article", { name: "确认工作经历" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "已读" }));
  expect(screen.getByRole("article", { name: "确认工作经历" })).toBeVisible();
  expect(screen.getByRole("article", { name: "原有已读事项" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "已处理" }));
  expect(screen.getByRole("article", { name: "已处理事项" })).toBeVisible();
});

it("动作失败时保留事项并提供可恢复的错误信息", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 409 })));
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "标记已处理：确认工作经历" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("该事项状态已变化，请刷新后查看。"));
  expect(screen.getByRole("article", { name: "确认工作经历" })).toBeVisible();
});
