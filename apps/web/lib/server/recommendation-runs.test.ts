import { afterEach, expect, it, vi } from "vitest";
import { RecommendationRunSchema } from "@job-copilot/contracts/recommendation-runs";

const mocks = vi.hoisted(() => ({
  getRecommendationRunPreparation: vi.fn(), getLatestRecommendationRun: vi.fn(), getLatestPublishedRecommendationRun: vi.fn(), getRecommendationRun: vi.fn(), readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));
vi.mock("@/lib/server/api-client", () => ({ api: mocks }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getLatestPublishedRecommendationRun, getLatestRecommendationRun, getRecommendationRun, getRecommendationRunPreparation } from "./recommendation-runs";

afterEach(() => vi.clearAllMocks());

const publishedRun = RecommendationRunSchema.parse({ runId: "00000000-0000-4000-8000-000000000001", status: "completed", currentStage: null, stages: ["discovery", "qualification", "coarse_ranking", "deep_matching", "result_publication"].map((key) => ({ key, status: "completed", startedAt: "2026-09-14T00:00:00.000Z", completedAt: "2026-09-14T00:00:00.000Z" })), target: { targetId: "00000000-0000-4000-8000-000000000002", targetVersion: 1, roleFamily: "前端工程师" }, sourceScope: { trustedSourceCount: 1, publicQueryCount: 0 }, accountPolicyRevisionNumber: 1, budgets: { discovery: { maxActiveDurationMs: 1, maxAttempts: 1, maxToolCalls: 1, maxResults: 1, maxModelCalls: 0, maxTokens: 0 }, deepMatch: { maxActiveDurationMs: 1, maxAttempts: 1, maxToolCalls: 1, maxResults: 1, maxModelCalls: 0, maxTokens: 0 } }, preflightSnapshot: { version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId: "00000000-0000-4000-8000-000000000002", status: "ready", warningFingerprint: null, checkedAt: "2026-09-14T00:00:00.000Z", items: [{ code: "ACCOUNT_RUN_POLICY_READY", severity: "informational", summary: "账户运行可用", impact: "可以开始完整推荐", retryable: false, suggestedActions: [], evidence: { kind: "account_run_policy", revisionNumber: 1, status: "ready", checkedAt: "2026-09-14T00:00:00.000Z" } }] }, result: { kind: "no_recommendations", resultId: "00000000-0000-4000-8000-000000000003", publishedAt: "2026-09-14T00:00:00.000Z", evidence: { discovery: { discoveredJobCount: 0 }, sourceCoverage: { plannedTrustedSourceCount: 1, plannedPublicQueryCount: 0, checkedBranchCount: 1, credibleBranchCount: 1, verifiedJobCount: 0 }, coverageLosses: [], qualification: { evaluatedCount: 0, rejectedCount: 0, insufficientInformationCount: 0, expiredCount: 0 }, coarseRanking: { eligibleCount: 0, belowThresholdCount: 0, ruleExcludedCount: 0, candidateLimitExcludedCount: 0, deepMatchCandidateCount: 0 }, deepMatching: { evaluatedCount: 0, qualityInsufficientCount: 0, finalRecommendationCount: 0 }, suggestedActions: [] } }, failure: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" });

it("已登录时只读取最新已发布运行，并保留完整结果或空值", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getLatestPublishedRecommendationRun.mockResolvedValueOnce(publishedRun).mockResolvedValueOnce(null);
  await expect(getLatestPublishedRecommendationRun()).resolves.toEqual(publishedRun);
  await expect(getLatestPublishedRecommendationRun()).resolves.toBeNull();
  expect(mocks.getLatestPublishedRecommendationRun).toHaveBeenCalledTimes(2);
  expect(mocks.getLatestRecommendationRun).not.toHaveBeenCalled();
});

it("最新已发布读取在未登录或上游 401 时重定向，其他错误继续透传", async () => {
  mocks.readSessionToken.mockResolvedValueOnce(null).mockResolvedValue("a".repeat(43)).mockResolvedValue("a".repeat(43));
  await expect(getLatestPublishedRecommendationRun()).rejects.toThrow("redirect:/login?returnTo=%2F");
  mocks.getLatestPublishedRecommendationRun.mockRejectedValueOnce({ status: 401 }).mockRejectedValueOnce({ status: 502 });
  await expect(getLatestPublishedRecommendationRun()).rejects.toThrow("redirect:/login?returnTo=%2F");
  await expect(getLatestPublishedRecommendationRun()).rejects.toEqual({ status: 502 });
});

it("未登录时重定向，登录后读取推荐准备和最近运行", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(getRecommendationRunPreparation()).rejects.toThrow("redirect:/login?returnTo=%2F");
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getRecommendationRunPreparation.mockResolvedValue({ target: null });
  mocks.getLatestRecommendationRun.mockResolvedValue(null);
  await expect(getRecommendationRunPreparation()).resolves.toEqual({ target: null });
  await expect(getLatestRecommendationRun()).resolves.toBeNull();
});

it("owner-hidden 的逻辑运行只在 404 时投影为空，其他错误继续透传", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getRecommendationRun.mockRejectedValueOnce({ status: 404 }).mockRejectedValueOnce({ status: 502 });
  await expect(getRecommendationRun("4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3")).resolves.toBeNull();
  await expect(getRecommendationRun("4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3")).rejects.toEqual({ status: 502 });
});

it.each([
  ["准备", getRecommendationRunPreparation, "getRecommendationRunPreparation"],
  ["最近运行", getLatestRecommendationRun, "getLatestRecommendationRun"],
  ["指定运行", () => getRecommendationRun("4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3"), "getRecommendationRun"],
] as const)("缺少 session 时%s重定向且不调用 API", async (_label, read, apiMethod) => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(read()).rejects.toThrow("redirect:/login?returnTo=%2F");
  expect(mocks[apiMethod]).not.toHaveBeenCalled();
});

it.each([
  ["准备", getRecommendationRunPreparation, "getRecommendationRunPreparation"],
  ["最近运行", getLatestRecommendationRun, "getLatestRecommendationRun"],
  ["指定运行", () => getRecommendationRun("4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3"), "getRecommendationRun"],
] as const)("上游 401 时%s重定向", async (_label, read, apiMethod) => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks[apiMethod].mockRejectedValue({ status: 401 });
  await expect(read()).rejects.toThrow("redirect:/login?returnTo=%2F");
});
