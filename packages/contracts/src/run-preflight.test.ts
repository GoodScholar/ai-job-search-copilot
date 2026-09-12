import { describe, expect, it } from "vitest";
import {
  RunPreflightCheckCodeSchema,
  RunPreflightEvidenceSchema,
  RunPreflightItemSchema,
  RunPreflightProblemSchema,
  RunPreflightReportSchema,
  RunPreflightSeveritySchema,
  RunPreflightSuggestedActionSchema,
  RunPreflightStatusSchema,
  RunPreflightWorkflowSchema,
} from "./run-preflight";

const targetId = "87a0d3ac-4aed-4bd5-a703-68bf82cc6c49";
const factRevisionId = "1e764df5-19f3-49f3-b16e-512147298baa";
const checkedAt = "2026-09-05T00:00:00.000Z";
const warningFingerprint = "a".repeat(64);

const evidenceByKind = {
  profile: { kind: "profile", activeTrustedFactCount: 1, latestFactRevisionId: factRevisionId, checkedAt },
  job_target: { kind: "job_target", primaryTargetId: targetId, primaryTargetVersion: 2, requestedTargetId: targetId, requestedTargetVersion: 2, requestedTargetState: "active", checkedAt },
  source_capability: { kind: "source_capability", enabledSourceCount: 2, capableSourceCount: 1, status: "partial", checkedAt },
  source_health: { kind: "source_health", checkedSourceCount: 1, healthySourceCount: 1, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: checkedAt },
  model_diagnostic: { kind: "model_diagnostic", status: "available", checkedAt },
  account_run_policy: { kind: "account_run_policy", revisionNumber: 1, status: "ready", checkedAt },
} as const;

const informationalItem = {
  code: "PROFILE_EVIDENCE_READY",
  severity: "informational",
  summary: "当前画像证据已就绪",
  evidence: evidenceByKind.profile,
  impact: "可以继续执行运行前检查。",
  retryable: false,
  suggestedActions: [],
} as const;
const warningItem = {
  code: "SOURCE_HEALTH_UNCHECKED",
  severity: "warning",
  summary: "部分来源尚未完成健康检查",
  evidence: evidenceByKind.source_health,
  impact: "本次运行可能遇到来源质量波动。",
  retryable: true,
  suggestedActions: ["review_source_health"],
} as const;
const blockingItem = {
  code: "MODEL_DIAGNOSTIC_UNAVAILABLE",
  severity: "blocking",
  summary: "模型连接诊断当前不可用",
  evidence: evidenceByKind.model_diagnostic,
  impact: "无法安全启动需要模型的运行。",
  retryable: true,
  suggestedActions: ["run_model_diagnostic"],
} as const;
const readyReport = {
  version: "run-preflight-v1",
  workflow: "discovery",
  trigger: "manual",
  targetId,
  status: "ready",
  items: [informationalItem],
  warningFingerprint: null,
  checkedAt,
} as const;

