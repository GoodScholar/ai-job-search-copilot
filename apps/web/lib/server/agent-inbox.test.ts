import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgentInbox: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));
vi.mock("@/lib/server/api-client", () => ({ api: { listAgentInbox: mocks.listAgentInbox } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getOpenAgentInbox } from "./agent-inbox";

afterEach(() => vi.clearAllMocks());

it("未登录时跳转到包含工作台返回地址的登录页", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(getOpenAgentInbox()).rejects.toThrow("redirect:/login?returnTo=%2F");
});

it("只在服务端读取 HttpOnly 会话并代理打开的 Agent Inbox", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listAgentInbox.mockResolvedValue({ items: [] });
  await expect(getOpenAgentInbox()).resolves.toEqual({ items: [] });
  expect(mocks.listAgentInbox).toHaveBeenCalledWith("a".repeat(43), "open");
});

it("上游会话失效时使用同一登录重定向", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listAgentInbox.mockRejectedValue({ status: 401 });
  await expect(getOpenAgentInbox()).rejects.toThrow("redirect:/login?returnTo=%2F");
});
