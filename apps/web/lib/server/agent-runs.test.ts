import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLatestAgentRun: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));
vi.mock("@/lib/server/api-client", () => ({ api: { getLatestAgentRun: mocks.getLatestAgentRun } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getLatestAgentRun } from "./agent-runs";

afterEach(() => vi.clearAllMocks());

it("未登录时跳转到包含工作台返回地址的登录页", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(getLatestAgentRun()).rejects.toThrow("redirect:/login?returnTo=%2F");
});

it("只在服务端读取 HttpOnly 会话并代理最近运行", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getLatestAgentRun.mockResolvedValue({ run: null });
  await expect(getLatestAgentRun()).resolves.toEqual({ run: null });
  expect(mocks.getLatestAgentRun).toHaveBeenCalledWith("a".repeat(43));
});
