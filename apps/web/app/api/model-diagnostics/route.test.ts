import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getModelDiagnostics: vi.fn(), runModelDiagnostics: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getModelDiagnostics: mocks.getModelDiagnostics, runModelDiagnostics: mocks.runModelDiagnostics } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET, POST } from "./route";

const response = {
  status: "unverified" as const,
  checks: { authentication: "not_verified" as const, modelAvailability: "not_verified" as const, structuredOutput: "not_verified" as const, timeout: "not_verified" as const },
  reasonCode: "MODEL_DIAGNOSTIC_CONFIGURATION_MISSING" as const,
  reasonSummary: "尚未完成模型连接检查",
  impact: "当前无法确认模型功能是否可用。",
  suggestedActions: ["请运行模型连接检查。"],
  checkedAt: null,
  latencyBucket: null,
  retryAt: null,
};

afterEach(() => vi.clearAllMocks());

it("BFF 仅以当前会话读取安全 DTO 且禁止缓存", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getModelDiagnostics.mockResolvedValue(response);

  const result = await GET();

  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  await expect(result.json()).resolves.toEqual(response);
  expect(mocks.getModelDiagnostics).toHaveBeenCalledWith("a".repeat(43));
});

it("BFF 拒绝非空 POST 正文，且不触发上游检查", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));

  const result = await POST(new Request("http://localhost/api/model-diagnostics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "failed" }) }));

  expect(result.status).toBe(400);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(mocks.runModelDiagnostics).not.toHaveBeenCalled();
});

it("BFF 对无正文与空对象 POST 只转发当前会话", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.runModelDiagnostics.mockResolvedValue(response);

  await expect(POST(new Request("http://localhost/api/model-diagnostics", { method: "POST" }))).resolves.toMatchObject({ status: 200 });
  await expect(POST(new Request("http://localhost/api/model-diagnostics", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).resolves.toMatchObject({ status: 200 });
  expect(mocks.runModelDiagnostics).toHaveBeenCalledTimes(2);
  expect(mocks.runModelDiagnostics).toHaveBeenCalledWith("a".repeat(43));
});
