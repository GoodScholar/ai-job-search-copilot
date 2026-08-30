import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { CompanyWatchlistOverview } from "@job-copilot/contracts/company-watchlists";
import type { JobSourceHealthOverview } from "@job-copilot/contracts/agent-runs";

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

function health(watchlistVersion: number, sources: JobSourceHealthOverview["sources"]): JobSourceHealthOverview {
  return { targetId, watchlistVersion, sources };
}

function source(itemId: string, sourceId: string, name: string, status: JobSourceHealthOverview["sources"][number]["status"] = "healthy"): JobSourceHealthOverview["sources"][number] {
  const checked = status !== null && status !== "disabled";
  return {
    watchlistItemId: itemId, sourceId, name, state: status === "disabled" ? "disabled" : "enabled", status,
    runId: checked ? crypto.randomUUID() : null,
    reasonCodes: status === "rate_limited" ? ["SOURCE_RATE_LIMITED"] : [],
    impact: { scope: status === "rate_limited" ? "entire_source" : "none", affectedCount: null },
    lastCheckedAt: checked ? "2026-08-30T00:00:00.000Z" : null,
    suggestedAction: status === "healthy" ? "none" : status === "rate_limited" ? "retry_later" : status === "disabled" ? "reenable_source" : "wait_for_next_run",
  };
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

it("逐来源以文字呈现七种诊断状态、时间、影响和建议动作", () => {
  const states: JobSourceHealthOverview["sources"] = [
    { watchlistItemId: crypto.randomUUID(), sourceId: "greenhouse:source0", name: "来源 0", state: "enabled", status: "healthy", runId: crypto.randomUUID(), reasonCodes: [], impact: { scope: "none", affectedCount: null }, lastCheckedAt: "2026-08-30T00:00:00.000Z", suggestedAction: "none" },
    { watchlistItemId: crypto.randomUUID(), sourceId: "greenhouse:source1", name: "来源 1", state: "enabled", status: "zero_valid_results", runId: crypto.randomUUID(), reasonCodes: [], impact: { scope: "none", affectedCount: null }, lastCheckedAt: "2026-08-30T00:00:00.000Z", suggestedAction: "wait_for_next_run" },
    { watchlistItemId: crypto.randomUUID(), sourceId: "greenhouse:source2", name: "来源 2", state: "enabled", status: "parser_degraded", runId: crypto.randomUUID(), reasonCodes: ["SOURCE_DETAIL_FIELDS_MISSING"], impact: { scope: "entire_source", affectedCount: null }, lastCheckedAt: "2026-08-30T00:00:00.000Z", suggestedAction: "retry_or_disable" },
    { watchlistItemId: crypto.randomUUID(), sourceId: "greenhouse:source3", name: "来源 3", state: "enabled", status: "rate_limited", runId: crypto.randomUUID(), reasonCodes: ["SOURCE_RATE_LIMITED"], impact: { scope: "entire_source", affectedCount: null }, lastCheckedAt: "2026-08-30T00:00:00.000Z", suggestedAction: "retry_later" },
    { watchlistItemId: crypto.randomUUID(), sourceId: "greenhouse:source4", name: "来源 4", state: "enabled", status: "hard_failed", runId: crypto.randomUUID(), reasonCodes: ["SOURCE_SERVER_ERROR"], impact: { scope: "entire_source", affectedCount: null }, lastCheckedAt: "2026-08-30T00:00:00.000Z", suggestedAction: "retry_or_disable" },
    { watchlistItemId: crypto.randomUUID(), sourceId: "greenhouse:source5", name: "来源 5", state: "disabled", status: "disabled", runId: null, reasonCodes: [], impact: { scope: "none", affectedCount: null }, lastCheckedAt: null, suggestedAction: "reenable_source" },
    { watchlistItemId: crypto.randomUUID(), sourceId: "greenhouse:source6", name: "来源 6", state: "enabled", status: null, runId: null, reasonCodes: [], impact: { scope: "none", affectedCount: null }, lastCheckedAt: null, suggestedAction: "wait_for_next_run" },
  ];
  render(<CompanyWatchlistView initialOverview={overview()} initialSourceHealth={{ targetId, watchlistVersion: 0, sources: states }} />);
  ["健康", "暂无有效岗位", "解析异常", "访问受限", "来源不可用", "已停用", "尚未检查", "无需处理", "等待下次发现", "稍后重试", "稍后重试或停用来源", "可重新启用来源"].forEach((text) => expect(screen.getAllByText(text, { exact: false }).length).toBeGreaterThan(0));
  expect(screen.getAllByText("影响范围：整个来源")).toHaveLength(3);
  expect(screen.getAllByText("最后检查：尚未检查")).toHaveLength(2);
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

it("每次成功写入后都用 BFF 的当前 health 投影替换旧证据", async () => {
  const user = userEvent.setup();
  const initial = overview([item(firstItemId, 1, "曙光云图"), item(secondItemId, 2, "星轨智造")], 2);
  const initialHealth = health(2, [source(firstItemId, "greenhouse:aurora", "旧曙光"), source(secondItemId, "greenhouse:orbit", "星轨")]);
  const addedItemId = "b3ccabf1-f5fe-430c-9129-df14e4789ec0";
  const added = overview([...initial.items, item(addedItemId, 3, "新来源")], 3);
  const edited = overview([{ ...added.items[0]!, canonicalCompanyName: "替换曙光", careersUrl: "https://careers.replacement.example/jobs", allowedDomains: ["careers.replacement.example"] }, ...added.items.slice(1)], 4);
  const disabled = overview([{ ...edited.items[0]!, state: "disabled" }, ...edited.items.slice(1)], 5);
  const enabled = overview([{ ...disabled.items[0]!, state: "enabled" }, ...disabled.items.slice(1)], 6);
  const reordered = overview([enabled.items[1]!, enabled.items[0]!, enabled.items[2]!].map((current, index) => ({ ...current, position: index + 1 })), 7);
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(added, { status: 201 }))
    .mockResolvedValueOnce(Response.json(health(3, [...initialHealth.sources, source(addedItemId, "greenhouse:new", "新来源", null)])))
    .mockResolvedValueOnce(Response.json(edited, { status: 201 }))
    .mockResolvedValueOnce(Response.json(health(4, [source(firstItemId, "greenhouse:replacement", "替换曙光", null), source(secondItemId, "greenhouse:orbit", "星轨"), source(addedItemId, "greenhouse:new", "新来源", null)])))
    .mockResolvedValueOnce(Response.json(disabled, { status: 201 }))
    .mockResolvedValueOnce(Response.json(health(5, [source(firstItemId, "greenhouse:replacement", "替换曙光", "disabled"), source(secondItemId, "greenhouse:orbit", "星轨"), source(addedItemId, "greenhouse:new", "新来源", null)])))
    .mockResolvedValueOnce(Response.json(enabled, { status: 201 }))
    .mockResolvedValueOnce(Response.json(health(6, [source(firstItemId, "greenhouse:replacement", "替换曙光", "rate_limited"), source(secondItemId, "greenhouse:orbit", "星轨"), source(addedItemId, "greenhouse:new", "新来源", null)])))
    .mockResolvedValueOnce(Response.json(reordered, { status: 201 }))
    .mockResolvedValueOnce(Response.json(health(7, [source(secondItemId, "greenhouse:orbit", "星轨"), source(firstItemId, "greenhouse:replacement", "替换曙光", "rate_limited"), source(addedItemId, "greenhouse:new", "新来源", null)])));
  vi.stubGlobal("fetch", fetchMock);
  render(<CompanyWatchlistView initialOverview={initial} initialSourceHealth={initialHealth} />);

  await user.type(screen.getByLabelText("公司规范名称"), "新来源");
  await user.type(screen.getByLabelText("公开招聘入口"), "https://careers.orbit.example/jobs");
  await user.type(screen.getByLabelText("允许域"), "careers.orbit.example");
  await user.click(screen.getByRole("button", { name: "保存目标公司" }));
  await waitFor(() => expect(screen.getAllByText("新来源", { selector: "h3" })).toHaveLength(2));
  expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/job-targets/${targetId}/source-health`, expect.anything());

  await user.click(screen.getByRole("button", { name: "编辑 曙光云图" }));
  await user.clear(screen.getByLabelText("公司规范名称"));
  await user.type(screen.getByLabelText("公司规范名称"), "替换曙光");
  await user.clear(screen.getByLabelText("公开招聘入口"));
  await user.type(screen.getByLabelText("公开招聘入口"), "https://careers.replacement.example/jobs");
  await user.clear(screen.getByLabelText("允许域"));
  await user.type(screen.getByLabelText("允许域"), "careers.replacement.example");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(screen.getAllByText("替换曙光", { selector: "h3" })).toHaveLength(2));
  expect(screen.queryByLabelText("旧曙光 来源诊断")).not.toBeInTheDocument();
  expect(screen.getByLabelText("替换曙光 来源诊断")).toHaveTextContent("尚未检查");

  await user.click(screen.getByRole("button", { name: "停用 替换曙光" }));
  await waitFor(() => expect(screen.getByLabelText("替换曙光 来源诊断")).toHaveTextContent("已停用"));
  await user.click(screen.getByRole("button", { name: "启用 替换曙光" }));
  await waitFor(() => expect(screen.getByLabelText("替换曙光 来源诊断")).toHaveTextContent("访问受限"));
  await user.click(screen.getByRole("button", { name: "上移 星轨智造" }));
  await waitFor(() => expect(screen.getByText("Watchlist 版本 7")).toBeVisible());
  expect(fetchMock).toHaveBeenNthCalledWith(10, `/api/job-targets/${targetId}/source-health`, expect.anything());
});

it("health 刷新失败后编辑或取消不会移除恢复入口，重试成功才恢复诊断", async () => {
  const user = userEvent.setup();
  const initial = overview([item(firstItemId, 1, "曙光云图")], 1);
  const next = overview([{ ...initial.items[0]!, state: "disabled" }], 2);
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(next, { status: 201 }))
    .mockResolvedValueOnce(new Response("unavailable", { status: 502 }))
    .mockResolvedValueOnce(Response.json(health(2, [source(firstItemId, "greenhouse:aurora", "曙光", "disabled")])))
  vi.stubGlobal("fetch", fetchMock);
  render(<CompanyWatchlistView initialOverview={initial} initialSourceHealth={health(1, [source(firstItemId, "greenhouse:aurora", "旧证据")])} />);

  await user.click(screen.getByRole("button", { name: "停用 曙光云图" }));
  await waitFor(() => expect(screen.getByText("Watchlist 已保存，但来源诊断刷新失败。请重新加载来源诊断或刷新页面。")).toBeVisible());
  expect(screen.queryByLabelText("旧证据 来源诊断")).not.toBeInTheDocument();
  expect(screen.getByText("Watchlist 版本 2")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "编辑 曙光云图" }));
  expect(screen.getByRole("button", { name: "重新加载来源诊断" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "取消编辑" }));
  expect(screen.getByRole("button", { name: "重新加载来源诊断" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重新加载来源诊断" }));
  await waitFor(() => expect(screen.getByLabelText("曙光 来源诊断")).toHaveTextContent("已停用"));
  expect(screen.queryByRole("button", { name: "重新加载来源诊断" })).not.toBeInTheDocument();
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
    .mockResolvedValueOnce(Response.json(health(3, [])))
    .mockResolvedValueOnce(Response.json(reordered, { status: 201 }))
    .mockResolvedValueOnce(Response.json(health(4, [])))
    .mockResolvedValueOnce(Response.json(disabled, { status: 201 }))
    .mockResolvedValueOnce(Response.json(health(5, [])))
    .mockResolvedValueOnce(Response.json(enabled, { status: 201 }))
    .mockResolvedValueOnce(Response.json(health(6, [])));
  vi.stubGlobal("fetch", fetchMock);
  render(<CompanyWatchlistView initialOverview={initial} />);

  await user.click(screen.getByRole("button", { name: "编辑 曙光云图" }));
  await user.clear(screen.getByLabelText("来源备注"));
  await user.type(screen.getByLabelText("来源备注"), "更新说明");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/job-targets/${targetId}/company-watchlist/items/${firstItemId}/revisions`, expect.anything()));
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ expectedVersion: 2, sourceNote: "更新说明" });

  await user.click(screen.getByRole("button", { name: "上移 星轨智造" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(3, `/api/job-targets/${targetId}/company-watchlist/reorders`, expect.anything()));
  expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({ expectedVersion: 3, orderedItemIds: [secondItemId, firstItemId] });
  expect(screen.getAllByText("优先级 01")[0]).toBeVisible();

  await user.click(screen.getByRole("button", { name: "停用 星轨智造" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(5, `/api/job-targets/${targetId}/company-watchlist/items/${secondItemId}/state-changes`, expect.anything()));
  expect(JSON.parse(String(fetchMock.mock.calls[4]![1]?.body))).toEqual({ expectedVersion: 4, state: "disabled" });
  expect(screen.getByText("已停用")).toBeVisible();
  expect(screen.getByText("更新说明")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "启用 星轨智造" }));
  await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(7, `/api/job-targets/${targetId}/company-watchlist/items/${secondItemId}/state-changes`, expect.anything()));
  expect(JSON.parse(String(fetchMock.mock.calls[6]![1]?.body))).toEqual({ expectedVersion: 5, state: "enabled" });
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
