import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AgentInboxPanel } from "./agent-inbox-panel";

const itemId = "4a1b0207-b852-4f86-8b1f-3b9615655ed8";
const runId = "9a5a0c80-2a73-4e61-8b14-d80f6e345af0";
const actionId = "355eec35-befa-44ee-ac34-1e3614975d4f";
const now = "2026-08-29T08:00:00.000Z";
const item: AgentInboxItem = {
  itemId, runId, kind: "budget_exhausted", status: "open", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "attempts",
  title: "岗位发现预算已用尽", message: "本次岗位发现达到重试次数上限。请调整目标后重试。", availableActions: ["dismiss"], targetHref: "/profile/targets", createdAt: now, resolvedAt: null,
};

beforeEach(() => vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(actionId));
afterEach(() => vi.restoreAllMocks());

it("把开放事项作为语义化 article 呈现，并让调整目标不自动解决事项", () => {
  render(<AgentInboxPanel items={[item]} onResolved={vi.fn()} />);
  expect(screen.getByRole("article", { name: "岗位发现预算已用尽" })).toBeVisible();
  expect(screen.getByRole("link", { name: "调整求职目标" })).toHaveAttribute("href", "/profile/targets");
  expect(screen.getByRole("button", { name: "标记已处理：岗位发现预算已用尽" })).toBeEnabled();
});

it.each(["restart_run", "resume_run", "cancel_run", "dismiss"] as const)("%s 动作失败时保留事项与 UUID，成功后移除但保留成功播报", async (action) => {
  const user = userEvent.setup();
  const resolved = { ...item, status: "resolved" as const, availableActions: [], resolvedAt: now };
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ applied: true, item: resolved, run: null }));
  vi.stubGlobal("fetch", fetchMock);
  const actions = [action];
  const label = action === "restart_run" ? "重新开始岗位发现" : action === "resume_run" ? "继续本次岗位发现" : action === "cancel_run" ? "取消岗位发现" : "标记已处理";
  const update = vi.fn();
  render(<AgentInboxPanel items={[{ ...item, availableActions: actions }]} onResolved={update} />);

  await user.click(screen.getByRole("button", { name: `${label}：岗位发现预算已用尽` }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("暂时无法处理该事项，请稍后重试。"));
  expect(screen.getByRole("article", { name: "岗位发现预算已用尽" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: `${label}：岗位发现预算已用尽` }));

  await waitFor(() => expect(update).toHaveBeenCalledWith(itemId));
  expect(screen.getByRole("status")).toHaveTextContent("事项已处理。");
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { actionId, action }, { actionId, action },
  ]);
});

it("恢复事项成功后把权威运行快照交给工作台刷新", async () => {
  const user = userEvent.setup();
  const decision: AgentInboxItem = {
    ...item,
    kind: "decision_required",
    reasonCode: "AGENT_RUN_PAUSED",
    budgetDimension: null,
    title: "岗位发现已暂停",
    message: "选择继续或取消本次岗位发现。",
    availableActions: ["resume_run", "cancel_run"],
    targetHref: null,
  };
  const resolved = { ...decision, status: "resolved" as const, availableActions: [], resolvedAt: now };
  const run = { runId, status: "queued" as const, currentStep: "queued" as const, controlState: "none" as const, version: 4 };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ applied: true, item: resolved, run })));
  const onRunUpdated = vi.fn();
  render(<AgentInboxPanel items={[decision]} onResolved={vi.fn()} onRunUpdated={onRunUpdated} />);

  await user.click(screen.getByRole("button", { name: "继续本次岗位发现：岗位发现已暂停" }));

  await waitFor(() => expect(onRunUpdated).toHaveBeenCalledWith(run));
});
