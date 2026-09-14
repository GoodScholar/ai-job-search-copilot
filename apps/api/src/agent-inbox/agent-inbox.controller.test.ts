import { describe, expect, it } from "vitest";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import { AgentRunError } from "@job-copilot/domain/agent-runs";
import { AccountRunAdmissionError } from "@job-copilot/domain/account-run-control";
import { AgentInboxController } from "./agent-inbox.controller.js";

const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const itemId = "5f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const actionId = "6f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const report = {
  version: "run-preflight-v1" as const, workflow: "discovery" as const, trigger: "manual" as const, targetId,
  status: "blocked" as const, warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z",
  items: [{ code: "PRIMARY_JOB_TARGET_MISSING" as const, severity: "blocking" as const, summary: "缺少主求职目标", impact: "请先创建主求职目标。", retryable: false, suggestedActions: ["review_job_targets" as const], evidence: { kind: "job_target" as const, primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing" as const, checkedAt: "2026-09-05T00:00:00.000Z" } }],
};

describe("Agent Inbox 控制器", () => {
  it("将 restart 的预检拒绝转换为含安全报告的 409", async () => {
    const controller = new AgentInboxController({ act: async () => { throw new RunPreflightRejectedError("RUN_PREFLIGHT_BLOCKED", report); } } as never);

    await expect(controller.act(
      { authenticatedAccount: { userId: "owner-id" } } as never,
      { itemId } as never,
      { actionId, action: "restart_run" } as never,
    )).rejects.toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED", status: 409, details: { preflight: report } });
  });

  it("将账户停止转换为稳定 409 白名单文案", async () => {
    const controller = new AgentInboxController({ act: async () => { throw new AgentRunError("ACCOUNT_RUN_STOPPED"); } } as never);

    await expect(controller.act(
      { authenticatedAccount: { userId: "owner-id" } } as never,
      { itemId } as never,
      { actionId, action: "restart_run" } as never,
    )).rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED", status: 409, publicMessage: "账户已停止全部运行，请先恢复后重试" });
  });

  it("将 legacy resume 的账户停止转换为稳定 409 白名单文案", async () => {
    const controller = new AgentInboxController({ act: async () => { throw new AccountRunAdmissionError("ACCOUNT_RUN_STOPPED"); } } as never);

    await expect(controller.act(
      { authenticatedAccount: { userId: "owner-id" } } as never,
      { itemId } as never,
      { actionId, action: "resume_run" } as never,
    )).rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED", status: 409, publicMessage: "账户已停止全部运行，请先恢复后重试" });
  });
});
