import { randomUUID } from "node:crypto";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { RunPreflightReportSchema, type RunPreflightReport } from "@job-copilot/contracts/run-preflight";
import { resolveEffectiveAccountRunPolicy } from "../account-run-policies";
import type { RunPreflightEvaluator, RunPreflightInput } from "../run-preflight";

/** 仅供未覆盖 #51 规则的旧领域夹具显式注入；生产装配不得使用。 */
export function createReadyRunPreflightEvaluator(input: { clock?: () => Date } = {}): RunPreflightEvaluator {
  const clock = input.clock ?? (() => new Date());
  return {
    async evaluate(db, request: RunPreflightInput) {
      const checkedAt = clock().toISOString();
      const targetId = request.targetId ?? randomUUID();
      const report: RunPreflightReport = RunPreflightReportSchema.parse({
        version: "run-preflight-v1", workflow: request.workflow, trigger: request.trigger, targetId, status: "ready", warningFingerprint: null, checkedAt,
        items: [
          { code: "PROFILE_EVIDENCE_READY", severity: "informational", summary: "画像事实已就绪", impact: "当前画像事实可用于本次运行。", retryable: false, suggestedActions: [], evidence: { kind: "profile", activeTrustedFactCount: 1, latestFactRevisionId: randomUUID(), checkedAt } },
          { code: "PRIMARY_JOB_TARGET_READY", severity: "informational", summary: "主目标已就绪", impact: "当前活动主目标可用于本次运行。", retryable: false, suggestedActions: [], evidence: { kind: "job_target", primaryTargetId: targetId, primaryTargetVersion: 1, requestedTargetId: targetId, requestedTargetVersion: 1, requestedTargetState: "active", checkedAt } },
          { code: "REQUESTED_JOB_TARGET_READY", severity: "informational", summary: "请求目标已就绪", impact: "请求的活动目标可用于本次运行。", retryable: false, suggestedActions: [], evidence: { kind: "job_target", primaryTargetId: targetId, primaryTargetVersion: 1, requestedTargetId: targetId, requestedTargetVersion: 1, requestedTargetState: "active", checkedAt } },
          { code: request.workflow === "deep_match" ? "SOURCE_CAPABILITY_NOT_REQUIRED" : "SOURCE_CAPABILITY_READY", severity: "informational", summary: request.workflow === "deep_match" ? "来源能力无需检查" : "来源能力已就绪", impact: "当前运行可以安全继续。", retryable: false, suggestedActions: [], evidence: { kind: "source_capability", enabledSourceCount: 1, capableSourceCount: 1, status: request.workflow === "deep_match" ? "not_required" : "ready", checkedAt } },
          { code: request.workflow === "deep_match" ? "SOURCE_HEALTH_NOT_REQUIRED" : "SOURCE_HEALTH_READY", severity: "informational", summary: request.workflow === "deep_match" ? "来源健康无需检查" : "来源健康已就绪", impact: "当前运行可以安全继续。", retryable: false, suggestedActions: [], evidence: { kind: "source_health", checkedSourceCount: 1, healthySourceCount: 1, degradedSourceCount: 0, uncheckedSourceCount: 0, latestCheckedAt: checkedAt } },
          { code: "MODEL_DIAGNOSTIC_READY", severity: "informational", summary: "模型诊断已就绪", impact: "当前模型诊断显示可安全使用。", retryable: false, suggestedActions: [], evidence: { kind: "model_diagnostic", status: "available", checkedAt } },
          { code: "ACCOUNT_RUN_POLICY_READY", severity: "informational", summary: "账户运行策略已就绪", impact: "当前预算和时间窗口允许本次运行。", retryable: false, suggestedActions: [], evidence: { kind: "account_run_policy", revisionNumber: 0, status: "ready", checkedAt } },
        ],
      });
      const policy = await resolveEffectiveAccountRunPolicy(db, request.userId, { id: () => randomUUID(), clock });
      return { report, policy: { revisionNumber: policy.revisionNumber, snapshot: policy.effective } };
    },
  };
}
