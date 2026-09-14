import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import { RecommendationRunSchema } from "@job-copilot/contracts/recommendation-runs";
import { RecommendationListSchema } from "@job-copilot/contracts/recommendations";
const mocks = vi.hoisted(() => ({ getJobTargets: vi.fn(), getLatestRecommendations: vi.fn(), getRecommendationList: vi.fn(), getRecommendationHistoryPage: vi.fn(), getCalibrationProposals: vi.fn(), getLatestPublishedRecommendationRun: vi.fn(), getRecommendationRun: vi.fn(), requestRecommendationReevaluationAction: vi.fn(), recordRecommendationDecisionAction: vi.fn(), reviseCalibrationProposalAction: vi.fn(), rebaseCalibrationProposalAction: vi.fn(), resolveCalibrationProposalAction: vi.fn() }));
vi.mock("next/navigation", async () => ({ ...await vi.importActual<typeof import("next/navigation")>("next/navigation"), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: mocks.getJobTargets }));
vi.mock("@/lib/server/recommendations", () => ({ getLatestRecommendations: mocks.getLatestRecommendations, getRecommendationList: mocks.getRecommendationList, getRecommendationHistoryPage: mocks.getRecommendationHistoryPage, getCalibrationProposals: mocks.getCalibrationProposals }));
vi.mock("@/lib/server/recommendation-runs", () => ({ getLatestPublishedRecommendationRun: mocks.getLatestPublishedRecommendationRun, getRecommendationRun: mocks.getRecommendationRun }));
vi.mock("./actions", () => ({ requestRecommendationReevaluationAction: mocks.requestRecommendationReevaluationAction, recordRecommendationDecisionAction: mocks.recordRecommendationDecisionAction, reviseCalibrationProposalAction: mocks.reviseCalibrationProposalAction, rebaseCalibrationProposalAction: mocks.rebaseCalibrationProposalAction, resolveCalibrationProposalAction: mocks.resolveCalibrationProposalAction }));
import RecommendationsPage from "./page";