describe("运行前检查契约", () => {
  it("将逻辑推荐运行作为独立的运行前检查工作流", () => {
    expect(RunPreflightWorkflowSchema.options).toEqual(["discovery", "deep_match", "recommendation"]);
    expect(RunPreflightReportSchema.parse({ ...readyReport, workflow: "recommendation" }).workflow).toBe("recommendation");
  });

  it("接受三种严重级和三种聚合状态", () => {
    expect(RunPreflightSeveritySchema.options).toEqual(["blocking", "warning", "informational"]);
    expect(RunPreflightStatusSchema.options).toEqual(["blocked", "ready_with_warnings", "ready"]);
    expect(RunPreflightReportSchema.parse({ ...readyReport, status: "blocked", items: [blockingItem] }).status).toBe("blocked");
    expect(RunPreflightReportSchema.parse({ ...readyReport, status: "ready_with_warnings", items: [warningItem], warningFingerprint }).status).toBe("ready_with_warnings");
    expect(RunPreflightReportSchema.parse(readyReport).status).toBe("ready");
  });

  it("以严格判别 union 承载六类安全依据", () => {
    for (const evidence of Object.values(evidenceByKind)) {
      expect(RunPreflightEvidenceSchema.parse(evidence)).toEqual(evidence);
    }
    expect(RunPreflightEvidenceSchema.safeParse({ ...evidenceByKind.profile, factValue: "不得泄露" }).success).toBe(false);
  });

  it("只接受固定检查代码和修复动作", () => {
    expect(RunPreflightCheckCodeSchema.options).toEqual([
      "PROFILE_EVIDENCE_MISSING", "PROFILE_EVIDENCE_READY",
      "PRIMARY_JOB_TARGET_MISSING", "PRIMARY_JOB_TARGET_READY",
      "REQUESTED_JOB_TARGET_MISSING", "REQUESTED_JOB_TARGET_INACTIVE", "REQUESTED_JOB_TARGET_READY",
      "SOURCE_CAPABILITY_UNAVAILABLE", "SOURCE_CAPABILITY_PARTIAL", "SOURCE_CAPABILITY_READY", "SOURCE_CAPABILITY_NOT_REQUIRED",
      "SOURCE_HEALTH_UNCHECKED", "SOURCE_HEALTH_DEGRADED", "SOURCE_HEALTH_READY", "SOURCE_HEALTH_NOT_REQUIRED",
      "MODEL_DIAGNOSTIC_UNAVAILABLE", "MODEL_DIAGNOSTIC_READY",
      "ACCOUNT_RUN_POLICY_BLOCKED", "ACCOUNT_RUN_POLICY_READY",
    ]);
    expect(RunPreflightSuggestedActionSchema.options).toEqual([
      "review_profile", "review_job_targets", "review_source_capabilities", "review_source_health", "run_model_diagnostic", "review_account_run_policy",
    ]);
  });

  it("拒绝不安全文案、非法 fingerprint、重复动作和未知键", () => {
    expect(RunPreflightItemSchema.safeParse({ ...informationalItem, summary: "x".repeat(201) }).success).toBe(false);
    expect(RunPreflightItemSchema.safeParse({ ...informationalItem, impact: "x".repeat(501) }).success).toBe(false);
    expect(RunPreflightItemSchema.safeParse({ ...informationalItem, summary: "profile ready" }).success).toBe(false);
    expect(RunPreflightItemSchema.safeParse({ ...warningItem, suggestedActions: ["review_source_health", "review_source_health"] }).success).toBe(false);
    expect(RunPreflightItemSchema.safeParse({ ...informationalItem, extra: true }).success).toBe(false);
    expect(RunPreflightReportSchema.safeParse({ ...readyReport, warningFingerprint: "A".repeat(64) }).success).toBe(false);
    expect(RunPreflightReportSchema.safeParse({ ...readyReport, warningFingerprint: "a".repeat(63) }).success).toBe(false);
  });

  it("强制聚合状态与警告 fingerprint 的不变量，并只序列化安全依据", () => {
    expect(() => RunPreflightReportSchema.parse({
      ...readyReport,
      status: "ready",
      items: [warningItem],
      warningFingerprint: null,
    })).toThrow();
    expect(RunPreflightReportSchema.safeParse({ ...readyReport, status: "blocked", items: [informationalItem] }).success).toBe(false);
    expect(RunPreflightReportSchema.safeParse({ ...readyReport, status: "ready_with_warnings", items: [warningItem], warningFingerprint: null }).success).toBe(false);
    expect(RunPreflightReportSchema.safeParse({ ...readyReport, warningFingerprint }).success).toBe(false);

    const safeReport = {
      ...readyReport,
      items: [
        informationalItem,
        { ...informationalItem, code: "PRIMARY_JOB_TARGET_READY", evidence: evidenceByKind.job_target },
        { ...informationalItem, code: "SOURCE_CAPABILITY_READY", evidence: evidenceByKind.source_capability },
        { ...informationalItem, code: "SOURCE_HEALTH_READY", evidence: evidenceByKind.source_health },
        { ...informationalItem, code: "MODEL_DIAGNOSTIC_READY", evidence: evidenceByKind.model_diagnostic },
        { ...informationalItem, code: "ACCOUNT_RUN_POLICY_READY", evidence: evidenceByKind.account_run_policy },
      ],
    };
    expect(JSON.stringify(RunPreflightReportSchema.parse(safeReport))).not.toMatch(
      /factValue|careerText|jobText|careersUrl|allowedDomain|configurationFingerprint|apiKey|providerResponse|modelOutput/u,
    );
  });

  it("将阻塞和警告确认问题绑定到同一严格报告", () => {
    expect(RunPreflightProblemSchema.parse({
      code: "RUN_PREFLIGHT_BLOCKED", message: "请先修复阻塞项", preflight: { ...readyReport, status: "blocked", items: [blockingItem] },
    }).code).toBe("RUN_PREFLIGHT_BLOCKED");
    expect(RunPreflightProblemSchema.safeParse({
      code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", message: "请确认警告", preflight: { ...readyReport, extra: true },
    }).success).toBe(false);
  });
});
