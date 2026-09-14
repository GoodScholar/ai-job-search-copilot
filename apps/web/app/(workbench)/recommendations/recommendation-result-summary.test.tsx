import { render, screen } from "@testing-library/react";
import { RecommendationResultSchema } from "@job-copilot/contracts/recommendation-runs";
import { RecommendationResultSummary } from "./recommendation-result-summary";

const noRecommendationsResult = RecommendationResultSchema.parse({
  kind: "no_recommendations",
  resultId: "10000000-0000-4000-8000-000000000001",
  publishedAt: "2026-09-14T00:00:00.000Z",
  evidence: {
    discovery: { discoveredJobCount: 3 },
    sourceCoverage: { plannedTrustedSourceCount: 2, plannedPublicQueryCount: 1, checkedBranchCount: 3, credibleBranchCount: 2, verifiedJobCount: 3 },
    coverageLosses: [{ code: "TRUSTED_SOURCE_UNAVAILABLE", affectedCount: 1, retryable: true }, { code: "VERIFICATION_FAILED", affectedCount: 1, retryable: false }],
    qualification: { evaluatedCount: 3, rejectedCount: 1, insufficientInformationCount: 1, expiredCount: 0 },
    coarseRanking: { eligibleCount: 1, belowThresholdCount: 1, ruleExcludedCount: 0, candidateLimitExcludedCount: 0, deepMatchCandidateCount: 0 },
    deepMatching: { evaluatedCount: 0, qualityInsufficientCount: 0, finalRecommendationCount: 0 },
    suggestedActions: ["review_source_health", "review_profile"],
  },
});

describe("RecommendationResultSummary", () => {
  it("以闭合证据解释可信空结果，而不渲染伪造的空推荐列表", () => {
    render(<RecommendationResultSummary result={noRecommendationsResult} />);

    expect(screen.getByRole("heading", { name: "今天暂无推荐" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "推荐岗位" })).not.toBeInTheDocument();
    expect(screen.getByText("已检查 3 个来源")).toBeVisible();
    expect(screen.getByText("资格筛选：淘汰 1 个，信息不足 1 个，已过期 0 个")).toBeVisible();
    expect(screen.getByText("初步排序：低于阈值 1 个，规则排除 0 个，超出范围 0 个")).toBeVisible();
    expect(screen.getByText("深度匹配：评估 0 个，质量不足 0 个")).toBeVisible();
  });

  it("只投影有界覆盖损失和服务端建议，不泄露原始技术内容", () => {
    render(<RecommendationResultSummary result={noRecommendationsResult} />);

    expect(screen.getByText("覆盖情况")).toBeVisible();
    expect(screen.getByText("可信来源暂不可用：影响 1 项来源检查，可稍后重试")).toBeVisible();
    expect(screen.getByText("验证未通过：影响 1 项来源检查，当前不可重试")).toBeVisible();
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByText(/Bearer|gateway|模型响应/u)).not.toBeInTheDocument();
  });

  it("两种结果都呈现同一组冻结的来源、筛选、粗排与深匹配闭合统计", () => {
    const listResult = RecommendationResultSchema.parse({
      ...noRecommendationsResult, kind: "recommendation_list", recommendationListId: "10000000-0000-4000-8000-000000000001", itemCount: 1,
      evidence: { ...noRecommendationsResult.evidence, discovery: { discoveredJobCount: 1 }, sourceCoverage: { ...noRecommendationsResult.evidence.sourceCoverage, verifiedJobCount: 1 }, qualification: { evaluatedCount: 1, rejectedCount: 0, insufficientInformationCount: 0, expiredCount: 0 }, coarseRanking: { eligibleCount: 1, belowThresholdCount: 0, ruleExcludedCount: 0, candidateLimitExcludedCount: 0, deepMatchCandidateCount: 1 }, deepMatching: { evaluatedCount: 1, qualityInsufficientCount: 0, finalRecommendationCount: 1 } },
    });
    const { rerender } = render(<RecommendationResultSummary result={noRecommendationsResult} />);
    expect(screen.getByLabelText("本次覆盖证据")).toHaveTextContent("计划可信来源 2 个、公开查询 1 个");
    rerender(<RecommendationResultSummary result={listResult} />);
    expect(screen.getByText("本次推荐已准备好")).toBeVisible();
    expect(screen.getByLabelText("本次覆盖证据")).toHaveTextContent("最终推荐 1 个");
  });

  it("穷举来源检查损失与服务端建议的有限投影", () => {
    const losses = ["TRUSTED_SOURCE_UNAVAILABLE", "PUBLIC_DISCOVERY_UNAVAILABLE", "SOURCE_HEALTH_DEGRADED", "SOURCE_CAPABILITY_UNAVAILABLE", "VERIFICATION_FAILED", "DISCOVERY_BUDGET_EXCEEDED"] as const;
    const result = RecommendationResultSchema.parse({ ...noRecommendationsResult, evidence: { ...noRecommendationsResult.evidence, coverageLosses: losses.map((code, index) => ({ code, affectedCount: index + 1, retryable: index % 2 === 0 })), suggestedActions: ["restart_discovery", "review_primary_target"] } });
    render(<RecommendationResultSummary result={result} />);
    expect(screen.getAllByText(/项来源检查/u)).toHaveLength(6);
    expect(screen.getByRole("link", { name: "重新开始今日发现" })).toHaveAttribute("href", "/home");
    expect(screen.getByRole("link", { name: "查看求职目标" })).toHaveAttribute("href", "/profile/targets");
    expect(screen.queryByText(/TRUSTED_SOURCE_UNAVAILABLE|VERIFICATION_FAILED/u)).not.toBeInTheDocument();
  });

  it.each([[[]], [["review_source_health"]], [["review_profile", "review_primary_target"]]] as const)("只显示服务端给出的 %s 组建议", (suggestedActions) => {
    const result = RecommendationResultSchema.parse({ ...noRecommendationsResult, evidence: { ...noRecommendationsResult.evidence, suggestedActions } });
    render(<RecommendationResultSummary result={result} />);
    expect(screen.queryAllByRole("link")).toHaveLength(suggestedActions.length);
  });
});
