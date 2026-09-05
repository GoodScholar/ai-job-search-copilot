import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelDiagnostics: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/server/api-client", () => ({ api: { getModelDiagnostics: mocks.getModelDiagnostics } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getModelDiagnostics } from "./model-diagnostics";

const response = {
  status: "available" as const,
  checks: { authentication: "passed" as const, modelAvailability: "passed" as const, structuredOutput: "passed" as const, timeout: "passed" as const },
  reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE" as const,
  reasonSummary: "模型连接正常",
  impact: "模型功能可用。",
  suggestedActions: [],
  checkedAt: "2026-09-05T00:00:00.000Z",
  latencyBucket: "under_1s" as const,
  retryAt: null,
};

it("读取当前会话的严格模型连接诊断响应", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getModelDiagnostics.mockResolvedValue(response);

  await expect(getModelDiagnostics()).resolves.toEqual(response);
  expect(mocks.getModelDiagnostics).toHaveBeenCalledWith("a".repeat(43));
});

it("缺少或失效会话时保持模型连接页的登录跳转", async () => {
  mocks.redirect.mockImplementation(() => { throw new Error("redirect"); });
  mocks.readSessionToken.mockResolvedValueOnce(null).mockResolvedValueOnce("a".repeat(43));
  mocks.getModelDiagnostics.mockRejectedValueOnce({ status: 401 });

  await expect(getModelDiagnostics()).rejects.toThrow("redirect");
  await expect(getModelDiagnostics()).rejects.toThrow("redirect");

  expect(mocks.redirect).toHaveBeenNthCalledWith(1, "/login?returnTo=%2Fprofile%2Fmodel-connection");
  expect(mocks.redirect).toHaveBeenNthCalledWith(2, "/login?returnTo=%2Fprofile%2Fmodel-connection");
});
