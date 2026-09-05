import { describe, expect, it } from "vitest";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import { runPreflightConflict } from "./run-preflight-error.js";
import { RunPreflightController } from "./run-preflight.controller.js";

const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const report = {
  version: "run-preflight-v1" as const, workflow: "discovery" as const, trigger: "manual" as const, targetId,
  status: "blocked" as const, warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z",
  items: [{ code: "PRIMARY_JOB_TARGET_MISSING" as const, severity: "blocking" as const, summary: "缺少主求职目标", impact: "请先创建主求职目标。", retryable: false, suggestedActions: ["review_job_targets" as const], evidence: { kind: "job_target" as const, primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing" as const, checkedAt: "2026-09-05T00:00:00.000Z" } }],
};

describe("运行预检控制器", () => {
  it("仅以认证账户查询 discovery/manual，缺 targetId 时交给领域层解析主目标并禁止缓存", async () => {
    const calls: unknown[] = [];
    const controller = new RunPreflightController({ get: async (input) => { calls.push(input); return report; } });
    const reply = { header: (name: string, value: string) => calls.push([name, value]) };

    await expect(controller.get({ authenticatedAccount: { userId: "owner-id" } } as never, reply as never, { workflow: "discovery", trigger: "manual" })).resolves.toEqual(report);

    expect(calls).toEqual([["Cache-Control", "no-store"], { userId: "owner-id", workflow: "discovery", trigger: "manual", targetId: undefined }]);
  });

  it("拒绝浏览器伪造的 scheduledFor 或未知 query，而不调用查询", async () => {
    const get = async () => report;
    const controller = new RunPreflightController({ get });
    await expect(controller.get({ authenticatedAccount: { userId: "owner-id" } } as never, { header() {} } as never, { workflow: "discovery", trigger: "manual", scheduledFor: "2026-09-05T00:00:00.000Z" } as never)).rejects.toThrow(/Unrecognized key/u);
  });

  it("保留可公开的预检报告，不暴露原始异常", () => {
    const rejection = new RunPreflightRejectedError("RUN_PREFLIGHT_BLOCKED", report);
    expect(runPreflightConflict(rejection)).toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED", status: 409, details: { preflight: report } });
  });
});
