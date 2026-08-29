import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CompanyWatchlistOverview } from "@job-copilot/contracts/company-watchlists";

import { CompanyWatchlistView } from "./company-watchlist-view";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const firstItemId = "87ccabf1-f5fe-430c-9129-df14e4789ec0";
const secondItemId = "a2e20e7d-d506-49d8-8434-576781e1b7e5";

function overview(items: CompanyWatchlistOverview["items"] = [], version = 0): CompanyWatchlistOverview {
  return { target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version, items };
}

function item(itemId: string, position: number, canonicalCompanyName: string, state: "enabled" | "disabled" = "enabled") {
  return { itemId, canonicalCompanyName, careersUrl: `https://careers.${canonicalCompanyName === "曙光云图" ? "aurora" : "orbit"}.example/jobs`, allowedDomains: [`careers.${canonicalCompanyName === "曙光云图" ? "aurora" : "orbit"}.example`], sourceNote: `${canonicalCompanyName} 公开入口`, state, position };
}

afterEach(() => vi.unstubAllGlobals());

it("为空 Watchlist 呈现目标角色、唯一新增提交和固定安全提示", () => {
  render(<CompanyWatchlistView initialOverview={overview()} />);

  expect(screen.getByRole("heading", { name: "AI 应用工程的目标公司 Watchlist" })).toBeVisible();
  const submitButtons = screen.getAllByRole("button").filter((button) => button.getAttribute("type") === "submit");
  expect(submitButtons).toHaveLength(1);
  expect(submitButtons[0]).toHaveAccessibleName("保存目标公司");
  expect(submitButtons[0]).toHaveClass("workbench-touch-target");
  expect(screen.getByText("不要填写账号、密码、Cookie、验证码或绕过登录限制的说明。")).toBeVisible();
});

it("分别说明缺少名称、无效 URL、域名不匹配和凭据型 URL", async () => {
  const user = userEvent.setup();
  render(<CompanyWatchlistView initialOverview={overview()} />);

  await user.click(screen.getByRole("button", { name: "保存目标公司" }));
  expect(screen.getByText("请填写公司规范名称。")).toBeVisible();
  await user.type(screen.getByLabelText("公司规范名称"), "曙光云图");
  await user.type(screen.getByLabelText("公开招聘入口"), "bad-url");
  await user.type(screen.getByLabelText("允许域"), "careers.aurora.example");
  await user.click(screen.getByRole("button", { name: "保存目标公司" }));
  expect(screen.getByText("请输入有效的公开招聘入口 URL。")).toBeVisible();

  await user.clear(screen.getByLabelText("公开招聘入口"));
  await user.type(screen.getByLabelText("公开招聘入口"), "https://jobs.other.example/openings");
  await user.click(screen.getByRole("button", { name: "保存目标公司" }));
  expect(screen.getByText("公开招聘入口主机必须匹配允许域。")).toBeVisible();

  await user.clear(screen.getByLabelText("公开招聘入口"));
  await user.type(screen.getByLabelText("公开招聘入口"), "https://careers.aurora.example/jobs?access_token=secret");
  await user.click(screen.getByRole("button", { name: "保存目标公司" }));
  expect(screen.getByText("公开招聘入口不得包含账号信息或凭据型查询参数。")).toBeVisible();
});

