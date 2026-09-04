import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { JobTargetOverview } from "@job-copilot/contracts/job-targets";

import { JobTargetsView } from "./job-targets-view";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const suggestionIds = [
  "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a",
  "9e812f2a-34fd-43cf-b8fb-fc307f1eb4ce",
  "a1a1a1a1-1111-4111-8111-111111111111",
] as const;
const factIds = [
  "c4d4a7c1-9a17-4a8c-8b36-0f815d042e9a",
  "c4d4a7c1-9a17-4a8c-8b36-0f815d042e9b",
  "c4d4a7c1-9a17-4a8c-8b36-0f815d042e9c",
] as const;

function overview(targets: JobTargetOverview["targets"] = []): JobTargetOverview {
  return {
    suggestions: ["AI 应用工程", "前端工程", "全栈工程"].map((roleFamily, index) => ({
      suggestionId: suggestionIds[index]!,
      roleFamily,
      rationale: `与已确认的 ${roleFamily} 经历和技能一致`,
      evidence: [{ factId: factIds[index]!, revisionId: suggestionIds[index]!, label: `${roleFamily} 证据` }],
    })),
    targets,
  };
}

function activeTarget(version = 1) {
  return {
    targetId,
    version,
    priority: "primary" as const,
    state: "active" as const,
    constraints: {
      roleFamily: "AI 应用工程", seniority: "高级", locations: ["上海"], workModes: ["hybrid" as const],
      relocation: "conditional" as const,
      salary: { minimum: 30000, maximum: 45000, period: "month" as const, currency: "CNY" },
      industries: ["AI"],
      dealBreakers: { excludedCompanies: ["示例外包"], excludedIndustries: ["博彩"], excludeOutsourcing: true, excludeDispatch: true, excludeHeadhunter: true, other: ["无五险一金"] },
    },
    createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:00:00.000Z",
  };
}

function activeSecondary(targetId: string) {
  return { ...activeTarget(1), targetId, priority: "secondary" as const, constraints: { ...activeTarget(1).constraints, roleFamily: `次目标 ${targetId.slice(0, 4)}` } };
}

afterEach(() => vi.unstubAllGlobals());

it("prepopulates but never saves evidence-labelled candidate directions until the user submits the complete target form", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(overview([activeTarget(1)]), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);

  render(<JobTargetsView initialOverview={overview()} />);

  expect(screen.getByRole("heading", { name: "候选岗位方向" })).toBeVisible();
  expect(screen.getAllByText("建议依据")).toHaveLength(3);
  expect(screen.getByText("AI 应用工程 证据")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "使用 AI 应用工程 建议" }));
  expect(screen.getByLabelText("目标岗位方向")).toHaveValue("AI 应用工程");
  expect(fetchMock).not.toHaveBeenCalled();

  await user.clear(screen.getByLabelText("目标岗位方向"));
  await user.type(screen.getByLabelText("目标岗位方向"), "Agent 工程");
  await user.type(screen.getByLabelText("资历级别"), "高级");
  await user.type(screen.getByLabelText("意向地点（用逗号分隔）"), "上海, 杭州");
  await user.selectOptions(screen.getByLabelText("工作方式"), ["hybrid", "remote"]);
  await user.selectOptions(screen.getByLabelText("是否接受搬迁"), "conditional");
  await user.type(screen.getByLabelText("最低薪资"), "30000");
  await user.type(screen.getByLabelText("最高薪资"), "45000");
  await user.selectOptions(screen.getByLabelText("薪资周期"), "month");
  await user.selectOptions(screen.getByLabelText("薪资币种"), "CNY");
  await user.type(screen.getByLabelText("意向行业（用逗号分隔）"), "AI, 企业服务");
  await user.type(screen.getByLabelText("不接受的公司（用逗号分隔）"), "示例外包");
  await user.type(screen.getByLabelText("不接受的行业（用逗号分隔）"), "博彩");
  await user.click(screen.getByLabelText("不接受外包"));
  await user.click(screen.getByLabelText("不接受派遣"));
  await user.click(screen.getByLabelText("不接受猎头"));
  await user.type(screen.getByLabelText("其他不可接受条件（用逗号分隔）"), "无五险一金");
  await user.click(screen.getByRole("button", { name: "保存主目标" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/job-targets", expect.objectContaining({ method: "POST" })));
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
    priority: "primary",
    constraints: {
      roleFamily: "Agent 工程", seniority: "高级", locations: ["上海", "杭州"], workModes: ["hybrid", "remote"], relocation: "conditional",
      salary: { minimum: 30000, maximum: 45000, period: "month", currency: "CNY" }, industries: ["AI", "企业服务"],
      dealBreakers: { excludedCompanies: ["示例外包"], excludedIndustries: ["博彩"], excludeOutsourcing: true, excludeDispatch: true, excludeHeadhunter: true, other: ["无五险一金"] },
    },
  });
  expect(screen.getByText((_, element) => element?.textContent?.startsWith("版本 1") ?? false)).toBeVisible();
});

