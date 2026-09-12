import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ApiClientError extends Error {
    readonly kind: string; readonly status: number | undefined; readonly problem: { code?: string; message?: string; preflight?: unknown } | undefined;
    constructor(problem: { code?: string; message?: string; preflight?: unknown });
    constructor(kind: string, message: string, status?: number, problem?: { code?: string; message?: string; preflight?: unknown });
    constructor(kindOrProblem: string | { code?: string; message?: string; preflight?: unknown } = "api", message = "api", status?: number, problem?: { code?: string; message?: string; preflight?: unknown }) {
      super(typeof kindOrProblem === "string" ? message : "api"); this.kind = typeof kindOrProblem === "string" ? kindOrProblem : "api"; this.status = typeof kindOrProblem === "string" ? status : undefined; this.problem = typeof kindOrProblem === "string" ? problem : kindOrProblem;
    }
  }
  return { ApiClientError, redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }), revalidatePath: vi.fn(), resolveCalibrationProposal: vi.fn(), startDeepMatchRun: vi.fn(), readSessionToken: vi.fn() };
});
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/server/api-client", () => ({ api: { resolveCalibrationProposal: mocks.resolveCalibrationProposal, startDeepMatchRun: mocks.startDeepMatchRun }, ApiClientError: mocks.ApiClientError }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { requestRecommendationReevaluationAction, resolveCalibrationProposalAction } from "./actions";

it("规则版本 409 返回结构化冲突结果且仍失效 recommendations 读模型", async () => {
  mocks.readSessionToken.mockResolvedValue("session");
  mocks.resolveCalibrationProposal.mockRejectedValue(new mocks.ApiClientError({ code: "RULE_VERSION_CONFLICT" }));
  const formData = new FormData(); formData.set("action", "approved"); formData.set("expectedVersion", "1"); formData.set("idempotencyKey", "00000000-0000-4000-8000-000000000001");

  await expect(resolveCalibrationProposalAction("00000000-0000-4000-8000-000000000002", formData)).resolves.toEqual({ kind: "rule_version_conflict" });
  expect(mocks.revalidatePath).toHaveBeenCalledWith("/recommendations");
});

