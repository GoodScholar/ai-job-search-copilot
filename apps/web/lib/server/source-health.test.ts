import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSourceHealth: vi.fn(), readSessionToken: vi.fn(), redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }) }));
vi.mock("@/lib/server/api-client", () => ({ api: { getSourceHealth: mocks.getSourceHealth } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getSourceHealth } from "./source-health";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const overview = { targetId, watchlistVersion: 0, sources: [] };
afterEach(() => vi.clearAllMocks());

it("服务器查询只携带会话令牌，并把缺失或过期认证导向目标 Watchlist", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(getSourceHealth(targetId)).rejects.toThrow("redirect:/login?returnTo=%2Fprofile%2Ftargets%2F");
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getSourceHealth.mockResolvedValue(overview);
  await expect(getSourceHealth(targetId)).resolves.toEqual(overview);
  expect(mocks.getSourceHealth).toHaveBeenCalledWith("a".repeat(43), targetId);
  mocks.getSourceHealth.mockRejectedValue({ status: 401 });
  await expect(getSourceHealth(targetId)).rejects.toThrow("redirect:/login?returnTo=");
});
