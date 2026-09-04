import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ controlAgentRun: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { controlAgentRun: mocks.controlAgentRun } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { POST } from "./route";

afterEach(() => vi.clearAllMocks());
const runId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const command = { commandId: "48d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "pause" };
const context = (value: string) => ({ params: Promise.resolve({ runId: value }) });

it("缺少会话或无效运行标识时拒绝控制且不调用上游", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(POST(new Request("http://localhost"), context(runId))).resolves.toMatchObject({ status: 401 });
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context("not-a-uuid"))).resolves.toMatchObject({ status: 404 });
  expect(mocks.controlAgentRun).not.toHaveBeenCalled();
});

it("严格校验控制命令并以 no-store 透传相同 commandId 的精确结果", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const invalid = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...command, rawError: "secret" }) }), context(runId));
  expect(invalid.status).toBe(400);
  const replay = { applied: false, run: { runId, status: "paused", currentStep: "queued", controlState: "none", version: 2 } };
  mocks.controlAgentRun.mockResolvedValue(replay);

  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context(runId));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual(replay);
  expect(mocks.controlAgentRun).toHaveBeenCalledWith("a".repeat(43), runId, command);
});

it("只透传安全上游状态，并折叠内部故障", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.controlAgentRun
    .mockRejectedValueOnce({ status: 400, message: "bad" })
    .mockRejectedValueOnce({ status: 401, message: "Bearer secret" })
    .mockRejectedValueOnce({ status: 404, message: "bad" })
    .mockRejectedValueOnce({ status: 409, message: "bad" })
    .mockRejectedValueOnce({ status: 500, message: "Bearer secret internal" });
  for (const status of [400, 401, 404, 409, 502]) {
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context(runId));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("secret");
  }
});
