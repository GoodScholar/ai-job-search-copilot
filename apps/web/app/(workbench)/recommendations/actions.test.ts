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
  return { ApiClientError, revalidatePath: vi.fn(), resolveCalibrationProposal: vi.fn(), startDeepMatchRun: vi.fn(), readSessionToken: vi.fn() };
});
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
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
