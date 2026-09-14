import type { RecommendationResult } from "@job-copilot/contracts/recommendation-runs";
import Link from "next/link";

const actionLinks = {
  restart_discovery: { href: "/home", label: "重新开始今日发现" },
  review_source_health: { href: "/profile/targets", label: "查看来源状态" },
  review_profile: { href: "/profile", label: "完善求职画像" },
  review_primary_target: { href: "/profile/targets", label: "查看求职目标" },
} as const;

const coverageLossLabels = {
  TRUSTED_SOURCE_UNAVAILABLE: "可信来源暂不可用",
  PUBLIC_DISCOVERY_UNAVAILABLE: "公开发现暂不可用",
  SOURCE_HEALTH_DEGRADED: "来源健康度下降",
  SOURCE_CAPABILITY_UNAVAILABLE: "来源能力暂不可用",
  VERIFICATION_FAILED: "验证未通过",
  DISCOVERY_BUDGET_EXCEEDED: "发现预算已用尽",
} as const;

export function RecommendationResultSummary({ result }: { result: RecommendationResult }) {
  const { evidence } = result;
  return <section aria-labelledby="recommendation-result-title" className="recommendation-result-summary" id="recommendation-result">
    <h2 id="recommendation-result-title">{result.kind === "no_recommendations" ? "今天暂无推荐" : "本次推荐已准备好"}</h2>
    {result.kind === "recommendation_list" ? <p>已整理 {result.itemCount} 个值得优先查看的岗位。</p> : null}
    {result.kind === "recommendation_list" ? <Link className="workbench-touch-target" href="#recommendation-list">查看推荐岗位</Link> : null}
    {result.kind === "no_recommendations" && evidence.suggestedActions.length > 0 ? <nav aria-label="下一步建议" className="recommendation-result-actions">{evidence.suggestedActions.map((action) => <Link className="workbench-touch-target" href={actionLinks[action].href} key={action}>{actionLinks[action].label}</Link>)}</nav> : null}
    <section aria-label="本次覆盖证据" className="recommendation-result-evidence">
      <p>来源覆盖：计划可信来源 {evidence.sourceCoverage.plannedTrustedSourceCount} 个、公开查询 {evidence.sourceCoverage.plannedPublicQueryCount} 个；已检查 {evidence.sourceCoverage.checkedBranchCount} 项，可信 {evidence.sourceCoverage.credibleBranchCount} 项；已验证并发现岗位 {evidence.sourceCoverage.verifiedJobCount} 个。</p>
      <p>资格筛选：评估 {evidence.qualification.evaluatedCount} 个，淘汰 {evidence.qualification.rejectedCount} 个，信息不足 {evidence.qualification.insufficientInformationCount} 个，已过期 {evidence.qualification.expiredCount} 个。</p>
      <p>初步排序：合格 {evidence.coarseRanking.eligibleCount} 个，低于阈值 {evidence.coarseRanking.belowThresholdCount} 个，规则排除 {evidence.coarseRanking.ruleExcludedCount} 个，候选上限外 {evidence.coarseRanking.candidateLimitExcludedCount} 个，进入深度匹配 {evidence.coarseRanking.deepMatchCandidateCount} 个。</p>
      <p>深度匹配：评估 {evidence.deepMatching.evaluatedCount} 个，质量不足 {evidence.deepMatching.qualityInsufficientCount} 个，最终推荐 {evidence.deepMatching.finalRecommendationCount} 个。</p>
    </section>
    <section aria-labelledby="recommendation-coverage-title" className="recommendation-result-coverage">
      <h3 id="recommendation-coverage-title">覆盖情况</h3>
      {evidence.coverageLosses.length === 0 ? <p>本次没有覆盖损失。</p> : <ul>{evidence.coverageLosses.map((loss) => <li key={`${loss.code}:${loss.affectedCount}`}>{coverageLossLabels[loss.code]}：影响 {loss.affectedCount} 项来源检查{loss.retryable ? "，可稍后重试" : "，当前不可重试"}</li>)}</ul>}
    </section>
  </section>;
}