it("revises and deactivates an existing target using the server-returned versions", async () => {
  const user = userEvent.setup();
  const revised = { ...activeTarget(2), constraints: { ...activeTarget(2).constraints, roleFamily: "Agent 工程" } };
  const inactive = { ...revised, version: 3, state: "inactive" as const };
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(overview([revised]), { status: 201 }))
    .mockResolvedValueOnce(Response.json(overview([inactive]), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);

  render(<JobTargetsView initialOverview={overview([activeTarget(1)])} />);
  await user.click(screen.getByRole("button", { name: "修改 AI 应用工程" }));
  await user.clear(screen.getByLabelText("目标岗位方向"));
  await user.type(screen.getByLabelText("目标岗位方向"), "Agent 工程");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/job-targets/${targetId}/revisions`, expect.objectContaining({ method: "POST" })));
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ expectedVersion: 1, priority: "primary", constraints: { roleFamily: "Agent 工程" } });
  expect(screen.getByText((_, element) => element?.textContent?.startsWith("版本 2") ?? false)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "停用 Agent 工程" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/job-targets/${targetId}/deactivations`, expect.objectContaining({ method: "POST" })));
  expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ expectedVersion: 2 });
  expect(screen.getByText("已停用")).toBeVisible();
  expect(screen.getByText((_, element) => element?.textContent?.startsWith("版本 3") ?? false)).toBeVisible();
});

it("keeps the prior target visible and explains an optimistic-lock conflict without exposing response internals", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("internal http://api:3021", { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);

  render(<JobTargetsView initialOverview={overview([activeTarget(1)])} />);
  await user.click(screen.getByRole("button", { name: "修改 AI 应用工程" }));
  await user.click(screen.getByRole("button", { name: "保存修改" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("目标已在其他位置更新，请刷新后重试。"));
  expect(screen.getByText("AI 应用工程", { selector: "strong" })).toBeVisible();
  expect(document.body.textContent).not.toContain("api:3021");
});

it("keeps target actions labelled and touch-sized through keyboard-native controls", () => {
  render(<JobTargetsView initialOverview={overview([activeTarget(1)])} />);

  expect(screen.getByRole("button", { name: "使用 AI 应用工程 建议" })).toHaveClass("workbench-touch-target");
  expect(screen.getByRole("button", { name: "修改 AI 应用工程" })).toHaveClass("workbench-touch-target");
  expect(screen.getByRole("button", { name: "停用 AI 应用工程" })).toHaveClass("workbench-touch-target");
});

it("为每个已确认求职目标提供维护目标公司 Watchlist 的同源入口", () => {
  render(<JobTargetsView initialOverview={overview([activeTarget(1)])} />);

  expect(screen.getByRole("link", { name: "维护 AI 应用工程 的目标公司 Watchlist" })).toHaveAttribute(
    "href",
    `/profile/targets/${targetId}/watchlist`,
  );
});

it("defaults a new target to the remaining secondary slot when a primary target already exists", () => {
  render(<JobTargetsView initialOverview={overview([activeTarget(1)])} />);

  expect(screen.getByLabelText("主目标")).toBeDisabled();
  expect(screen.getByLabelText("主目标")).not.toBeChecked();
  expect(screen.getByLabelText("次目标")).toBeEnabled();
  expect(screen.getByLabelText("次目标")).toBeChecked();
  expect(screen.getByRole("button", { name: "保存次目标" })).toBeEnabled();
});

it("disables new-target submission without a request when all one-plus-two slots are occupied", () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  render(<JobTargetsView initialOverview={overview([
    activeTarget(1), activeSecondary("b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a"), activeSecondary("9e812f2a-34fd-43cf-b8fb-fc307f1eb4ce"),
  ])} />);

  expect(screen.getByText("主目标和两个次目标均已设置。如需新增，请先停用或修改已有目标。")).toBeVisible();
  expect(screen.getByLabelText("主目标")).toBeDisabled();
  expect(screen.getByLabelText("次目标")).toBeDisabled();
  const submit = screen.getByRole("button", { name: "保存求职目标" });
  expect(submit).toBeDisabled();
  fireEvent.submit(submit.closest("form")!);
  expect(fetchMock).not.toHaveBeenCalled();
});