it("新增后仅使用已验证响应显示优先级和版本", async () => {
  const user = userEvent.setup();
  const next = overview([item(firstItemId, 1, "曙光云图")], 1);
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(next, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<CompanyWatchlistView initialOverview={overview()} />);

  await user.type(screen.getByLabelText("公司规范名称"), "曙光云图");
  await user.type(screen.getByLabelText("公开招聘入口"), "https://careers.aurora.example/jobs");
  await user.type(screen.getByLabelText("允许域"), "careers.aurora.example");
  await user.click(screen.getByRole("button", { name: "保存目标公司" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/job-targets/${targetId}/company-watchlist/items`, expect.objectContaining({ method: "POST" })));
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ expectedVersion: 0, canonicalCompanyName: "曙光云图", careersUrl: "https://careers.aurora.example/jobs", allowedDomains: ["careers.aurora.example"], sourceNote: null });
  expect(screen.getByText("优先级 01")).toBeVisible();
  expect(screen.getByText("Watchlist 版本 1")).toBeVisible();
  expect(screen.getByText("已启用")).toBeVisible();
});

it("编辑、完整排列上移下移和启停均携带当前聚合版本并保持文本状态", async () => {
  const user = userEvent.setup();
  const initial = overview([item(firstItemId, 1, "曙光云图"), item(secondItemId, 2, "星轨智造")], 2);
  const edited = overview([{ ...item(firstItemId, 1, "曙光云图"), sourceNote: "更新说明" }, item(secondItemId, 2, "星轨智造")], 3);
  const reordered = overview([item(secondItemId, 1, "星轨智造"), { ...edited.items[0]!, position: 2 }], 4);
  const disabled = overview([{ ...reordered.items[0]!, state: "disabled" }, reordered.items[1]!], 5);
  const enabled = overview([{ ...disabled.items[0]!, state: "enabled" }, disabled.items[1]!], 6);
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(edited, { status: 201 }))
    .mockResolvedValueOnce(Response.json(reordered, { status: 201 }))
    .mockResolvedValueOnce(Response.json(disabled, { status: 201 }))
    .mockResolvedValueOnce(Response.json(enabled, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<CompanyWatchlistView initialOverview={initial} />);

  await user.click(screen.getByRole("button", { name: "编辑 曙光云图" }));
  await user.clear(screen.getByLabelText("来源备注"));
  await user.type(screen.getByLabelText("来源备注"), "更新说明");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/job-targets/${targetId}/company-watchlist/items/${firstItemId}/revisions`, expect.anything()));
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ expectedVersion: 2, sourceNote: "更新说明" });

  await user.click(screen.getByRole("button", { name: "上移 星轨智造" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/job-targets/${targetId}/company-watchlist/reorders`, expect.anything()));
  expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ expectedVersion: 3, orderedItemIds: [secondItemId, firstItemId] });
  expect(screen.getAllByText("优先级 01")[0]).toBeVisible();

  await user.click(screen.getByRole("button", { name: "停用 星轨智造" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(3, `/api/job-targets/${targetId}/company-watchlist/items/${secondItemId}/state-changes`, expect.anything()));
  expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({ expectedVersion: 4, state: "disabled" });
  expect(screen.getByText("已停用")).toBeVisible();
  expect(screen.getByText("更新说明")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "启用 星轨智造" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(4, `/api/job-targets/${targetId}/company-watchlist/items/${secondItemId}/state-changes`, expect.anything()));
  expect(JSON.parse(String(fetchMock.mock.calls[3]![1]?.body))).toEqual({ expectedVersion: 5, state: "enabled" });
});

it("下移使用当前完整 ID 排列而不是局部位置更新", async () => {
  const user = userEvent.setup();
  const initial = overview([item(firstItemId, 1, "曙光云图"), item(secondItemId, 2, "星轨智造")], 2);
  const reordered = overview([item(secondItemId, 1, "星轨智造"), { ...item(firstItemId, 1, "曙光云图"), position: 2 }], 3);
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reordered, { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<CompanyWatchlistView initialOverview={initial} />);

  await user.click(screen.getByRole("button", { name: "下移 曙光云图" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ expectedVersion: 2, orderedItemIds: [secondItemId, firstItemId] });
});

it("409 保留现有列表和表单数据并给出固定冲突提示", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("http://internal-api:3021 secret", { status: 409 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<CompanyWatchlistView initialOverview={overview([item(firstItemId, 1, "曙光云图")], 1)} />);

  await user.click(screen.getByRole("button", { name: "编辑 曙光云图" }));
  await user.clear(screen.getByLabelText("来源备注"));
  await user.type(screen.getByLabelText("来源备注"), "仍要保留");
  await user.click(screen.getByRole("button", { name: "保存修改" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Watchlist 已在其他位置更新，请刷新后重试。"));
  expect(screen.getByLabelText("来源备注")).toHaveValue("仍要保留");
  expect(screen.getByText("曙光云图", { selector: "h3" })).toBeVisible();
  expect(document.body.textContent).not.toContain("internal-api");
});

it("在停用目标上明确阻止维护", () => {
  render(<CompanyWatchlistView initialOverview={{ ...overview(), target: { targetId, targetVersion: 2, targetState: "inactive", roleFamily: "AI 应用工程" } }} />);
  expect(screen.getByText("该求职目标已停用，不能维护 Watchlist。")).toBeVisible();
  expect(screen.getByRole("button", { name: "保存目标公司" })).toBeDisabled();
});
