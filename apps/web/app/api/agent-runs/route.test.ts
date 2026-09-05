import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLatestAgentRun: vi.fn(),
  startAgentRun: vi.fn(),
  readSessionToken: vi.fn(),
}));
vi.mock("@/lib/server/api-client", () => ({ ApiClientError: class ApiClientError extends Error {
  constructor(readonly kind: string, message: string, readonly status?: number, readonly problem?: unknown) { super(message); }
}, api: {
  getLatestAgentRun: mocks.getLatestAgentRun,
  startAgentRun: mocks.startAgentRun,
} }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET, POST } from "./route";

afterEach(() => vi.clearAllMocks());
const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const command = { targetId, idempotencyKey: "91cc6d11-6e50-4456-b2f0-393461336376" };

it("缺少 HttpOnly 会话时不读取或启动运行", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(GET()).resolves.toMatchObject({ status: 401 });
  await expect(POST(new Request("http://localhost/api/agent-runs", { method: "POST", body: JSON.stringify(command) })))
    .resolves.toMatchObject({ status: 401 });
  expect(mocks.getLatestAgentRun).not.toHaveBeenCalled();
  expect(mocks.startAgentRun).not.toHaveBeenCalled();
});

it("严格校验启动命令，并保持 201/200 幂等语义与 no-store", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const invalid = await POST(new Request("http://localhost/api/agent-runs", {
    method: "POST", body: JSON.stringify({ ...command, rawPayload: "secret" }),
  }));
  expect(invalid.status).toBe(400);

  mocks.startAgentRun
    .mockResolvedValueOnce({ runId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", reused: false })
    .mockResolvedValueOnce({ runId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", reused: true });
  const first = await POST(new Request("http://localhost/api/agent-runs", { method: "POST", body: JSON.stringify(command) }));
  const duplicate = await POST(new Request("http://localhost/api/agent-runs", { method: "POST", body: JSON.stringify(command) }));

  expect(first.status).toBe(201);
  expect(duplicate.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(mocks.startAgentRun).toHaveBeenCalledWith("a".repeat(43), expect.objectContaining(command));
});

it("以 no-store 代理最近运行", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getLatestAgentRun.mockResolvedValue({ run: null });
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ run: null });
});

it("仅将严格预检 409 原样返回；未知 409 仍为 502", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const preflight = { version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId, status: "blocked", warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z", items: [{ code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: "缺少主求职目标", impact: "请先创建主求职目标。", retryable: false, suggestedActions: ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: "2026-09-05T00:00:00.000Z" } }] };
  mocks.startAgentRun.mockRejectedValueOnce(Object.assign(new Error("运行前检查未通过"), { status: 409, problem: { code: "RUN_PREFLIGHT_BLOCKED", message: "运行前检查未通过", preflight } }));
  const blocked = await POST(new Request("http://localhost/api/agent-runs", { method: "POST", body: JSON.stringify(command) }));
  expect(blocked.status).toBe(409); expect(await blocked.json()).toEqual({ code: "RUN_PREFLIGHT_BLOCKED", message: "运行前检查未通过", preflight });
  mocks.startAgentRun.mockRejectedValueOnce(Object.assign(new Error("unknown"), { status: 409 }));
  await expect(POST(new Request("http://localhost/api/agent-runs", { method: "POST", body: JSON.stringify(command) }))).resolves.toMatchObject({ status: 502 });
});
