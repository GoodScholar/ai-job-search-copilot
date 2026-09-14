import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ startRecommendationRun: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { startRecommendationRun: mocks.startRecommendationRun } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
import { POST } from "./route";
afterEach(() => vi.clearAllMocks());
const command = { idempotencyKey: "00000000-0000-4000-8000-000000000001", warningFingerprint: null };
it("拒绝未认证或越权启动字段，且不调用上游", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }))).resolves.toMatchObject({ status: 401 });
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...command, targetId: "00000000-0000-4000-8000-000000000002" }) }))).resolves.toMatchObject({ status: 400 });
  expect(mocks.startRecommendationRun).not.toHaveBeenCalled();
});
it("首次启动为 201、重放为 200，响应始终 no-store", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.startRecommendationRun.mockResolvedValueOnce({ run: { runId: "x" }, reused: false }).mockResolvedValueOnce({ run: { runId: "x" }, reused: true });
  const first = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  const replay = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  expect([first.status, replay.status]).toEqual([201, 200]); expect(first.headers.get("cache-control")).toBe("no-store");
});
it("畸形或未知上游错误折叠为无正文 502", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43)); mocks.startRecommendationRun.mockRejectedValue({ status: 409, problem: { secret: "token" } });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) })); expect(response.status).toBe(502); expect(await response.text()).toBe("");
});
