import type { JobSourceHealthCheck } from "@job-copilot/contracts/agent-runs";

export type SourceHealthTerminal = "completed" | "completed_with_source_issues" | "source_failed";

/** 从受控来源检查的已验证进展与问题状态推导唯一终态。 */
export function deriveSourceHealthTerminal(checks: readonly Pick<JobSourceHealthCheck, "status" | "validDetailCount">[]): SourceHealthTerminal {
  const hasCompletedSourceOrRetainedProgress = checks.some((check) => check.status === "healthy" || check.status === "zero_valid_results" || check.validDetailCount > 0);
  if (!hasCompletedSourceOrRetainedProgress) return "source_failed";
  return checks.some((check) => check.status === "parser_degraded" || check.status === "rate_limited" || check.status === "hard_failed")
    ? "completed_with_source_issues"
    : "completed";
}
