import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { RunPreflightReport } from "@job-copilot/contracts/run-preflight";
import { RunPreflightPanel } from "./run-preflight-panel";

const checkedAt = "2026-09-05T00:00:00.000Z";
const fingerprint = "a".repeat(64);

function report(status: RunPreflightReport["status"]): RunPreflightReport {
  const severity = status === "blocked" ? "blocking" : status === "ready_with_warnings" ? "warning" : "informational";
  return {
    version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3", status,
    warningFingerprint: status === "ready_with_warnings" ? fingerprint : null, checkedAt,
    items: [{ code: status === "blocked" ? "PROFILE_EVIDENCE_MISSING" : status === "ready_with_warnings" ? "SOURCE_HEALTH_UNCHECKED" : "MODEL_DIAGNOSTIC_READY", severity,
      summary: "这是安全的检查摘要", evidence: status === "ready_with_warnings" ? { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null } : status === "blocked" ? { kind: "profile", activeTrustedFactCount: 0, latestFactRevisionId: null, checkedAt } : { kind: "model_diagnostic", status: "available", checkedAt },
      impact: "这项检查会影响本次岗位发现", retryable: status !== "ready", suggestedActions: status === "blocked" ? ["review_profile"] : status === "ready_with_warnings" ? ["review_source_health"] : [], }],
  };
}

it.each(["blocked", "ready_with_warnings", "ready"] as const)("以文字、证据和固定修复链接呈现 %s 状态", (status) => {
  render(<RunPreflightPanel report={report(status)} unavailable={false} />);

  expect(screen.getByRole("status")).toHaveTextContent(status === "blocked" ? "暂不能启动" : status === "ready_with_warnings" ? "启动前需要你确认" : "可以启动");
  expect(screen.getByText(status === "blocked" ? "阻塞项" : status === "ready_with_warnings" ? "需要确认" : "信息")).toBeVisible();
  expect(screen.getByText("这是安全的检查摘要")).toBeVisible();
  expect(screen.getByText(/这项检查会影响本次岗位发现/u)).toBeVisible();
  if (status === "blocked") expect(screen.getByRole("link", { name: "完善求职画像" })).toHaveAttribute("href", "/profile");
  if (status === "ready_with_warnings") expect(screen.getByRole("link", { name: "查看来源健康" })).toHaveAttribute("href", "/profile/targets/4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3/watchlist#source-health");
});

it("没有目标时将来源修复降级到求职目标页，并在局部失败时保持明确说明", () => {
  const value = report("ready_with_warnings");
  render(<RunPreflightPanel report={{ ...value, targetId: null }} unavailable />);
  expect(screen.getByRole("status")).toHaveTextContent("正在刷新启动条件，仍显示上次成功结果");
  expect(screen.getByRole("link", { name: "查看来源健康" })).toHaveAttribute("href", "/profile/targets");
});