it("预检 blocker 返回判别结果并保留调用方幂等键", async () => {
  mocks.readSessionToken.mockResolvedValue("session");
  const preflight = { version: "run-preflight-v1", workflow: "deep_match", trigger: "manual", targetId: "00000000-0000-4000-8000-000000000002", status: "blocked", warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z", items: [{ code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: "缺少主求职目标", impact: "请先创建主求职目标。", retryable: false, suggestedActions: ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: "2026-09-05T00:00:00.000Z" } }] };
  mocks.startDeepMatchRun.mockRejectedValue(new mocks.ApiClientError("api", "运行前检查未通过", 409, { code: "RUN_PREFLIGHT_BLOCKED", message: "运行前检查未通过", preflight }));
  const form = new FormData(); form.set("idempotencyKey", "00000000-0000-4000-8000-000000000001");
  await expect(requestRecommendationReevaluationAction("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", form)).resolves.toEqual({ kind: "blocked", preflight });
  expect(mocks.startDeepMatchRun).toHaveBeenCalledWith("session", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000001", null);
});

it("预检 warning 缺失、过期、当前确认连续复用同一幂等键，成功才失效读模型", async () => {
  mocks.revalidatePath.mockClear();
  mocks.readSessionToken.mockResolvedValue("session");
  const targetId = "00000000-0000-4000-8000-000000000002";
  const opportunityId = "00000000-0000-4000-8000-000000000003";
  const staleFingerprint = "a".repeat(64);
  const currentFingerprint = "b".repeat(64);
  const preflight = { version: "run-preflight-v1", workflow: "deep_match", trigger: "manual", targetId, status: "ready_with_warnings", warningFingerprint: staleFingerprint, checkedAt: "2026-09-05T00:00:00.000Z", items: [{ code: "SOURCE_HEALTH_DEGRADED", severity: "warning", summary: "来源健康存在降级", impact: "结果可能不完整，请确认后继续。", retryable: true, suggestedActions: ["review_source_health"], evidence: { kind: "source_health", checkedSourceCount: 1, healthySourceCount: 0, degradedSourceCount: 1, uncheckedSourceCount: 0, latestCheckedAt: "2026-09-05T00:00:00.000Z" } }] };
  const refreshedPreflight = { ...preflight, warningFingerprint: currentFingerprint };
  const idempotencyKey = "00000000-0000-4000-8000-000000000001";
  const missingForm = new FormData(); missingForm.set("idempotencyKey", idempotencyKey);
  const staleForm = new FormData(); staleForm.set("idempotencyKey", idempotencyKey); staleForm.set("warningFingerprint", staleFingerprint);
  const currentForm = new FormData(); currentForm.set("idempotencyKey", idempotencyKey); currentForm.set("warningFingerprint", currentFingerprint);
  mocks.startDeepMatchRun
    .mockRejectedValueOnce(new mocks.ApiClientError("api", "需要确认", 409, { code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", message: "需要确认", preflight }))
    .mockRejectedValueOnce(new mocks.ApiClientError("api", "确认已过期", 409, { code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", message: "确认已过期", preflight: refreshedPreflight }))
    .mockResolvedValueOnce({ runId: "00000000-0000-4000-8000-000000000005", reused: false });
  await expect(requestRecommendationReevaluationAction(targetId, opportunityId, missingForm)).resolves.toEqual({ kind: "warning_confirmation_required", preflight });
  expect(mocks.startDeepMatchRun).toHaveBeenLastCalledWith("session", targetId, opportunityId, idempotencyKey, null);
  expect(mocks.revalidatePath).not.toHaveBeenCalledWith("/recommendations");

  await expect(requestRecommendationReevaluationAction(targetId, opportunityId, staleForm)).resolves.toEqual({ kind: "warning_confirmation_required", preflight: refreshedPreflight });
  expect(mocks.startDeepMatchRun).toHaveBeenLastCalledWith("session", targetId, opportunityId, idempotencyKey, staleFingerprint);

  await expect(requestRecommendationReevaluationAction(targetId, opportunityId, currentForm)).resolves.toEqual({ kind: "started" });
  expect(mocks.startDeepMatchRun).toHaveBeenLastCalledWith("session", targetId, opportunityId, idempotencyKey, currentFingerprint);
  expect(mocks.revalidatePath).toHaveBeenCalledWith("/recommendations");
});

it("未知重评错误不被当作预检冲突", async () => {
  mocks.readSessionToken.mockResolvedValue("session");
  const form = new FormData(); form.set("idempotencyKey", "00000000-0000-4000-8000-000000000001");
  mocks.startDeepMatchRun.mockRejectedValueOnce(new mocks.ApiClientError("api", "上游错误", 502));
  await expect(requestRecommendationReevaluationAction("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", form)).rejects.toMatchObject({ status: 502 });
});

it("账户全局停止返回策略页修复结果，而不是把安全 409 当作未知错误", async () => {
  mocks.readSessionToken.mockResolvedValue("session");
  const form = new FormData(); form.set("idempotencyKey", "00000000-0000-4000-8000-000000000001");
  mocks.startDeepMatchRun.mockRejectedValueOnce(new mocks.ApiClientError("api", "账户已停止全部运行，请先解除全局停止", 409, { code: "ACCOUNT_RUN_STOPPED", message: "账户已停止全部运行，请先解除全局停止" }));

  await expect(requestRecommendationReevaluationAction("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", form)).resolves.toEqual({ kind: "account_run_stopped" });
});

it("大写 warning fingerprint 不会穿过 action 边界", async () => {
  mocks.readSessionToken.mockResolvedValue("session");
  const form = new FormData(); form.set("idempotencyKey", "00000000-0000-4000-8000-000000000001"); form.set("warningFingerprint", "A".repeat(64));
  mocks.startDeepMatchRun.mockResolvedValueOnce({ runId: "00000000-0000-4000-8000-000000000005", reused: false });
  await expect(requestRecommendationReevaluationAction("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", form)).resolves.toEqual({ kind: "started" });
  expect(mocks.startDeepMatchRun).toHaveBeenLastCalledWith("session", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000001", null);
});

it("无会话时重定向到 recommendations 登录入口且绝不启动重评", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  mocks.startDeepMatchRun.mockClear();
  const form = new FormData(); form.set("idempotencyKey", "00000000-0000-4000-8000-000000000001");
  await expect(requestRecommendationReevaluationAction("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", form)).rejects.toThrow("NEXT_REDIRECT");
  expect(mocks.redirect).toHaveBeenCalledWith("/login?returnTo=%2Frecommendations");
  expect(mocks.startDeepMatchRun).not.toHaveBeenCalled();
});
