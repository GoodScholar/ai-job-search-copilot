import { expect, it } from "vitest";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import { AccountRunAdmissionError } from "@job-copilot/domain/account-run-control";
import { RecommendationsController } from "./recommendations.controller.js";

const report = { version: "run-preflight-v1" as const, workflow: "deep_match" as const, trigger: "manual" as const, targetId: "00000000-0000-4000-8000-000000000001", status: "blocked" as const, warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z", items: [{ code: "PRIMARY_JOB_TARGET_MISSING" as const, severity: "blocking" as const, summary: "缺少主求职目标", impact: "请先创建主求职目标。", retryable: false, suggestedActions: ["review_job_targets" as const], evidence: { kind: "job_target" as const, primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing" as const, checkedAt: "2026-09-05T00:00:00.000Z" } }] };

it("重新评估仅把已知预检拒绝映射为带安全报告的 409", async () => {
  const controller = new RecommendationsController({} as never, { start: async () => { throw new RunPreflightRejectedError("RUN_PREFLIGHT_BLOCKED", report); } } as never, {} as never, {} as never);
  await expect(controller.reevaluate({ authenticatedAccount: { userId: "owner" } } as never, { targetId: report.targetId, opportunityId: "00000000-0000-4000-8000-000000000002", idempotencyKey: "00000000-0000-4000-8000-000000000003", warningFingerprint: null } as never)).rejects.toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED", status: 409, details: { preflight: report } });
});

it("账户停止时手动重新评估返回安全 409", async () => {
  const controller = new RecommendationsController({} as never, { start: async () => { throw new AccountRunAdmissionError("ACCOUNT_RUN_STOPPED"); } } as never, {} as never, {} as never);
  await expect(controller.reevaluate({ authenticatedAccount: { userId: "owner" } } as never, { targetId: report.targetId, opportunityId: "00000000-0000-4000-8000-000000000002", idempotencyKey: "00000000-0000-4000-8000-000000000003", warningFingerprint: null } as never)).rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED", status: 409, publicMessage: "账户已停止全部运行，请先解除全局停止" });
});
