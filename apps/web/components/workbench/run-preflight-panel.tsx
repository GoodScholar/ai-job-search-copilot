"use client";

import type { RunPreflightEvidence, RunPreflightReport, RunPreflightSuggestedAction } from "@job-copilot/contracts/run-preflight";
import Link from "next/link";

export type RunPreflightPanelProps = { report: RunPreflightReport | null; unavailable: boolean };

const actionLabels: Record<RunPreflightSuggestedAction, string> = {
  review_profile: "完善求职画像", review_job_targets: "查看求职目标", review_source_capabilities: "查看来源能力", review_source_health: "查看来源健康", run_model_diagnostic: "检查模型连接", review_account_run_policy: "管理运行策略",
};

const severityLabels = {
  blocking: "阻塞项",
  warning: "需要确认",
  informational: "信息",
} as const;

const modelDiagnosticStatusLabels = {
  unverified: "尚未验证",
  checking: "正在检查",
  available: "可用",
  failed: "检查未通过",
  temporarily_unavailable: "暂时不可用",
} as const;

function hrefFor(action: RunPreflightSuggestedAction, targetId: string | null): string {
  if (action === "review_profile") return "/profile";
  if (action === "review_job_targets") return "/profile/targets";
  if (action === "run_model_diagnostic") return "/profile/model-connection";
  if (action === "review_account_run_policy") return "/profile/run-policy";
  if (!targetId) return "/profile/targets";
  return `/profile/targets/${targetId}/watchlist#${action === "review_source_capabilities" ? "source-capabilities" : "source-health"}`;
}

function evidenceText(evidence: RunPreflightEvidence): string {
  if (evidence.kind === "profile") return `当前有效证据 ${evidence.activeTrustedFactCount} 条`;
  if (evidence.kind === "job_target") return evidence.requestedTargetState === "active" ? "所选求职目标有效" : "所选求职目标不可用";
  if (evidence.kind === "source_capability") return `可用来源 ${evidence.capableSourceCount} / ${evidence.enabledSourceCount}`;
  if (evidence.kind === "source_health") return `已检查 ${evidence.checkedSourceCount} 个来源，待检查 ${evidence.uncheckedSourceCount} 个`;
  if (evidence.kind === "model_diagnostic") return `模型连接状态：${modelDiagnosticStatusLabels[evidence.status]}`;
  return `账户策略版本 ${evidence.revisionNumber}`;
}

export function RunPreflightPanel({ report, unavailable }: RunPreflightPanelProps) {
  if (!report) return <section aria-live="polite" aria-label="运行前检查" className="run-preflight-panel"><h3>运行前检查</h3><p role="status">{unavailable ? "检查暂时无法刷新，请稍后重试。" : "正在读取启动条件。"}</p></section>;
  const heading = report.status === "blocked" ? "暂不能启动" : report.status === "ready_with_warnings" ? "启动前需要你确认" : "可以启动";
  return <section aria-live="polite" aria-label="运行前检查" className={`run-preflight-panel run-preflight-${report.status}`}>
    <div className="run-preflight-heading"><h3>运行前检查</h3><p role="status">{unavailable ? "正在刷新启动条件，仍显示上次成功结果。" : heading}</p></div>
    <p>{report.status === "blocked" ? "请先处理阻塞项，再开始岗位发现。" : report.status === "ready_with_warnings" ? "你可以查看提示后明确确认继续。" : "当前启动条件已满足。"}</p>
    <ol>{report.items.map((item) => <li key={`${item.code}:${item.severity}`} data-severity={item.severity}><p>{severityLabels[item.severity]}</p><h4>{item.summary}</h4><p>{evidenceText(item.evidence)}</p><p>影响：{item.impact}</p><p>{item.retryable ? "可在修复后重试。" : "当前不建议直接重试。"}</p>{item.suggestedActions.length ? <p className="run-preflight-actions">{item.suggestedActions.map((action) => <Link className="workbench-touch-target" href={hrefFor(action, report.targetId)} key={action}>{actionLabels[action]}</Link>)}</p> : null}</li>)}</ol>
  </section>;
}
