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
  render(<AgentInboxPanel initialInbox={[item]} />);
  expect(screen.getByRole("article", { name: "岗位发现预算已用尽" })).toBeVisible();
  expect(screen.getByRole("link", { name: "调整求职目标" })).toHaveAttribute("href", "/profile/targets");
  expect(screen.getByRole("button", { name: "标记已处理：岗位发现预算已用尽" })).toBeEnabled();
});

it("失败重试复用 Inbox 动作 UUID，成功后移除事项", async () => {
  const user = userEvent.setup();
  const resolved = { ...item, status: "resolved" as const, availableActions: [], resolvedAt: now };
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ applied: true, item: resolved, run: null }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentInboxPanel initialInbox={[item]} />);

  await user.click(screen.getByRole("button", { name: "标记已处理：岗位发现预算已用尽" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("暂时无法处理该事项，请稍后重试。"));
  await user.click(screen.getByRole("button", { name: "标记已处理：岗位发现预算已用尽" }));

  await waitFor(() => expect(screen.queryByRole("article", { name: "岗位发现预算已用尽" })).not.toBeInTheDocument());
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { actionId, action: "dismiss" }, { actionId, action: "dismiss" },
  ]);
});
