import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ control: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { controlAccountRuns: mocks.control } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.token }));

import { POST } from "./route";

afterEach(() => vi.clearAllMocks());

const command = { commandId: "00000000-0000-4000-8000-000000000001", expectedVersion: 0, action: "stop" } as const;

it("严格转发停止命令并对首次、无操作和重放统一返回 200", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  mocks.control.mockResolvedValue({ applied: true, state: { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null } });

  const response = await POST(new Request("http://localhost/api/account/run-policy/controls", { method: "POST", body: JSON.stringify(command) }));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ applied: true, state: { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null } });
  expect(mocks.control).toHaveBeenCalledWith("a".repeat(43), command);
});

it("拒绝浏览器伪造账户、设置、原因及无效命令", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  for (const value of [
    { ...command, userId: "00000000-0000-4000-8000-000000000002" },
    { ...command, settings: {} },
    { ...command, reason: "stop" },
    { ...command, expectedVersion: -1 },
    { ...command, action: "resume" },
    { ...command, commandId: "not-a-uuid" },
  ]) await expect(POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(value) }))).resolves.toMatchObject({ status: 400 });
  expect(mocks.control).not.toHaveBeenCalled();
});

it("只公开两种控制冲突，畸形上游响应降级为无正文 502", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  for (const code of ["ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT", "ACCOUNT_RUN_CONTROL_VERSION_CONFLICT"] as const) {
    mocks.control.mockRejectedValueOnce(Object.assign(new Error("safe"), { status: 409, problem: { code, message: "upstream-secret", requestId: "00000000-0000-4000-8000-000000000002" } }));
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code, message: "账户运行控制已变化，请刷新后重试" });
  }
  mocks.control.mockRejectedValueOnce(Object.assign(new Error("upstream-secret"), { status: 409, problem: { code: "UNTRUSTED", message: "upstream-secret" } }));

  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));

  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
});