const targetA = "00000000-0000-4000-8000-000000000001", targetB = "00000000-0000-4000-8000-000000000002", listA = "00000000-0000-4000-8000-000000000003", listB = "00000000-0000-4000-8000-000000000004", runA = "00000000-0000-4000-8000-000000000005";
const budget = { maxActiveDurationMs: 1, maxAttempts: 1, maxToolCalls: 1, maxResults: 1, maxModelCalls: 0, maxTokens: 0 };
function list(id: string, targetId: string, title: string) { return RecommendationListSchema.parse({ recommendationListId: id, targetId, localDate: "2026-09-14", sequence: 1, createdAt: "2026-09-14T00:00:00.000Z", exclusions: [], items: [{ recommendationListItemId: "00000000-0000-4000-8000-000000000006", matchVersionId: "00000000-0000-4000-8000-000000000007", opportunityId: "00000000-0000-4000-8000-000000000008", company: "绑定公司", title, location: "上海", displayBand: "highly_matched", highlighted: true, ordinal: 1, jobEvidence: [{ id: "job", value: "岗位证据" }], profileEvidence: [{ id: "profile", value: "画像证据", kind: "profile_fact", profileFactRevisionId: "00000000-0000-4000-8000-000000000009" }], assessment: { opportunityId: "00000000-0000-4000-8000-000000000008", overallScore: 80, dimensions: ["skills", "experience", "project_depth", "career_direction", "location_logistics", "qualification_risk"].map((dimension) => ({ dimension, score: 80, judgment: "evidence_backed_inference", jobEvidenceIds: ["job"], profileEvidenceIds: ["profile"], summary: "证据支持的推断。" })) } }] }); }
function published(targetId = targetA, listId = listA) { return RecommendationRunSchema.parse({ runId: runA, status: "completed", currentStage: null, stages: ["discovery", "qualification", "coarse_ranking", "deep_matching", "result_publication"].map((key) => ({ key, status: "completed", startedAt: "2026-09-14T00:00:00.000Z", completedAt: "2026-09-14T00:00:00.000Z" })), target: { targetId, targetVersion: 1, roleFamily: "前端工程师" }, sourceScope: { trustedSourceCount: 1, publicQueryCount: 0 }, accountPolicyRevisionNumber: 1, budgets: { discovery: budget, deepMatch: budget }, preflightSnapshot: { version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId, status: "ready", warningFingerprint: null, checkedAt: "2026-09-14T00:00:00.000Z", items: [{ code: "ACCOUNT_RUN_POLICY_READY", severity: "informational", summary: "账户运行可用", impact: "可以开始完整推荐", retryable: false, suggestedActions: [], evidence: { kind: "account_run_policy", revisionNumber: 1, status: "ready", checkedAt: "2026-09-14T00:00:00.000Z" } }] }, result: { kind: "recommendation_list", resultId: listId, recommendationListId: listId, itemCount: 1, publishedAt: "2026-09-14T00:00:00.000Z", evidence: { discovery: { discoveredJobCount: 1 }, sourceCoverage: { plannedTrustedSourceCount: 1, plannedPublicQueryCount: 0, checkedBranchCount: 1, credibleBranchCount: 1, verifiedJobCount: 1 }, coverageLosses: [], qualification: { evaluatedCount: 1, rejectedCount: 0, insufficientInformationCount: 0, expiredCount: 0 }, coarseRanking: { eligibleCount: 1, belowThresholdCount: 0, ruleExcludedCount: 0, candidateLimitExcludedCount: 0, deepMatchCandidateCount: 1 }, deepMatching: { evaluatedCount: 1, qualityInsufficientCount: 0, finalRecommendationCount: 1 }, suggestedActions: [] } }, failure: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" }); }
function nonCompleted(status: "queued" | "running" | "paused" | "failed" | "cancelled") {
  const at = "2026-09-14T00:00:00.000Z", base = published(targetB, listA);
  const stage = status === "failed" ? "qualification" : "discovery";
  const stages = ["discovery", "qualification", "coarse_ranking", "deep_matching", "result_publication"].map((key) => {
    if (status === "queued") return { key, status: "pending", startedAt: null, completedAt: null };
    if (status === "cancelled") return key === "discovery" ? { key, status: "cancelled", startedAt: at, completedAt: at } : { key, status: "pending", startedAt: null, completedAt: null };
    if (status === "failed") return key === "discovery" ? { key, status: "completed", startedAt: at, completedAt: at } : key === stage ? { key, status: "failed", startedAt: at, completedAt: at } : { key, status: "pending", startedAt: null, completedAt: null };
    return key === "discovery" ? { key, status: "running", startedAt: at, completedAt: null } : { key, status: "pending", startedAt: null, completedAt: null };
  });
  return RecommendationRunSchema.parse({ ...base, status, currentStage: status === "queued" || status === "running" || status === "paused" ? "discovery" : status === "failed" ? stage : null, stages, result: null, failure: status === "failed" ? { code: "RECOMMENDATION_HANDOFF_FAILED", stage, summary: "资格门槛暂时无法完成", impact: "本次推荐尚未发布。", retryable: true, suggestedActions: ["restart_discovery"] } : null });
}
function noRecommendations(targetId = targetB) {
  const base = published(targetId, listA), evidence = { discovery: { discoveredJobCount: 0 }, sourceCoverage: { plannedTrustedSourceCount: 1, plannedPublicQueryCount: 0, checkedBranchCount: 1, credibleBranchCount: 1, verifiedJobCount: 0 }, coverageLosses: [], qualification: { evaluatedCount: 0, rejectedCount: 0, insufficientInformationCount: 0, expiredCount: 0 }, coarseRanking: { eligibleCount: 0, belowThresholdCount: 0, ruleExcludedCount: 0, candidateLimitExcludedCount: 0, deepMatchCandidateCount: 0 }, deepMatching: { evaluatedCount: 0, qualityInsufficientCount: 0, finalRecommendationCount: 0 }, suggestedActions: [] };
  return RecommendationRunSchema.parse({ ...base, result: { kind: "no_recommendations", resultId: listA, evidence, publishedAt: "2026-09-14T00:00:00.000Z" } });
}

describe("RecommendationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getJobTargets.mockResolvedValue({ targets: [] });
    mocks.getLatestRecommendations.mockResolvedValue(null);
    mocks.getRecommendationList.mockResolvedValue(null);
    mocks.getRecommendationHistoryPage.mockResolvedValue({ items: [], nextCursor: null });
    mocks.getCalibrationProposals.mockResolvedValue([]);
    mocks.getLatestPublishedRecommendationRun.mockResolvedValue(null);
    mocks.getRecommendationRun.mockResolvedValue(null);
    mocks.requestRecommendationReevaluationAction.mockResolvedValue({ kind: "started" });
    mocks.recordRecommendationDecisionAction.mockResolvedValue(undefined);
  });

  it("explains the evidence-driven recommendation state without exposing a precise score", async () => {
    render(await RecommendationsPage());
    expect(screen.getByRole("heading", { name: "推荐清单" })).toBeInTheDocument();
    expect(screen.getByText("暂无可处理的推荐")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("default 将最新已发布结果绑定到其精确清单，而非首个活动目标的最新清单", async () => {
    const bound = list(listA, targetB, "绑定岗位"), latest = list(listB, targetA, "错误最新岗位");
    mocks.getLatestPublishedRecommendationRun.mockResolvedValue(published(targetB, listA)); mocks.getRecommendationList.mockResolvedValue(bound); mocks.getLatestRecommendations.mockResolvedValue(latest);
    mocks.getJobTargets.mockResolvedValue({ targets: [{ targetId: targetA, state: "active", priority: "primary" }, { targetId: targetB, state: "active", priority: "secondary" }] });
    render(await RecommendationsPage()); expect(screen.getByText("绑定岗位")).toBeInTheDocument(); expect(screen.queryByText("错误最新岗位")).not.toBeInTheDocument(); expect(mocks.getRecommendationList).toHaveBeenCalledWith(targetB, listA); expect(mocks.getLatestRecommendations).not.toHaveBeenCalled(); expect(mocks.getRecommendationHistoryPage).toHaveBeenCalledWith(targetB); expect(mocks.getCalibrationProposals).toHaveBeenCalledWith(targetB); expect(document.getElementById("recommendation-result")).not.toBeNull(); expect(document.getElementById("recommendation-list")).not.toBeNull();
  });
  it("root 深链只读取指定运行和其精确清单", async () => { mocks.getRecommendationRun.mockResolvedValue(published(targetB, listA)); mocks.getRecommendationList.mockResolvedValue(list(listA, targetB, "深链岗位")); render(await RecommendationsPage({ searchParams: Promise.resolve({ runId: runA, resultId: listA }) })); expect(screen.getByText("深链岗位")).toBeInTheDocument(); expect(mocks.getRecommendationRun).toHaveBeenCalledWith(runA); expect(mocks.getRecommendationList).toHaveBeenCalledWith(targetB, listA); expect(mocks.getLatestPublishedRecommendationRun).not.toHaveBeenCalled(); expect(mocks.getLatestRecommendations).not.toHaveBeenCalled(); });
  it("target 与 list 深链只读取精确 pair", async () => { mocks.getRecommendationList.mockResolvedValue(list(listA, targetB, "精确岗位")); render(await RecommendationsPage({ searchParams: Promise.resolve({ targetId: targetB, recommendationListId: listA }) })); expect(screen.getByText("精确岗位")).toBeInTheDocument(); expect(mocks.getRecommendationList).toHaveBeenCalledWith(targetB, listA); expect(document.getElementById("recommendation-list")).not.toBeNull(); expect(document.getElementById("recommendation-result")).toBeNull(); expect(mocks.getLatestPublishedRecommendationRun).not.toHaveBeenCalled(); expect(mocks.getLatestRecommendations).not.toHaveBeenCalled(); });
  it("legacy target-only URL 保留该目标 latest 读取", async () => { mocks.getLatestRecommendations.mockResolvedValue(list(listA, targetB, "兼容岗位")); render(await RecommendationsPage({ searchParams: Promise.resolve({ targetId: targetB }) })); expect(screen.getByText("兼容岗位")).toBeInTheDocument(); expect(mocks.getLatestRecommendations).toHaveBeenCalledWith(targetB); expect(mocks.getLatestPublishedRecommendationRun).not.toHaveBeenCalled(); });
  it("default 在目标数组排序变化后仍渲染同一绑定岗位", async () => { mocks.getLatestPublishedRecommendationRun.mockResolvedValue(published(targetB, listA)); mocks.getRecommendationList.mockResolvedValue(list(listA, targetB, "稳定绑定岗位")); mocks.getJobTargets.mockResolvedValue({ targets: [{ targetId: targetA, state: "active", priority: "primary" }, { targetId: targetB, state: "active", priority: "secondary" }] }); const first = await RecommendationsPage(); mocks.getJobTargets.mockResolvedValue({ targets: [{ targetId: targetB, state: "active", priority: "secondary" }, { targetId: targetA, state: "active", priority: "primary" }] }); const second = await RecommendationsPage(); render(<>{first}{second}</>); expect(screen.getAllByText("稳定绑定岗位")).toHaveLength(2); expect(mocks.getRecommendationList).toHaveBeenNthCalledWith(1, targetB, listA); expect(mocks.getRecommendationList).toHaveBeenNthCalledWith(2, targetB, listA); });
  it("重新评估和收藏保留绑定的目标、岗位、清单与条目身份", async () => { mocks.getLatestPublishedRecommendationRun.mockResolvedValue(published(targetB, listA)); mocks.getRecommendationList.mockResolvedValue(list(listA, targetB, "交互岗位")); render(await RecommendationsPage()); fireEvent.click(screen.getByRole("button", { name: "重新评估此岗位" })); fireEvent.click(screen.getByRole("button", { name: "收藏" })); await waitFor(() => expect(mocks.requestRecommendationReevaluationAction).toHaveBeenCalledWith(targetB, "00000000-0000-4000-8000-000000000008", expect.any(FormData))); await waitFor(() => expect(mocks.recordRecommendationDecisionAction).toHaveBeenCalledWith(listA, "00000000-0000-4000-8000-000000000006", expect.any(FormData))); });

  it.each([
    [{ runId: "" }], [{ runId: runA, resultId: "" }], [{ runId: [runA] }], [{ runId: "not-a-uuid", resultId: listA }],
    [{ resultId: listA }], [{ runId: runA, resultId: [listA] }], [{ runId: runA, resultId: "not-a-uuid" }],
    [{ recommendationListId: listA }], [{ targetId: "" }], [{ targetId: [targetA] }], [{ targetId: "not-a-uuid" }],
    [{ targetId: targetA, recommendationListId: "" }], [{ targetId: targetA, recommendationListId: [listA] }], [{ targetId: targetA, recommendationListId: "not-a-uuid" }],
    [{ runId: runA, resultId: listA, targetId: targetA }], [{ runId: runA, resultId: listA, recommendationListId: listA }],
  ])("拒绝无效或矛盾的结果身份参数，并且不读取替代结果：%o", async (searchParams) => {
    render(await RecommendationsPage({ searchParams: Promise.resolve(searchParams) }));
    expect(screen.getByRole("alert")).toHaveTextContent("推荐链接无效");
    expect(mocks.getRecommendationRun).not.toHaveBeenCalled();
    expect(mocks.getLatestPublishedRecommendationRun).not.toHaveBeenCalled();
    expect(mocks.getRecommendationList).not.toHaveBeenCalled();
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
    expect(mocks.getJobTargets).not.toHaveBeenCalled();
  });

  it("无关 query 不改变默认已发布结果的身份", async () => {
    mocks.getLatestPublishedRecommendationRun.mockResolvedValue(published(targetB, listA));
    mocks.getRecommendationList.mockResolvedValue(list(listA, targetB, "默认绑定岗位"));
    render(await RecommendationsPage({ searchParams: Promise.resolve({ from: "notification" }) }));
    expect(screen.getByText("默认绑定岗位")).toBeInTheDocument();
    expect(mocks.getLatestPublishedRecommendationRun).toHaveBeenCalledTimes(1);
  });

  it("只含合法 root ID 时读取该运行的精确清单", async () => {
    mocks.getRecommendationRun.mockResolvedValue(published(targetB, listA));
    mocks.getRecommendationList.mockResolvedValue(list(listA, targetB, "root 专属岗位"));
    render(await RecommendationsPage({ searchParams: Promise.resolve({ runId: runA }) }));
    expect(screen.getByText("root 专属岗位")).toBeInTheDocument();
    expect(mocks.getRecommendationRun).toHaveBeenCalledWith(runA);
    expect(mocks.getRecommendationList).toHaveBeenCalledWith(targetB, listA);
    expect(mocks.getLatestPublishedRecommendationRun).not.toHaveBeenCalled();
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it.each([
    ["root 读取为空", null, { runId: runA }],
    ["root 身份不符", published(targetB, listA), { runId: runA }],
    ["显式 result 身份不符", published(targetB, listA), { runId: runA, resultId: listB }],
  ])("%s 时拒绝显示替代结果", async (_name, selected, searchParams) => {
    const mismatched = selected && _name === "root 身份不符" ? RecommendationRunSchema.parse({ ...selected, runId: "00000000-0000-4000-8000-000000000010" }) : selected;
    mocks.getRecommendationRun.mockResolvedValue(mismatched);
    render(await RecommendationsPage({ searchParams: Promise.resolve(searchParams) }));
    expect(screen.getByRole("alert")).toHaveTextContent("推荐结果无法确认");
    expect(mocks.getLatestPublishedRecommendationRun).not.toHaveBeenCalled();
    expect(mocks.getRecommendationList).not.toHaveBeenCalled();
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it.each([
    ["root 结果", { runId: runA, resultId: listA }, (): void => { mocks.getRecommendationRun.mockResolvedValue(published(targetB, listA)); }],
    ["显式 target/list", { targetId: targetB, recommendationListId: listA }, (): void => undefined],
  ])("%s 的精确清单不存在时不回退", async (_name, searchParams, arrange) => {
    arrange();
    mocks.getRecommendationList.mockResolvedValue(null);
    render(await RecommendationsPage({ searchParams: Promise.resolve(searchParams) }));
    expect(screen.getByRole("alert")).toHaveTextContent("推荐结果无法确认");
    expect(screen.queryByText("暂无可处理的推荐")).not.toBeInTheDocument();
    expect(mocks.getLatestPublishedRecommendationRun).not.toHaveBeenCalled();
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it.each([
    ["root 结果", { runId: runA, resultId: listA }, (): void => { mocks.getRecommendationRun.mockResolvedValue(published(targetB, listA)); }],
    ["显式 target/list", { targetId: targetB, recommendationListId: listA }, (): void => undefined],
  ])("%s 的精确清单返回 404 时不回退", async (_name, searchParams, arrange) => {
    arrange();
    mocks.getRecommendationList.mockRejectedValue({ status: 404, body: "untrusted" });
    render(await RecommendationsPage({ searchParams: Promise.resolve(searchParams) }));
    expect(screen.getByRole("alert")).toHaveTextContent("推荐结果无法确认");
    expect(screen.queryByText("untrusted")).not.toBeInTheDocument();
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it.each([
    ["root 结果的 target", { runId: runA, resultId: listA }, list(listA, targetA, "错误目标"), (): void => { mocks.getRecommendationRun.mockResolvedValue(published(targetB, listA)); }],
    ["显式 pair 的 list", { targetId: targetB, recommendationListId: listA }, list(listB, targetB, "错误清单"), (): void => undefined],
  ])("%s 身份不符时不回退", async (_name, searchParams, returnedList, arrange) => {
    arrange();
    mocks.getRecommendationList.mockResolvedValue(returnedList);
    render(await RecommendationsPage({ searchParams: Promise.resolve(searchParams) }));
    expect(screen.getByRole("alert")).toHaveTextContent("推荐结果无法确认");
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it.each([
    ["默认已发布结果", {}, (): void => { mocks.getLatestPublishedRecommendationRun.mockRejectedValue(new Error("502 upstream body")); }],
    ["root 结果", { runId: runA }, (): void => { mocks.getRecommendationRun.mockRejectedValue(new Error("502 upstream body")); }],
    ["显式精确清单", { targetId: targetB, recommendationListId: listA }, (): void => { mocks.getRecommendationList.mockRejectedValue(new Error("502 upstream body")); }],
  ])("%s 读取异常时显示稳定错误且不准备空文案", async (_name, searchParams, arrange) => {
    arrange();
    render(await RecommendationsPage({ searchParams: Promise.resolve(searchParams) }));
    expect(screen.getByRole("alert")).toHaveTextContent("推荐结果暂时无法读取，请稍后重试。");
    expect(screen.queryByText("502 upstream body")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无可处理的推荐")).not.toBeInTheDocument();
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it("保留可识别的 Next 重定向控制流", async () => {
    const { redirect } = await import("next/navigation");
    let redirectError: unknown;
    try { redirect("/login?returnTo=%2Frecommendations"); } catch (error) { redirectError = error; }
    expect(redirectError).toBeDefined();
    mocks.getRecommendationRun.mockRejectedValue(redirectError);
    await expect(RecommendationsPage({ searchParams: Promise.resolve({ runId: runA }) })).rejects.toBe(redirectError);
  });

  it.each([
    ["queued", "推荐正在等待开始"], ["running", "推荐正在进行"], ["paused", "推荐已暂停，等待恢复"], ["failed", "资格门槛暂时无法完成"], ["cancelled", "本次推荐已取消"],
  ] as const)("root-only 的 %s 状态不回退为可信空结果", async (status, copy) => {
    mocks.getRecommendationRun.mockResolvedValue(nonCompleted(status));
    render(await RecommendationsPage({ searchParams: Promise.resolve({ runId: runA }) }));
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText("暂无可处理的推荐")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "推荐岗位" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看本次推荐" })).toHaveAttribute("href", `/home?runId=${runA}`);
    expect(mocks.getLatestPublishedRecommendationRun).not.toHaveBeenCalled();
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it("默认没有已发布结果时只使用 primary 的准备和历史入口，不读 latest", async () => {
    mocks.getJobTargets.mockResolvedValue({ targets: [{ targetId: targetB, state: "active", priority: "secondary" }, { targetId: targetA, state: "active", priority: "primary" }] });
    mocks.getRecommendationHistoryPage.mockResolvedValue({ items: [list(listB, targetA, "历史岗位")], nextCursor: null });
    render(await RecommendationsPage());
    expect(screen.getByText("暂无可处理的推荐")).toBeInTheDocument();
    expect(screen.getByText("历史岗位")).toBeInTheDocument();
    expect(mocks.getRecommendationHistoryPage).toHaveBeenCalledWith(targetA);
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it.each([["默认", {}, () => { mocks.getLatestPublishedRecommendationRun.mockResolvedValue(noRecommendations()); }], ["root", { runId: runA, resultId: listA }, () => { mocks.getRecommendationRun.mockResolvedValue(noRecommendations()); }]] as const)("%s 的可信空结果不回退为历史或当前清单", async (_name, searchParams, arrange) => {
    arrange(); mocks.getLatestRecommendations.mockResolvedValue(list(listB, targetB, "旧清单岗位"));
    render(await RecommendationsPage({ searchParams: Promise.resolve(searchParams) }));
    expect(screen.getByText("今天暂无推荐")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "推荐岗位" })).not.toBeInTheDocument();
    expect(screen.queryByText("旧清单岗位")).not.toBeInTheDocument();
    expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
  });

  it("停止结果由页面消费为策略入口，解除后重新读取同一不可变清单", async () => {
    mocks.getLatestPublishedRecommendationRun.mockResolvedValue(published(targetB, listA)); mocks.getRecommendationList.mockResolvedValue(list(listA, targetB, "停止前岗位"));
    mocks.requestRecommendationReevaluationAction.mockResolvedValueOnce({ kind: "account_run_stopped" }).mockResolvedValueOnce({ kind: "started" });
    const first = await RecommendationsPage(); render(first); fireEvent.click(screen.getByRole("button", { name: "重新评估此岗位" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "管理运行策略" })).toHaveAttribute("href", "/profile/run-policy"));
    const second = await RecommendationsPage(); render(second);
    expect(screen.getAllByText("停止前岗位")).toHaveLength(2);
    expect(mocks.getRecommendationList).toHaveBeenNthCalledWith(1, targetB, listA);
    expect(mocks.getRecommendationList).toHaveBeenNthCalledWith(2, targetB, listA);
    expect(mocks.requestRecommendationReevaluationAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重新评估此岗位" }));
    await waitFor(() => expect(mocks.requestRecommendationReevaluationAction).toHaveBeenCalledTimes(2));
    expect(mocks.requestRecommendationReevaluationAction).toHaveBeenLastCalledWith(targetB, "00000000-0000-4000-8000-000000000008", expect.any(FormData));
  });

  it.each(["history", "calibration"] as const)("%s 的独立读取失败不污染已绑定的推荐结果", async (reader) => {
    mocks.getLatestPublishedRecommendationRun.mockResolvedValue(published(targetB, listA)); mocks.getRecommendationList.mockResolvedValue(list(listA, targetB, "仍可查看的岗位"));
    if (reader === "history") mocks.getRecommendationHistoryPage.mockRejectedValue(new Error("history secret")); else mocks.getCalibrationProposals.mockRejectedValue(new Error("calibration secret"));
    render(await RecommendationsPage());
    expect(screen.getByText("仍可查看的岗位")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法读取");
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("展示证据判断、历史版本入口和异步重新评估入口，但不展示精确分数", async () => {
    mocks.getJobTargets.mockResolvedValue({ targets: [{ targetId: "00000000-0000-4000-8000-000000000001", state: "active", priority: "primary" }] });
    mocks.getLatestRecommendations.mockResolvedValue({
      recommendationListId: "10000000-0000-4000-8000-000000000001", targetId: "00000000-0000-4000-8000-000000000001", localDate: "2026-09-01", sequence: 2, createdAt: "2026-09-01T00:00:00.000Z",
      exclusions: [{ opportunityId: "30000000-0000-4000-8000-000000000099", reasonCode: "MATCH_QUALITY_INSUFFICIENT" }],
      items: [{ matchVersionId: "20000000-0000-4000-8000-000000000001", opportunityId: "30000000-0000-4000-8000-000000000001", company: "示例科技", title: "前端工程师", location: "上海", displayBand: "highly_matched", highlighted: true, ordinal: 1, jobEvidence: [{ id: "job:1", value: "岗位要求 TypeScript", provenance: { sourcePostingVersionId: "40000000-0000-4000-8000-000000000001", field: "workMode", path: "工作方式", originalValue: "远程办公", normalizedValue: "remote" } }, { id: "job:salary", value: "薪资：CNY 30000-45000/month", provenance: { sourcePostingVersionId: "40000000-0000-4000-8000-000000000001", field: "salary", path: "薪资", originalValue: "月薪 3-4.5 万", normalizedValue: "salary-normalized" } }, { id: "job:industry", value: "行业：人工智能", provenance: { sourcePostingVersionId: "40000000-0000-4000-8000-000000000001", field: "industry", path: "行业", originalValue: "AI 基础设施", normalizedValue: "人工智能" } }, { id: "job:employment", value: "雇佣类型：direct", provenance: { sourcePostingVersionId: "40000000-0000-4000-8000-000000000001", field: "employmentType", path: "雇佣类型", originalValue: "正式直聘", normalizedValue: "direct" } }], profileEvidence: [{ id: "profile:1", value: "已确认 TypeScript 经历" }], assessment: { opportunityId: "30000000-0000-4000-8000-000000000001", overallScore: 80, dimensions: ["skills", "experience", "project_depth", "career_direction", "location_logistics", "qualification_risk"].map((dimension) => ({ dimension, score: 80, judgment: "evidence_backed_inference", jobEvidenceIds: ["job:1"], profileEvidenceIds: ["profile:1"], summary: dimension === "skills" ? "岗位要求与已确认技能相符。" : "证据支持的推断。" })) } }],
    });
    mocks.getRecommendationHistoryPage.mockResolvedValue({ items: [{
      recommendationListId: "10000000-0000-4000-8000-000000000000", targetId: "00000000-0000-4000-8000-000000000001", localDate: "2026-08-31", sequence: 1, createdAt: "2026-08-31T00:00:00.000Z", exclusions: [],
      items: [{ matchVersionId: "20000000-0000-4000-8000-000000000000", opportunityId: "30000000-0000-4000-8000-000000000000", company: "历史公司", title: "历史岗位", location: "上海", displayBand: "worth_trying", highlighted: true, ordinal: 1, jobEvidence: [{ id: "job:old", value: "历史岗位证据", provenance: { sourcePostingVersionId: "40000000-0000-4000-8000-000000000000", field: "seniority", path: "岗位级别", originalValue: "资深工程师", normalizedValue: "senior" } }, { id: "job:old-salary", value: "薪资：CNY 30000-45000/month", provenance: { sourcePostingVersionId: "40000000-0000-4000-8000-000000000000", field: "salary", path: "薪资", originalValue: "历史月薪", normalizedValue: "salary-normalized" } }, { id: "job:old-industry", value: "行业：人工智能", provenance: { sourcePostingVersionId: "40000000-0000-4000-8000-000000000000", field: "industry", path: "行业", originalValue: "历史行业原文", normalizedValue: "人工智能" } }, { id: "job:old-employment", value: "雇佣类型：direct", provenance: { sourcePostingVersionId: "40000000-0000-4000-8000-000000000000", field: "employmentType", path: "雇佣类型", originalValue: "历史直聘原文", normalizedValue: "direct" } }], profileEvidence: [{ id: "profile:old", value: "历史画像证据" }], assessment: { opportunityId: "30000000-0000-4000-8000-000000000000", overallScore: 70, dimensions: ["skills", "experience", "project_depth", "career_direction", "location_logistics", "qualification_risk"].map((dimension) => ({ dimension, score: 70, judgment: "evidence_backed_inference", jobEvidenceIds: ["job:old"], profileEvidenceIds: ["profile:old"], summary: "历史证据支持的推断。" })) } }],
    }], nextCursor: null });

    render(await RecommendationsPage({ searchParams: Promise.resolve({ targetId: "00000000-0000-4000-8000-000000000001" }) }));
    expect(screen.getByText("高度匹配")).toBeInTheDocument();
    expect(screen.getByText("今日优先处理")).toBeInTheDocument();
    expect(screen.getByText(/岗位要求与已确认技能相符/u)).toBeInTheDocument();
    expect(screen.getAllByText("技能").length).toBeGreaterThan(1);
    expect(screen.getAllByText("资格风险").length).toBeGreaterThan(1);
    expect(screen.getByText(/岗位证据：工作方式：远程办公/u)).toBeInTheDocument();
    expect(screen.getByText(/薪资：月薪 3-4.5 万；行业：AI 基础设施；雇佣类型：正式直聘/u)).toBeInTheDocument();
    expect(screen.getByText(/画像证据：已确认 TypeScript 经历/u)).toBeInTheDocument();
    expect(screen.getByText(/稳定排除 1 项岗位：匹配证据不足/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新评估此岗位" })).toBeInTheDocument();
    expect(screen.getByLabelText("推荐清单版本")).toHaveTextContent("清单版本 2");
    expect(screen.getByText("历史版本")).toBeInTheDocument();
    expect(screen.getByText("历史岗位")).toBeInTheDocument();
    expect(screen.getByText(/岗位证据：岗位级别：资深工程师/u)).toBeInTheDocument();
    expect(screen.getByText(/薪资：历史月薪；行业：历史行业原文；雇佣类型：历史直聘原文/u)).toBeInTheDocument();
    expect(screen.queryByText("总体分数")).not.toBeInTheDocument();
  });
});
