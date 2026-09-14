import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ startRecommendationRun: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { startRecommendationRun: mocks.startRecommendationRun } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
import { POST } from "./route";
afterEach(() => vi.clearAllMocks());
const command = { idempotencyKey: "00000000-0000-4000-8000-000000000001", warningFingerprint: null };
it("拒绝未认证或越权启动字段，且不调用上游", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  const unauthorized = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  expect(unauthorized.status).toBe(401); expect(await unauthorized.text()).toBe(""); expect(unauthorized.headers.get("cache-control")).toBe("no-store");
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const invalid = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...command, targetId: "00000000-0000-4000-8000-000000000002" }) }));
  expect(invalid.status).toBe(400); expect(await invalid.text()).toBe(""); expect(invalid.headers.get("cache-control")).toBe("no-store");
  expect(mocks.startRecommendationRun).not.toHaveBeenCalled();
});
it("首次启动为 201、重放为 200，响应始终 no-store", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.startRecommendationRun.mockResolvedValueOnce({ run: { runId: "x" }, reused: false }).mockResolvedValueOnce({ run: { runId: "x" }, reused: true });
  const first = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  const replay = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  expect([first.status, replay.status]).toEqual([201, 200]); expect(first.headers.get("cache-control")).toBe("no-store"); expect(await replay.json()).toEqual({ run: { runId: "x" }, reused: true }); expect(replay.headers.get("cache-control")).toBe("no-store");
});
it("畸形或未知上游错误折叠为无正文 502", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43)); mocks.startRecommendationRun.mockRejectedValue({ status: 409, problem: { secret: "token" } });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) })); expect(response.status).toBe(502); expect(await response.text()).toBe(""); expect(response.headers.get("cache-control")).toBe("no-store");
});
it("blocked 与 warning 预检只投影有限安全文案，保留合法结构事实", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const sentinel = "Bearer secret-sentinel";
  const blocked = { code: "RUN_PREFLIGHT_BLOCKED", message: `错误 ${sentinel}`, preflight: { version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId: null, status: "blocked", warningFingerprint: null, checkedAt: "2026-09-14T00:00:00.000Z", items: [{ code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: `错误 ${sentinel}`, impact: `错误 ${sentinel}`, retryable: false, suggestedActions: ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: "2026-09-14T00:00:00.000Z" } }] } };
  const warning = { code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", message: `错误 ${sentinel}`, preflight: { version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId: "00000000-0000-4000-8000-000000000002", status: "ready_with_warnings", warningFingerprint: "a".repeat(64), checkedAt: "2026-09-14T00:00:00.000Z", items: [{ code: "SOURCE_HEALTH_UNCHECKED", severity: "warning", summary: `错误 ${sentinel}`, impact: `错误 ${sentinel}`, retryable: true, suggestedActions: ["review_source_health"], evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null } }] } };
  mocks.startRecommendationRun.mockRejectedValueOnce({ status: 409, problem: blocked }).mockRejectedValueOnce({ status: 409, problem: warning });
  const blockedResponse = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  const warningResponse = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  const blockedBody = await blockedResponse.json(); const warningBody = await warningResponse.json();
  expect(blockedResponse.status).toBe(409); expect(warningResponse.status).toBe(409); expect(blockedResponse.headers.get("cache-control")).toBe("no-store"); expect(warningResponse.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify([blockedBody, warningBody])).not.toContain(sentinel);
  expect(blockedBody).toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED", message: "运行前检查未通过", preflight: { checkedAt: blocked.preflight.checkedAt, items: [{ summary: "缺少活动主目标", impact: "请先设置一个活动主求职目标。", suggestedActions: ["review_job_targets"], evidence: blocked.preflight.items[0].evidence }] } });
  expect(warningBody).toMatchObject({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", message: "请确认当前运行前检查提示", preflight: { warningFingerprint: warning.preflight.warningFingerprint, items: [{ summary: "来源尚未完成健康检查", impact: "运行可以继续，建议稍后查看来源健康状态。", suggestedActions: ["review_source_health"], evidence: warning.preflight.items[0].evidence }] } });
});
it("start 分别代理成功、账户停止、命令冲突、上游 400/401，且每条响应 no-store", async () => {
  const token = "a".repeat(43); mocks.readSessionToken.mockResolvedValue(token);
  mocks.startRecommendationRun.mockResolvedValue({ run: { runId: "x" }, reused: false });
  const success = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  expect(success.status).toBe(201); expect(await success.json()).toEqual({ run: { runId: "x" }, reused: false }); expect(mocks.startRecommendationRun).toHaveBeenCalledWith(token, command);
  mocks.startRecommendationRun.mockRejectedValue({ status: 409, problem: { code: "ACCOUNT_RUN_STOPPED", message: "Bearer secret", requestId: "00000000-0000-4000-8000-000000000010" } });
  const stopped = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) })); expect(stopped.status).toBe(409); expect(await stopped.json()).toEqual({ code: "ACCOUNT_RUN_STOPPED", message: "账户已停止全部运行，请先解除全局停止" });
  mocks.startRecommendationRun.mockRejectedValue({ status: 409, problem: { code: "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT", message: "Bearer secret", requestId: "00000000-0000-4000-8000-000000000010" } });
  const commandConflict = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) })); expect(commandConflict.status).toBe(409); expect(await commandConflict.json()).toEqual({ code: "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT", message: "推荐运行状态已变化，请刷新后重试" });
  mocks.startRecommendationRun.mockRejectedValue({ status: 400 }); const badRequest = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  mocks.startRecommendationRun.mockRejectedValue({ status: 401 }); const unauthorized = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }));
  expect([badRequest.status, unauthorized.status]).toEqual([400, 401]);
  for (const response of [success, stopped, commandConflict, badRequest, unauthorized]) expect(response.headers.get("cache-control")).toBe("no-store");
});
