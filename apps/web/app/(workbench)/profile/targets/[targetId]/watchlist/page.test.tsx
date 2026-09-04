import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCompanyWatchlist: vi.fn(),
  getSourceHealth: vi.fn(),
  getSourceCapabilities: vi.fn(),
  view: vi.fn(() => null),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  unstableRethrow: vi.fn((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("NEXT_")) throw error;
  }),
}));

vi.mock("@/lib/server/company-watchlists", () => ({ getCompanyWatchlist: mocks.getCompanyWatchlist }));
vi.mock("@/lib/server/source-health", () => ({ getSourceHealth: mocks.getSourceHealth }));
vi.mock("@/lib/server/source-capabilities", () => ({ getSourceCapabilities: mocks.getSourceCapabilities }));
vi.mock("@/components/workbench/company-watchlist-view", () => ({ CompanyWatchlistView: mocks.view }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, unstable_rethrow: mocks.unstableRethrow }));

import WatchlistPage, { metadata } from "./page";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const context = { params: Promise.resolve({ targetId }) };

it("保留 Next 控制流错误并声明 Watchlist 页面元数据", async () => {
  expect(metadata.title).toBe("目标公司 Watchlist | AI Job Search Copilot");
  const redirectError = new Error("NEXT_REDIRECT:/login");
  mocks.getCompanyWatchlist.mockRejectedValue(redirectError);

  await expect(WatchlistPage(context)).rejects.toThrow("NEXT_REDIRECT:/login");
  expect(mocks.unstableRethrow).toHaveBeenCalledWith(redirectError);
});

it("将服务端已验证概览传给客户端视图", async () => {
  const overview = { target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 0, items: [] };
  mocks.getCompanyWatchlist.mockResolvedValue(overview);
  mocks.getSourceHealth.mockResolvedValue({ targetId, watchlistVersion: 0, sources: [] });
  mocks.getSourceCapabilities.mockResolvedValue({ targetId, watchlistVersion: 0, sources: [] });

  const page = await WatchlistPage(context);

  expect(page.props.initialOverview).toEqual(overview);
  expect(page.props.initialSourceHealth).toEqual({ targetId, watchlistVersion: 0, sources: [] });
  expect(page.props.initialSourceCapabilities).toEqual({ targetId, watchlistVersion: 0, sources: [] });
});

it("将初次 target 或 Watchlist 版本不匹配的健康概览降级为可重试诊断", async () => {
  const overview = { target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 3, items: [] };
  mocks.getCompanyWatchlist.mockResolvedValue(overview);

  for (const sourceHealth of [
    { targetId: "a194d0ce-fc7e-45db-9425-e8ff4eaf8c08", watchlistVersion: 3, sources: [] },
    { targetId, watchlistVersion: 2, sources: [] },
  ]) {
    mocks.getSourceHealth.mockResolvedValue(sourceHealth);
    const page = await WatchlistPage(context);
    expect(page.props.initialOverview).toEqual(overview);
    expect(page.props.initialSourceHealth).toBeUndefined();
    expect(page.props.initialHealthRefreshFailed).toBe(true);
  }
});

it("仅初次健康读取失败时仍将 Watchlist 和可恢复诊断传给视图", async () => {
  const overview = { target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 0, items: [] };
  const healthError = new Error("http://internal-api:3021 source health");
  mocks.getCompanyWatchlist.mockResolvedValue(overview);
  mocks.getSourceHealth.mockRejectedValue(healthError);

  const page = await WatchlistPage(context);

  expect(page.props.initialOverview).toEqual(overview);
  expect(page.props.initialSourceHealth).toBeUndefined();
  expect(page.props.initialHealthRefreshFailed).toBe(true);
  expect(mocks.unstableRethrow).toHaveBeenCalledWith(healthError);
  expect(JSON.stringify(page)).not.toContain("无法读取目标公司 Watchlist");
});

it("保留来源健康读取的 Next 控制流错误", async () => {
  const redirectError = new Error("NEXT_REDIRECT:/login?returnTo=%2Fprofile%2Ftargets");
  mocks.getCompanyWatchlist.mockResolvedValue({ target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 0, items: [] });
  mocks.getSourceHealth.mockRejectedValue(redirectError);

  await expect(WatchlistPage(context)).rejects.toThrow("NEXT_REDIRECT:/login");
  expect(mocks.unstableRethrow).toHaveBeenCalledWith(redirectError);
});

it("为可恢复读取失败展示固定重试提示且不泄漏内部详情", async () => {
  mocks.getCompanyWatchlist.mockRejectedValue(new Error("http://internal-api:3021 secret"));
  mocks.getSourceHealth.mockResolvedValue({ targetId, watchlistVersion: 0, sources: [] });

  const page = await WatchlistPage(context);

  expect(JSON.stringify(page)).toContain("暂时无法读取目标公司 Watchlist。请稍后重新尝试。");
  expect(JSON.stringify(page)).not.toContain("internal-api");
});

it("在服务端本地拒绝非法 targetId，且不读取会话或内部 API", async () => {
  mocks.getCompanyWatchlist.mockResolvedValue({ target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 0, items: [] });

  await expect(WatchlistPage({ params: Promise.resolve({ targetId: "not-a-uuid" }) })).rejects.toThrow("NEXT_NOT_FOUND");

  expect(mocks.notFound).toHaveBeenCalledTimes(1);
  expect(mocks.getCompanyWatchlist).not.toHaveBeenCalledWith("not-a-uuid");
});
