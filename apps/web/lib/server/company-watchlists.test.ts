import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCompanyWatchlist: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));

vi.mock("@/lib/server/api-client", () => ({ api: { getCompanyWatchlist: mocks.getCompanyWatchlist } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getCompanyWatchlist } from "./company-watchlists";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";

afterEach(() => vi.clearAllMocks());

it("将未登录 Watchlist 读取重定向到精确编码的动态回跳地址", async () => {
  mocks.readSessionToken.mockResolvedValue(null);

  await expect(getCompanyWatchlist(targetId)).rejects.toThrow(
    "redirect:/login?returnTo=%2Fprofile%2Ftargets%2Fd194d0ce-fc7e-45db-9425-e8ff4eaf8c08%2Fwatchlist",
  );
});

it("使用会话读取已验证的 Watchlist 概览并在 API 重新认证失败时跳转", async () => {
  const overview = {
    target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 0, items: [],
  };
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getCompanyWatchlist.mockResolvedValue(overview);

  await expect(getCompanyWatchlist(targetId)).resolves.toEqual(overview);
  expect(mocks.getCompanyWatchlist).toHaveBeenCalledWith("a".repeat(43), targetId);

  mocks.getCompanyWatchlist.mockRejectedValue({ status: 401 });
  await expect(getCompanyWatchlist(targetId)).rejects.toThrow("redirect:/login?returnTo=");
});
