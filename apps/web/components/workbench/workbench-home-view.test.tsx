import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { WorkbenchHomeView } from "./workbench-home-view";

const home = {
  account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
  summary: { todayRecommendations: 2, pendingFacts: 1, activeAgentRuns: 1, failedAgentRuns: 1, sourceFailures: 1, pendingDecisions: 2, applications: 0 as const, applicationsAvailable: false as const },
};

const completedRun = {
  runId: "9a5a0c80-2a73-4e61-8b14-d80f6e345af0", targetId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", targetVersion: 1,
  workflowVersion: "job-discovery-workflow-v1", adapter: "fake", adapterVersion: "fake-job-discovery-v1", outputSchemaVersion: "job-discovery-result-v1",
  status: "completed", currentStep: "completed", version: 8, attemptCount: 1, failureCode: null, controlState: "none",
  targetSnapshot: { targetId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", version: 1, priority: "primary", state: "active", constraints: { roleFamily: "AI 应用工程师" } },
  sourceScope: { kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1", watchlistVersion: 0, sources: [] },
  budget: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
  queuedAt: "2026-09-04T08:00:00.000Z", startedAt: "2026-09-04T08:00:00.000Z", completedAt: "2026-09-04T08:00:03.000Z", failedAt: null, cancelledAt: null, updatedAt: "2026-09-04T08:00:03.000Z",
  executionSpec: {
    targetSnapshot: { targetId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", version: 1, priority: "primary", state: "active", constraints: { roleFamily: "AI 应用工程师" } },
    sourceScope: { kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1", watchlistVersion: 0, sources: [] }, workflowVersion: "job-discovery-workflow-v1", ruleVersion: "fake-job-discovery-rules-v1", adapter: "fake", adapterVersion: "fake-job-discovery-v1", outputSchemaVersion: "job-discovery-result-v1", toolAllowlist: [], model: null,
    budget: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
  },
  usage: { activeDurationMs: 1200, attempts: 1, toolCalls: 2, sourceRequests: 2, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 0, complete: true },
  termination: { kind: "completed", failureCode: null, budgetDimension: null }, retryOfRunId: null, steps: [], events: [], results: [],
} as unknown as AgentRunDetail;

afterEach(() => { refresh.mockClear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("把需要决定的事项放在首页标题，并完整呈现真实摘要和未启用的投递能力", () => {
  render(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);
  expect(screen.getByRole("heading", { name: "先处理需要你决定的事项" })).toBeVisible();
  for (const label of ["今日推荐", "待确认事实", "运行中的求职代理", "失败的求职代理", "需要关注的来源", "待决定事项"]) expect(screen.getByText(label)).toBeVisible();
  expect(screen.getByText("投递记录（尚未启用）")).toBeVisible();
  expect(screen.getByText("投递记录功能尚未启用，当前不会保存或显示投递数据。")).toBeVisible();
});

it("Inbox 解决后立即同步标题与摘要，并由新的 home props 清除乐观调整", async () => {
  const user = userEvent.setup();
  const pendingHome = { ...home, summary: { ...home.summary, pendingFacts: 1, pendingDecisions: 1 } };
  const resolvedItem: AgentInboxItem = {
    itemId: "8a1b0207-b852-4f86-8b1f-3b9615655ed8", runId: null, kind: "candidate_fact", status: "resolved", reasonCode: "CANDIDATE_FACT_PENDING", budgetDimension: null,
    title: "确认候选事实", message: "待确认。", basis: "依据。", impact: "影响。", suggestedAction: "确认。",
    target: { type: "candidate_fact", candidateFactId: "9a1b0207-b852-4f86-8b1f-3b9615655ed8", href: "/profile#candidate-facts" }, availableActions: [], createdAt: "2026-09-04T08:00:00.000Z", readAt: "2026-09-04T08:00:00.000Z", resolvedAt: "2026-09-04T08:00:01.000Z",
  };
  const unresolvedItem: AgentInboxItem = { ...resolvedItem, status: "read", availableActions: ["dismiss"], resolvedAt: null };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ applied: true, item: resolvedItem, run: null })));
  const view = render(<WorkbenchHomeView home={pendingHome} inbox={{ items: [unresolvedItem] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);

  await user.click(screen.getByRole("button", { name: "标记已处理：确认候选事实" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "今天暂无待决定事项" })).toBeVisible());
  const summary = screen.getByLabelText("当前求职记录摘要");
  expect(summary).toHaveTextContent("待确认事实0");
  expect(summary).toHaveTextContent("待决定事项0");
  expect(refresh).toHaveBeenCalled();

  view.rerender(<WorkbenchHomeView home={{ ...pendingHome, summary: { ...pendingHome.summary } }} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);
  expect(screen.getByRole("heading", { name: "先处理需要你决定的事项" })).toBeVisible();
  await waitFor(() => {
    expect(screen.getByLabelText("当前求职记录摘要")).toHaveTextContent("待确认事实1");
    expect(screen.getByLabelText("当前求职记录摘要")).toHaveTextContent("待决定事项1");
  });
});

it("在保留最后成功数据时显示离线标记，并在网络恢复后刷新路由", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("navigator", { onLine: false });
  render(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);
  expect(screen.getByText("离线：正在显示上次成功读取的数据，可能已过期。")).toBeVisible();
  await user.keyboard("{Tab}");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByText("网络已恢复，正在等待最新数据。")).toBeVisible();
});

it("为不可读取的首页摘要保留可用 Inbox 与明确异常说明", () => {
  render(<WorkbenchHomeView home={null} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} unavailableSections={["summary"]} />);
  expect(screen.getByRole("heading", { name: "待决定事项暂时无法读取" })).toBeVisible();
  expect(screen.getByText("今日摘要暂时无法读取，其余可用内容仍会保留。")).toBeVisible();
  expect(screen.getByRole("region", { name: "需要你决定的事项" })).toBeVisible();
});

