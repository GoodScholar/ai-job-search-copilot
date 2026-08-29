import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCompanyWatchlist: vi.fn(),
  view: vi.fn(() => null),
  unstableRethrow: vi.fn((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("NEXT_")) throw error;
  }),
}));

vi.mock("@/lib/server/company-watchlists", () => ({ getCompanyWatchlist: mocks.getCompanyWatchlist }));
vi.mock("@/components/workbench/company-watchlist-view", () => ({ CompanyWatchlistView: mocks.view }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.unstableRethrow }));

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

  const page = await WatchlistPage(context);

  expect(page.props.initialOverview).toEqual(overview);
});

it("为可恢复读取失败展示固定重试提示且不泄漏内部详情", async () => {
  mocks.getCompanyWatchlist.mockRejectedValue(new Error("http://internal-api:3021 secret"));

  const page = await WatchlistPage(context);

  expect(JSON.stringify(page)).toContain("暂时无法读取目标公司 Watchlist。请稍后重新尝试。");
  expect(JSON.stringify(page)).not.toContain("internal-api");
});
