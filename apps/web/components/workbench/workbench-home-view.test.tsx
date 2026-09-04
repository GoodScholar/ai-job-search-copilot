import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { WorkbenchHomeView } from "./workbench-home-view";

const home = {
  account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
  summary: { todayRecommendations: 2, pendingFacts: 1, activeAgentRuns: 1, failedAgentRuns: 1, sourceFailures: 1, pendingDecisions: 2, applications: 0 as const, applicationsAvailable: false as const },
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("把需要决定的事项放在首页标题，并完整呈现真实摘要和未启用的投递能力", () => {
  render(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);
  expect(screen.getByRole("heading", { name: "先处理需要你决定的事项" })).toBeVisible();
  for (const label of ["今日推荐", "待确认事实", "运行中的求职代理", "失败的求职代理", "需要关注的来源", "待决定事项"]) expect(screen.getByText(label)).toBeVisible();
  expect(screen.getByText("投递记录（尚未启用）")).toBeVisible();
  expect(screen.getByText("投递记录功能尚未启用，当前不会保存或显示投递数据。")).toBeVisible();
});

it("在保留最后成功数据时显示离线标记，并在网络恢复后刷新路由", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("navigator", { onLine: false });
  render(<WorkbenchHomeView home={home} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} />);
  expect(screen.getByText("离线：正在显示上次成功读取的数据，可能已过期。")).toBeVisible();
  await user.keyboard("{Tab}");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  window.dispatchEvent(new Event("online"));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByText("网络已恢复，正在更新最新数据。")).toBeVisible();
});

it("为不可读取的首页摘要保留可用 Inbox 与明确异常说明", () => {
  render(<WorkbenchHomeView home={null} inbox={{ items: [] }} initialRun={null} targets={{ suggestions: [], targets: [] }} unavailableSections={["summary"]} />);
  expect(screen.getByRole("heading", { name: "待决定事项暂时无法读取" })).toBeVisible();
  expect(screen.getByText("今日摘要暂时无法读取，其余可用内容仍会保留。")).toBeVisible();
  expect(screen.getByRole("region", { name: "需要你决定的事项" })).toBeVisible();
});