it("分别说明 targets 与运行读取失败，且不隐藏另一项成功区块", () => {
  const { rerender } = render(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} unavailableSections={["targets"]} />);
  expect(screen.getByRole("heading", { name: "求职目标暂时无法读取" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "先确认求职目标" })).toBeVisible();
  rerender(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} unavailableSections={["run"]} />);
  expect(screen.getByRole("heading", { name: "运行状态暂时无法读取" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "先确认求职目标" })).toBeVisible();
});

it("targets 读取失败时保留已成功读取的运行记录，而不是伪造目标空态", () => {
  render(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={completedRun} targets={null} unavailableSections={["targets"]} />);

  expect(screen.getByRole("heading", { name: "求职目标暂时无法读取" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "发现新的岗位机会" })).toBeVisible();
  expect(screen.getByText("岗位发现完成，共保存 0 个岗位机会")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "先确认求职目标" })).not.toBeInTheDocument();
});

it("服务端快照固定在线，挂载后才读取离线状态", () => {
  vi.stubGlobal("navigator", { onLine: false });
  const html = renderToString(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);
  expect(html).not.toContain("离线：正在显示上次成功读取的数据，可能已过期。");
});

it("收到刷新后的服务端 props 后替换 Inbox 并结束陈旧提示", async () => {
  const user = userEvent.setup();
  const freshItem: AgentInboxItem = { itemId: "8a1b0207-b852-4f86-8b1f-3b9615655ed8", runId: null, kind: "candidate_fact", status: "unread", reasonCode: "CANDIDATE_FACT_PENDING", budgetDimension: null, title: "刷新后的事项", message: "新读取的数据。", basis: "新依据。", impact: "新影响。", suggestedAction: "新建议。", target: { type: "candidate_fact", candidateFactId: "9a1b0207-b852-4f86-8b1f-3b9615655ed8", href: "/profile#candidate-facts" }, availableActions: ["dismiss"], createdAt: "2026-09-04T08:00:00.000Z", readAt: null, resolvedAt: null };
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  const view = render(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(screen.getByText("网络已恢复，正在等待最新数据。")).toBeVisible();
  view.rerender(<WorkbenchHomeView home={home} inbox={{ items: [freshItem] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);
  expect(screen.getByRole("article", { name: "刷新后的事项" })).toBeVisible();
  expect(screen.queryByText("网络已恢复，正在等待最新数据。")).not.toBeInTheDocument();
  await user.keyboard("{Tab}");
});
