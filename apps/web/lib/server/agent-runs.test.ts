import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLatestAgentRun: vi.fn(),
  getAgentRun: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));
vi.mock("@/lib/server/api-client", () => ({ api: { getLatestAgentRun: mocks.getLatestAgentRun, getAgentRun: mocks.getAgentRun } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getAgentRun, getLatestAgentRun } from "./agent-runs";

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

it("指定运行通过 owner-bound API 读取，404 安全投影为空", async () => {
  const runId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getAgentRun.mockRejectedValue({ status: 404 });

  await expect(getAgentRun(runId)).resolves.toBeNull();
  expect(mocks.getAgentRun).toHaveBeenCalledWith("a".repeat(43), runId);
});
