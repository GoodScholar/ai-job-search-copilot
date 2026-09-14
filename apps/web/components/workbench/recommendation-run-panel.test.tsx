import {
  RecommendationRunPreparationSchema,
  RecommendationRunSchema,
  type RecommendationRun,
  type RecommendationRunPreparation,
} from "@job-copilot/contracts/recommendation-runs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecommendationRunPanel } from "./recommendation-run-panel";

const runId = "9a5a0c80-2a73-4e61-8b14-d80f6e345af0";
const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const now = "2026-09-14T08:00:00.000Z";
const warningFingerprint = "a".repeat(64);
const budget = { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 };
const firstKey = "355eec35-befa-44ee-ac34-1e3614975d4f";
const secondKey = "aee8d950-b36e-42ee-aac5-6763673757fc";
const thirdKey = "6e5d8a8a-5652-4fd1-9f1c-50515bd11c48";

function preflight(status: "ready" | "ready_with_warnings" | "blocked" = "ready") {
  const item = status === "blocked"
    ? { code: "ACCOUNT_RUN_POLICY_BLOCKED", severity: "blocking", summary: "账户运行已停止", evidence: { kind: "account_run_policy", revisionNumber: 1, status: "blocked", checkedAt: now }, impact: "请先解除全局停止", retryable: false, suggestedActions: ["review_account_run_policy"] }
    : status === "ready_with_warnings"
      ? { code: "SOURCE_HEALTH_UNCHECKED", severity: "warning", summary: "来源尚未检查", evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null }, impact: "可能遗漏岗位", retryable: true, suggestedActions: ["review_source_health"] }
      : { code: "ACCOUNT_RUN_POLICY_READY", severity: "informational", summary: "账户运行可用", evidence: { kind: "account_run_policy", revisionNumber: 1, status: "ready", checkedAt: now }, impact: "可以开始完整推荐", retryable: false, suggestedActions: [] };
  return { version: "run-preflight-v1" as const, workflow: "recommendation" as const, trigger: "manual" as const, targetId, status, items: [item], warningFingerprint: status === "ready_with_warnings" ? warningFingerprint : null, checkedAt: now };
}

function preparation(status: "ready" | "ready_with_warnings" | "blocked" = "ready"): RecommendationRunPreparation {
  return RecommendationRunPreparationSchema.parse({
    target: { targetId, targetVersion: 1, roleFamily: "AI 应用工程师" }, sourceScope: { trustedSourceCount: 2, publicQueryCount: 1 }, accountPolicyRevisionNumber: 1,
    budgets: { discovery: budget, deepMatch: budget }, preflight: preflight(status),
  });
}

function targetMissingPreparation(): RecommendationRunPreparation {
  return RecommendationRunPreparationSchema.parse({
    target: null, sourceScope: { trustedSourceCount: 0, publicQueryCount: 0 }, accountPolicyRevisionNumber: 1,
    budgets: { discovery: budget, deepMatch: budget },
    preflight: {
      version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId: null, status: "blocked", warningFingerprint: null, checkedAt: now,
      items: [{
        code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: "缺少活动主求职目标", impact: "请先设置一个活动主求职目标。", retryable: false, suggestedActions: ["review_job_targets"],
        evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: now },
      }],
    },
  });
}

function runningRun(): RecommendationRun {
  return RecommendationRunSchema.parse({
    runId, status: "running", currentStage: "discovery",
    stages: [
      { key: "discovery", status: "running", startedAt: now, completedAt: null },
      { key: "qualification", status: "pending", startedAt: null, completedAt: null },
      { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
      { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
      { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
    ], target: { targetId, targetVersion: 1, roleFamily: "AI 应用工程师" }, sourceScope: { trustedSourceCount: 2, publicQueryCount: 1 }, accountPolicyRevisionNumber: 1,
    budgets: { discovery: budget, deepMatch: budget }, preflightSnapshot: preflight(), result: null, failure: null, createdAt: now, updatedAt: now,
  });
}

function cancelledRun(): RecommendationRun {
  return RecommendationRunSchema.parse({
    ...runningRun(), status: "cancelled", currentStage: null,
    stages: [
      { key: "discovery", status: "cancelled", startedAt: now, completedAt: now },
      { key: "qualification", status: "pending", startedAt: null, completedAt: null },
      { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
      { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
      { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
    ],
  });
}

function failedRun(suggestedActions: Array<"restart_discovery" | "review_source_health" | "review_profile" | "review_primary_target" | "run_model_diagnostic" | "review_account_run_policy">): RecommendationRun {
  return RecommendationRunSchema.parse({
    ...runningRun(), status: "failed", currentStage: "qualification",
    stages: [
      { key: "discovery", status: "completed", startedAt: now, completedAt: now },
      { key: "qualification", status: "failed", startedAt: now, completedAt: now },
      { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
      { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
      { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
    ],
    failure: { code: "RECOMMENDATION_HANDOFF_FAILED", stage: "qualification", summary: "资格门槛交接失败", impact: "本次推荐无法继续发布。", retryable: true, suggestedActions },
  });
}

function pausedRun(): RecommendationRun {
  return RecommendationRunSchema.parse({ ...runningRun(), status: "paused" });
}

function resultEvidence(coverageLosses: Array<{ code: "TRUSTED_SOURCE_UNAVAILABLE" | "PUBLIC_DISCOVERY_UNAVAILABLE" | "SOURCE_HEALTH_DEGRADED" | "SOURCE_CAPABILITY_UNAVAILABLE" | "VERIFICATION_FAILED" | "DISCOVERY_BUDGET_EXCEEDED"; affectedCount: number; retryable: boolean }> = []) {
  return {
    discovery: { discoveredJobCount: 6 }, sourceCoverage: { plannedTrustedSourceCount: 2, plannedPublicQueryCount: 1, checkedBranchCount: 3, credibleBranchCount: 1, verifiedJobCount: 6 }, coverageLosses,
    qualification: { evaluatedCount: 6, rejectedCount: 2, insufficientInformationCount: 1, expiredCount: 1 },
    coarseRanking: { eligibleCount: 2, belowThresholdCount: 1, ruleExcludedCount: 0, candidateLimitExcludedCount: 0, deepMatchCandidateCount: 1 },
    deepMatching: { evaluatedCount: 1, qualityInsufficientCount: 1, finalRecommendationCount: 0 }, suggestedActions: ["review_source_health", "review_profile"],
  };
}

function completedRun(kind: "recommendation_list" | "no_recommendations", coverageLosses: Parameters<typeof resultEvidence>[0] = []): RecommendationRun {
  const evidence = resultEvidence(coverageLosses);
  if (kind === "recommendation_list") {
    evidence.coarseRanking = { ...evidence.coarseRanking, deepMatchCandidateCount: 1 };
    evidence.deepMatching = { evaluatedCount: 1, qualityInsufficientCount: 0, finalRecommendationCount: 1 };
  }
  return RecommendationRunSchema.parse({
    ...runningRun(), status: "completed", currentStage: null, stages: ["discovery", "qualification", "coarse_ranking", "deep_matching", "result_publication"].map((key) => ({ key, status: "completed", startedAt: now, completedAt: now })),
    result: kind === "recommendation_list" ? { kind, resultId: "6e5d8a8a-5652-4fd1-9f1c-50515bd11c48", recommendationListId: "6e5d8a8a-5652-4fd1-9f1c-50515bd11c48", itemCount: 1, evidence, publishedAt: now } : { kind, resultId: "6e5d8a8a-5652-4fd1-9f1c-50515bd11c48", evidence, publishedAt: now },
  });
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setDocumentVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(runningRun()))));
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(firstKey);
  setDocumentVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("stops polling when the document is hidden and resumes it for an active run", async () => {
  const fetchSpy = vi.mocked(fetch);
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  setDocumentVisibility("hidden");
  await act(async () => { vi.advanceTimersByTime(15_000); });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  setDocumentVisibility("visible");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it("blocked preparation disables start and points to the run policy", () => {
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("blocked")} />);
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "查看运行设置" })).toHaveAttribute("href", "/profile/run-policy");
});

it("requires warning confirmation before it submits only the confirmation fingerprint and idempotency key", async () => {
  const fetchSpy = vi.mocked(fetch).mockImplementation(() => Promise.resolve(response({ run: runningRun(), reused: false }, 201)));
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("ready_with_warnings")} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  expect(fetchSpy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); });
  const startCall = fetchSpy.mock.calls.find(([url, init]) => url === "/api/recommendation-runs" && init?.method === "POST");
  expect(startCall).toMatchObject(["/api/recommendation-runs", { method: "POST", body: JSON.stringify({ idempotencyKey: "355eec35-befa-44ee-ac34-1e3614975d4f", warningFingerprint }) }]);
});

it("shows the ordered stages with the active stage and a non-disruptive live status", () => {
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  const list = screen.getByRole("list");
  expect(list).toHaveTextContent("发现岗位");
  expect(list).toHaveTextContent("资格筛选");
  expect(list).toHaveTextContent("初步排序");
  expect(list).toHaveTextContent("深度匹配");
  expect(list).toHaveTextContent("发布结果");
  expect(screen.getByText("发现岗位").closest("li")).toHaveAttribute("aria-current", "step");
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
});

it("replays a pause control with its command id and refreshes authoritative state on a conflict", async () => {
  const fetchSpy = vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/controls") && init?.method === "POST") return Promise.resolve(response({ code: "ACCOUNT_RUN_STOPPED", message: "账户已停止全部运行" }, 409));
    return Promise.resolve(response(runningRun()));
  });
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(fetchSpy).toHaveBeenCalledTimes(3);
  expect(fetchSpy.mock.calls[1]).toMatchObject([`/api/recommendation-runs/${runId}/controls`, { body: JSON.stringify({ commandId: "355eec35-befa-44ee-ac34-1e3614975d4f", action: "pause" }) }]);
  expect(screen.getByRole("link", { name: "查看运行设置" })).toHaveAttribute("href", "/profile/run-policy");
});

it("adopts refreshed preparation after a start conflict instead of reusing an old warning fingerprint", async () => {
  const refreshedPreparation = preparation("ready");
  const fetchSpy = vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" }, 409));
    if (input === "/api/recommendation-runs/preparation") return Promise.resolve(response(refreshedPreparation));
    if (input === "/api/recommendation-runs/latest") return Promise.resolve(response({ run: null }));
    return Promise.resolve(response(runningRun()));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("ready_with_warnings")} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(fetchSpy.mock.calls.some(([url]) => url === "/api/recommendation-runs/preparation")).toBe(true);
  expect(screen.getByRole("status")).toHaveTextContent("已读取最新准备状态");
});

it("terminal runs and unmounted panels do not continue polling", async () => {
  const completed = { ...runningRun(), status: "cancelled", currentStage: null, stages: [
    { key: "discovery", status: "cancelled", startedAt: now, completedAt: now },
    { key: "qualification", status: "pending", startedAt: null, completedAt: null }, { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
    { key: "deep_matching", status: "pending", startedAt: null, completedAt: null }, { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
  ] } as RecommendationRun;
  const fetchSpy = vi.mocked(fetch);
  const terminal = render(<RecommendationRunPanel initialRun={completed} initialPreparation={preparation()} />);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetchSpy).not.toHaveBeenCalled();
  terminal.unmount();
});

it("同一面板收到新的权威 props 时更新运行和准备状态，同时保留当前焦点", async () => {
  const secondRun = RecommendationRunSchema.parse({ ...runningRun(), runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" });
  const secondPreparation = RecommendationRunPreparationSchema.parse({ ...preparation(), target: { targetId, targetVersion: 2, roleFamily: "数据工程师" } });
  const view = render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  const startButton = screen.getByRole("button", { name: "开始今日发现" });
  startButton.focus();

  view.rerender(<RecommendationRunPanel initialRun={secondRun} initialPreparation={secondPreparation} />);

  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText("主目标：数据工程师")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("正在完成今日发现");
  expect(document.activeElement).toBe(startButton);
});

it("旧 root 的延迟读取不能覆盖后来到达的权威 root", async () => {
  let resolveOldRead!: (value: Response) => void;
  const oldRun = runningRun();
  const secondRun = RecommendationRunSchema.parse({ ...runningRun(), runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3", target: { targetId, targetVersion: 2, roleFamily: "数据工程师" } });
  const secondPreparation = RecommendationRunPreparationSchema.parse({ ...preparation(), target: { targetId, targetVersion: 2, roleFamily: "数据工程师" } });
  vi.mocked(fetch).mockImplementation((input) => String(input).endsWith(oldRun.runId)
    ? new Promise<Response>((resolve) => { resolveOldRead = resolve; })
    : Promise.resolve(response(secondRun)));
  const view = render(<RecommendationRunPanel initialRun={oldRun} initialPreparation={preparation()} />);

  view.rerender(<RecommendationRunPanel initialRun={secondRun} initialPreparation={secondPreparation} />);
  await act(async () => { await Promise.resolve(); });
  resolveOldRead(response(cancelledRun()));
  await act(async () => { await Promise.resolve(); });

  expect(screen.getByRole("status")).toHaveTextContent("正在完成今日发现");
  expect(screen.getByText("主目标：数据工程师")).toBeVisible();
});

it("成功 resume 后可继续 pause，两个控制请求均到达当前服务端状态", async () => {
  let serverRun = pausedRun();
  const events: string[] = [];
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      const action = JSON.parse(String(init.body)).action as "pause" | "resume";
      events.push(`POST ${action}`);
      serverRun = RecommendationRunSchema.parse(action === "resume" ? runningRun() : pausedRun());
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    events.push(`GET ${serverRun.status}`);
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={pausedRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "继续本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(events).toEqual(["GET paused", "POST resume", "GET running", "POST pause", "GET paused"]);
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
});

it("暂停态明确等待继续，并在同 root 恢复后还原进行中文案和控制", async () => {
  const paused = RecommendationRunSchema.parse({
    ...runningRun(), status: "paused", currentStage: "qualification",
    stages: [
      { key: "discovery", status: "completed", startedAt: now, completedAt: now },
      { key: "qualification", status: "running", startedAt: now, completedAt: null },
      { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
      { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
      { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
    ],
  });
  const resumed = RecommendationRunSchema.parse({ ...paused, status: "running" });
  let serverRun = paused;
  vi.mocked(fetch).mockImplementation(() => Promise.resolve(response(serverRun)));
  const view = render(<RecommendationRunPanel initialRun={paused} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });

  expect(screen.getByRole("button", { name: "本次推荐已暂停" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "今日发现进行中" })).not.toBeInTheDocument();
  const pausedStage = screen.getByText("资格筛选").closest("li");
  expect(pausedStage).toHaveAttribute("aria-current", "step");
  expect(pausedStage).toHaveTextContent("已暂停，等待继续");
  expect(screen.getByText("发现岗位").closest("li")).toHaveTextContent("已完成");
  expect(screen.getByText("初步排序").closest("li")).toHaveTextContent("等待开始");
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "取消本次推荐" })).toBeEnabled();

  serverRun = resumed;
  view.rerender(<RecommendationRunPanel initialRun={resumed} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "今日发现进行中" })).toBeDisabled();
  expect(screen.getByText("资格筛选").closest("li")).toHaveTextContent("正在进行");
  expect(screen.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "取消本次推荐" })).toBeEnabled();
});

it("warning 启动冲突刷新后允许重新确认并提交", async () => {
  const requests: string[] = [];
  const refreshedPreparation = preparation("ready_with_warnings");
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") {
      requests.push("POST start");
      return Promise.resolve(requests.length === 1
        ? response({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" }, 409)
        : response({ run: runningRun(), reused: false }, 201));
    }
    if (input === "/api/recommendation-runs/preparation") return Promise.resolve(response(refreshedPreparation));
    if (input === "/api/recommendation-runs/latest") return Promise.resolve(response({ run: null }));
    return Promise.resolve(response(runningRun()));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("ready_with_warnings")} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(requests).toEqual(["POST start", "POST start"]);
});

it.each([200, 201])("start 收到 %i 后，服务端终态允许再次启动", async (status) => {
  let startCount = 0;
  let serverRun: RecommendationRun | null = null;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") {
      startCount += 1;
      serverRun = RecommendationRunSchema.parse(runningRun());
      const startResponse = response({ run: serverRun, reused: false }, status);
      if (startCount === 1) serverRun = cancelledRun();
      return Promise.resolve(startResponse);
    }
    if (String(input).endsWith(`/${runId}`)) return Promise.resolve(response(serverRun));
    return Promise.resolve(response({ run: null }));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(startCount).toBe(2);
});

it("start 网络失败重试复用 key，终态后新启动生成新 key", async () => {
  let startCount = 0;
  let serverRun: RecommendationRun | null = null;
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey);
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") {
      startCount += 1;
      if (startCount === 1) return Promise.reject(new Error("network unavailable"));
      serverRun = RecommendationRunSchema.parse(runningRun());
      const started = response({ run: serverRun, reused: false }, 201);
      if (startCount === 2) serverRun = cancelledRun();
      return Promise.resolve(started);
    }
    if (String(input).endsWith(`/${runId}`)) return Promise.resolve(response(serverRun));
    return Promise.resolve(response({ run: null }));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const starts = vi.mocked(fetch).mock.calls.filter(([input, init]) => input === "/api/recommendation-runs" && init?.method === "POST");
  expect(starts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { idempotencyKey: firstKey, warningFingerprint: null },
    { idempotencyKey: firstKey, warningFingerprint: null },
    { idempotencyKey: secondKey, warningFingerprint: null },
  ]);
});

it.each([
  ["pause", runningRun(), "暂停本次推荐", pausedRun(), "继续本次推荐"],
  ["resume", pausedRun(), "继续本次推荐", runningRun(), "暂停本次推荐"],
  ["cancel", runningRun(), "取消本次推荐", cancelledRun(), "本次推荐已取消"],
] as const)("%s 网络未知后重试复用 commandId，并采用合法服务端投影", async (action, initialRun, buttonName, appliedRun, visibleState) => {
  let serverRun = RecommendationRunSchema.parse(initialRun);
  let postCount = 0;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      postCount += 1;
      serverRun = RecommendationRunSchema.parse(appliedRun);
      if (postCount === 1) return Promise.reject(new Error("network unavailable"));
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={initialRun} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  const commands = vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/controls") && init?.method === "POST");
  expect(commands.map(([input, init]) => [input, init?.method, JSON.parse(String(init?.body))])).toEqual([
    [`/api/recommendation-runs/${runId}/controls`, "POST", { commandId: firstKey, action }],
    [`/api/recommendation-runs/${runId}/controls`, "POST", { commandId: firstKey, action }],
  ]);
  if (action === "cancel") expect(screen.getByRole("status")).toHaveTextContent(visibleState);
  else expect(screen.getByRole("button", { name: visibleState })).toBeEnabled();
});

it("pause 未知结果被 GET 确认后，新的 pause 意图使用新 commandId", async () => {
  let serverRun = runningRun();
  let pausePosts = 0;
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey).mockReturnValueOnce(thirdKey);
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      const action = JSON.parse(String(init.body)).action as "pause" | "resume";
      serverRun = RecommendationRunSchema.parse(action === "pause" ? pausedRun() : runningRun());
      if (action === "pause") {
        pausePosts += 1;
        if (pausePosts === 1) return Promise.reject(new Error("network unavailable"));
      }
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "继续本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const pauseCommands = vi.mocked(fetch).mock.calls
    .filter(([input, init]) => String(input).endsWith("/controls") && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)))
    .filter((body) => body.action === "pause");
  expect(pauseCommands).toEqual([
    { commandId: firstKey, action: "pause" }, { commandId: thirdKey, action: "pause" },
  ]);
});

it("未知命令后的新 root 不继承旧 commandId", async () => {
  const nextRun = RecommendationRunSchema.parse({ ...runningRun(), runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" });
  let serverRun = runningRun();
  let controls = 0;
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey);
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      controls += 1;
      if (controls === 1) return Promise.reject(new Error("network unavailable"));
      serverRun = RecommendationRunSchema.parse({ ...pausedRun(), runId: nextRun.runId });
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    return Promise.resolve(response(serverRun));
  });
  const view = render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  serverRun = nextRun;
  view.rerender(<RecommendationRunPanel initialRun={nextRun} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const commands = vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/controls") && init?.method === "POST");
  expect(commands.map(([input, init]) => [input, JSON.parse(String(init?.body))])).toEqual([
    [`/api/recommendation-runs/${runId}/controls`, { commandId: firstKey, action: "pause" }],
    [`/api/recommendation-runs/${nextRun.runId}/controls`, { commandId: secondKey, action: "pause" }],
  ]);
});

it.each(["GET", "props"] as const)("resume 未知结果由 %s 确认后，新的 resume 意图使用新 commandId", async (confirmation) => {
  let serverRun = pausedRun();
  let resumePosts = 0;
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey).mockReturnValueOnce(thirdKey);
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      const action = JSON.parse(String(init.body)).action as "pause" | "resume";
      serverRun = RecommendationRunSchema.parse(action === "resume" ? runningRun() : pausedRun());
      if (action === "resume") {
        resumePosts += 1;
        if (resumePosts === 1) return Promise.reject(new Error("network unavailable"));
      }
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    return Promise.resolve(response(serverRun));
  });
  const view = render(<RecommendationRunPanel initialRun={pausedRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "继续本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  if (confirmation === "GET") {
    await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
  } else {
    view.rerender(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }
  expect(screen.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "继续本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const resumeCommands = vi.mocked(fetch).mock.calls
    .filter(([input, init]) => String(input).endsWith("/controls") && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)))
    .filter((body) => body.action === "resume");
  expect(resumeCommands).toEqual([
    { commandId: firstKey, action: "resume" }, { commandId: thirdKey, action: "resume" },
  ]);
});

it("warning A 的 409 刷新为 warning B 后，第二次确认仅提交 B fingerprint", async () => {
  const warningBFingerprint = "b".repeat(64);
  const warningB = RecommendationRunPreparationSchema.parse({
    ...preparation("ready_with_warnings"),
    preflight: {
      ...preflight("ready_with_warnings"), warningFingerprint: warningBFingerprint,
      items: [{ ...preflight("ready_with_warnings").items[0]!, summary: "来源范围已变化", impact: "本次会跳过一个来源" }],
    },
  });
  let serverRun: RecommendationRun | null = null;
  const requests: Array<Record<string, unknown>> = [];
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1) return Promise.resolve(response({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" }, 409));
      serverRun = RecommendationRunSchema.parse(runningRun());
      return Promise.resolve(response({ run: serverRun, reused: false }, 201));
    }
    if (input === "/api/recommendation-runs/preparation") return Promise.resolve(response(warningB));
    if (input === "/api/recommendation-runs/latest") return Promise.resolve(response({ run: null }));
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("ready_with_warnings")} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(requests).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  expect(screen.getByRole("button", { name: "我已了解，开始今日发现" })).toBeVisible();
  expect(screen.getByText("来源范围已变化：本次会跳过一个来源")).toBeVisible();
  expect(requests).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(requests).toEqual([
    { idempotencyKey: firstKey, warningFingerprint },
    { idempotencyKey: firstKey, warningFingerprint: warningBFingerprint },
  ]);
});

it.each([
  ["preparation", 401], ["preparation", 502], ["preparation", 200],
  ["latest", 401], ["latest", 502], ["latest", 200],
] as const)("start 409 后 %s 读取 %i 失败时保留原准备状态并显示安全文案", async (failedEndpoint, status) => {
  const originalPreparation = RecommendationRunPreparationSchema.parse({ ...preparation(), target: { targetId, targetVersion: 1, roleFamily: "原始目标" } });
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ message: "不可信的启动错误" }, 409));
    if (input === "/api/recommendation-runs/preparation") {
      const body = failedEndpoint === "preparation" && status === 200 ? { message: "不可信的准备状态" } : originalPreparation;
      return Promise.resolve(response(body, failedEndpoint === "preparation" ? status : 200));
    }
    if (input === "/api/recommendation-runs/latest") {
      const body = failedEndpoint === "latest" && status === 200 ? { message: "不可信的最新状态" } : { run: null };
      return Promise.resolve(response(body, failedEndpoint === "latest" ? status : 200));
    }
    return Promise.resolve(response({ run: null }));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={originalPreparation} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByText("主目标：原始目标")).toBeVisible();
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent("启动条件已变化，但暂时无法读取最新准备状态，请稍后刷新页面重试。");
  expect(screen.queryByText(/不可信的/u)).not.toBeInTheDocument();
  expect(screen.getByRole("status")).not.toHaveTextContent("已读取最新准备状态");
});

it.each([[401], [502], [200]] as const)("control 409 后 GET %i 失败时保留权威 run 并显示安全文案", async (status) => {
  const initialRun = runningRun();
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") return Promise.resolve(response({ message: "不可信的控制错误" }, 409));
    if (String(input).endsWith(`/${runId}`)) return Promise.resolve(response(status === 200 ? { message: "不可信的运行状态" } : initialRun, status));
    return Promise.resolve(response(initialRun));
  });
  render(<RecommendationRunPanel initialRun={initialRun} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent("运行状态已变化，但暂时无法读取最新状态，请稍后刷新页面重试。");
  expect(screen.queryByText(/不可信的/u)).not.toBeInTheDocument();
  expect(screen.getByRole("status")).not.toHaveTextContent("已读取最新状态");
});

it("control 409 的成功读取采用新的权威 run 投影", async () => {
  let serverRun = runningRun();
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      serverRun = pausedRun();
      return Promise.resolve(response({ code: "RUN_STATE_CHANGED" }, 409));
    }
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
});

it("start 收到 ACCOUNT_RUN_STOPPED 409 且权威读取失败时保留停止恢复入口", async () => {
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ code: "ACCOUNT_RUN_STOPPED", message: "不可信的停止说明" }, 409));
    if (input === "/api/recommendation-runs/preparation" || input === "/api/recommendation-runs/latest") return Promise.resolve(response({ message: "不可信的读取错误" }, 502));
    return Promise.resolve(response({ run: null }));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("账户已停止全部运行，请先在运行设置中解除全局停止。");
  expect(screen.getByRole("link", { name: "查看运行设置" })).toHaveAttribute("href", "/profile/run-policy");
  expect(screen.queryByText(/不可信的/u)).not.toBeInTheDocument();
});

it("resume 收到 ACCOUNT_RUN_STOPPED 409 且读取失败时不自动恢复", async () => {
  const serverRun = pausedRun();
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") return Promise.resolve(response({ code: "ACCOUNT_RUN_STOPPED", message: "不可信的停止说明" }, 409));
    if (String(input).endsWith(`/${runId}`)) return Promise.resolve(response({ message: "不可信的读取错误" }, 502));
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={serverRun} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "继续本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("账户已停止全部运行，请先在运行设置中解除全局停止。");
  expect(screen.getByRole("link", { name: "查看运行设置" })).toHaveAttribute("href", "/profile/run-policy");
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
});

it("start 409 成功刷新为 policy block 后保持禁用", async () => {
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ code: "RUN_STATE_CHANGED" }, 409));
    if (input === "/api/recommendation-runs/preparation") return Promise.resolve(response(preparation("blocked")));
    if (input === "/api/recommendation-runs/latest") return Promise.resolve(response({ run: null }));
    return Promise.resolve(response({ run: null }));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeDisabled();
  expect(screen.getByText("账户运行策略当前阻止启动。")).toBeVisible();
});

it("可信空结果直接显示有限证据、损失与服务端建议", () => {
  const run = completedRun("no_recommendations", [
    { code: "TRUSTED_SOURCE_UNAVAILABLE", affectedCount: 2, retryable: true }, { code: "VERIFICATION_FAILED", affectedCount: 1, retryable: false },
  ]);
  render(<RecommendationRunPanel initialRun={run} initialPreparation={preparation()} />);
  expect(screen.getByRole("status")).toHaveTextContent("本次暂无推荐");
  expect(screen.getByText("已检查 3 个分支，可信覆盖 1 个，发现 6 条岗位。")).toBeVisible();
  expect(screen.getByText("资格筛选：淘汰 2 条，信息不足 1 条，已过期 1 条。")).toBeVisible();
  expect(screen.getByText("粗排：低于阈值 1 条，规则排除 0 条，超出上限 0 条。")).toBeVisible();
  expect(screen.getByText("深度匹配：质量不足 1 条。")).toBeVisible();
  expect(screen.getByText("可信来源暂不可用：2；验证未通过：1")).toBeVisible();
  expect(screen.getByRole("link", { name: "查看来源状态" })).toHaveAttribute("href", "/profile/targets");
  expect(screen.getByRole("link", { name: "完善求职画像" })).toHaveAttribute("href", "/profile");
});

it("推荐清单使用精确结果链接，非空清单不显示可信空摘要", () => {
  const run = completedRun("recommendation_list");
  render(<RecommendationRunPanel initialRun={run} initialPreparation={preparation()} />);
  expect(screen.getByRole("link", { name: "查看本次推荐" })).toHaveAttribute("href", `/recommendations?runId=${runId}&resultId=6e5d8a8a-5652-4fd1-9f1c-50515bd11c48#recommendation-result`);
  expect(screen.queryByText("本次暂无推荐")).not.toBeInTheDocument();
});

it("准备摘要显示账户策略版本并分别绑定两类预算", () => {
  const value = RecommendationRunPreparationSchema.parse({
    ...preparation(), accountPolicyRevisionNumber: 42,
    budgets: { discovery: { ...budget, maxResults: 3 }, deepMatch: { ...budget, maxResults: 7 } },
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={value} />);
  expect(screen.getByText("账户运行策略版本：42")).toBeVisible();
  expect(screen.getByText("发现预算：最多 3 条岗位；深度匹配预算：最多 7 条。")).toBeVisible();
});

it("start 的 ACCOUNT_RUN_STOPPED 409 后准备读取网络 reject 仍保留停止入口", async () => {
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ code: "ACCOUNT_RUN_STOPPED" }, 409));
    if (input === "/api/recommendation-runs/preparation" || input === "/api/recommendation-runs/latest") return Promise.reject(new Error("network unavailable"));
    return Promise.resolve(response({ run: null }));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("账户已停止全部运行，请先在运行设置中解除全局停止。");
  expect(screen.getByRole("link", { name: "查看运行设置" })).toHaveAttribute("href", "/profile/run-policy");
});

it("同 root 的迟到 GET 不覆盖 control 成功后的 paused 投影", async () => {
  let resolveRead!: (value: Response) => void;
  let reads = 0;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") return Promise.resolve(response({ run: pausedRun(), applied: true }));
    reads += 1;
    return reads === 1 ? new Promise<Response>((resolve) => { resolveRead = resolve; }) : Promise.resolve(response(pausedRun()));
  });
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
  resolveRead(response(runningRun()));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
});

it("hidden 初始不读取，visible 后读取；卸载后停止轮询", async () => {
  setDocumentVisibility("hidden");
  const fetchSpy = vi.mocked(fetch);
  const view = render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  expect(fetchSpy).not.toHaveBeenCalled();
  setDocumentVisibility("visible");
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it.each([200, 201])("start 收到 %i 后只读取返回的新 run root", async (status) => {
  const nextRunId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
  const initialRun = RecommendationRunSchema.parse({ ...cancelledRun(), runId: "a1a1a1a1-2b92-4d91-aad4-959b7d4cd7a3" });
  const serverRun = RecommendationRunSchema.parse({ ...runningRun(), runId: nextRunId });
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ run: serverRun, reused: status === 200 }, status));
    if (String(input).endsWith(`/${nextRunId}`)) return Promise.resolve(response(serverRun));
    throw new Error(`unexpected request: ${String(input)}`);
  });
  render(<RecommendationRunPanel initialRun={initialRun} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  const reads = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method !== "POST").map(([input]) => String(input));
  expect(reads).toEqual([`/api/recommendation-runs/${nextRunId}`]);
});

it.each([200, 201])("start 直接收到 %i completed 后不启动轮询", async (status) => {
  const nextRunId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
  const initialRun = RecommendationRunSchema.parse({ ...cancelledRun(), runId: "a1a1a1a1-2b92-4d91-aad4-959b7d4cd7a3" });
  const completed = RecommendationRunSchema.parse({ ...completedRun("no_recommendations"), runId: nextRunId });
  const fetchSpy = vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ run: completed, reused: status === 200 }, status));
    throw new Error(`unexpected request: ${String(input)}`);
  });
  render(<RecommendationRunPanel initialRun={initialRun} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("本次暂无推荐");
});

it.each([
  ["cancelled", cancelledRun()],
  ["completed", completedRun("no_recommendations")],
] as const)("running 轮询转换为 %s 后不再读取", async (_status, terminalRun) => {
  let reads = 0;
  const fetchSpy = vi.mocked(fetch).mockImplementation((input) => {
    if (!String(input).endsWith(`/${runId}`)) throw new Error(`unexpected request: ${String(input)}`);
    reads += 1;
    return Promise.resolve(response(reads === 1 ? runningRun() : terminalRun));
  });
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it("缺少主目标的合法 blocked preparation 禁止启动并指向目标设置", () => {
  render(<RecommendationRunPanel initialRun={null} initialPreparation={targetMissingPreparation()} />);
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "查看求职目标" })).toHaveAttribute("href", "/profile/targets");
});

it.each([
  ["review_account_run_policy", "查看运行设置", "/profile/run-policy"],
  ["review_profile", "完善求职画像", "/profile"],
  ["review_primary_target", "查看求职目标", "/profile/targets"],
  ["review_source_health", "查看来源状态", "/profile/targets"],
  ["run_model_diagnostic", "检查模型连接", "/profile/model-connection"],
] as const)("failed 的有限 action %s 使用服务端 href", (action, label, href) => {
  render(<RecommendationRunPanel initialRun={failedRun([action])} initialPreparation={preparation()} />);
  expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
});

it("failed restart_discovery 实际 POST 并采用新 run", async () => {
  const nextRun = RecommendationRunSchema.parse({ ...runningRun(), runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" });
  const fetchSpy = vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ run: nextRun, reused: false }, 201));
    if (String(input).endsWith(`/${nextRun.runId}`)) return Promise.resolve(response(nextRun));
    throw new Error(`unexpected request: ${String(input)}`);
  });
  render(<RecommendationRunPanel initialRun={failedRun(["restart_discovery"])} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "重新开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(fetchSpy.mock.calls.find(([input, init]) => input === "/api/recommendation-runs" && init?.method === "POST")).toBeDefined();
  expect(screen.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
});

it("failed 与 cancelled 不显示结果入口或可信空状态", () => {
  const failed = render(<RecommendationRunPanel initialRun={failedRun([])} initialPreparation={preparation()} />);
  expect(screen.queryByRole("link", { name: /查看本次/u })).not.toBeInTheDocument();
  expect(screen.queryByText("本次暂无推荐")).not.toBeInTheDocument();
  failed.unmount();
  render(<RecommendationRunPanel initialRun={cancelledRun()} initialPreparation={preparation()} />);
  expect(screen.queryByRole("link", { name: /查看本次/u })).not.toBeInTheDocument();
  expect(screen.queryByText("本次暂无推荐")).not.toBeInTheDocument();
});

it("可信空无覆盖损失且无 action 时不擅加入口，并使用精确结果链接", () => {
  const run = RecommendationRunSchema.parse({
    ...completedRun("no_recommendations"),
    result: { ...completedRun("no_recommendations").result!, evidence: { ...completedRun("no_recommendations").result!.evidence, suggestedActions: [] } },
  });
  render(<RecommendationRunPanel initialRun={run} initialPreparation={preparation()} />);
  expect(screen.getByText("无覆盖损失。")).toBeVisible();
  expect(screen.getByRole("link", { name: "查看本次结论" })).toHaveAttribute("href", `/recommendations?runId=${runId}&resultId=6e5d8a8a-5652-4fd1-9f1c-50515bd11c48#recommendation-result`);
  expect(screen.queryByRole("link", { name: "查看来源状态" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "完善求职画像" })).not.toBeInTheDocument();
});

it("可信空 review_primary_target 与 restart_discovery 只执行服务端 action", async () => {
  const base = completedRun("no_recommendations");
  const actionRun = RecommendationRunSchema.parse({
    ...base, result: { ...base.result!, evidence: { ...base.result!.evidence, suggestedActions: ["review_primary_target", "restart_discovery"] } },
  });
  const nextRun = RecommendationRunSchema.parse({ ...runningRun(), runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" });
  const fetchSpy = vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ run: nextRun, reused: false }, 201));
    if (String(input).endsWith(`/${nextRun.runId}`)) return Promise.resolve(response(nextRun));
    throw new Error(`unexpected request: ${String(input)}`);
  });
  render(<RecommendationRunPanel initialRun={actionRun} initialPreparation={preparation()} />);
  expect(screen.getByRole("link", { name: "查看求职目标" })).toHaveAttribute("href", "/profile/targets");
  fireEvent.click(screen.getByRole("button", { name: "重新开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(fetchSpy.mock.calls.find(([input, init]) => input === "/api/recommendation-runs" && init?.method === "POST")).toBeDefined();
});

it("旧 start 的 409 在 props 切换后不读取或覆盖新 root", async () => {
  let resolveStart!: (value: Response) => void;
  const rootA = RecommendationRunSchema.parse({ ...cancelledRun(), runId: "a1a1a1a1-2b92-4d91-aad4-959b7d4cd7a3" });
  const rootB = RecommendationRunSchema.parse({ ...cancelledRun(), runId: "b1b1b1b1-2b92-4d91-aad4-959b7d4cd7a3" });
  const warningB = RecommendationRunPreparationSchema.parse({ ...preparation("ready_with_warnings"), preflight: { ...preflight("ready_with_warnings"), items: [{ ...preflight("ready_with_warnings").items[0]!, summary: "新 root 的来源提示" }] } });
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return new Promise<Response>((resolve) => { resolveStart = resolve; });
    throw new Error(`stale start must not read: ${String(input)}`);
  });
  const view = render(<RecommendationRunPanel initialRun={rootA} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  view.rerender(<RecommendationRunPanel initialRun={rootB} initialPreparation={warningB} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  expect(screen.getByRole("button", { name: "我已了解，开始今日发现" })).toBeVisible();
  resolveStart(response({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" }, 409));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("本次推荐已取消");
  expect(screen.getByRole("button", { name: "我已了解，开始今日发现" })).toBeVisible();
});

it("已在途的旧 start 409 刷新不能采用 C 或关闭 B 的确认", async () => {
  let resolvePreparation!: (value: Response) => void;
  let resolveLatest!: (value: Response) => void;
  const rootA = RecommendationRunSchema.parse({ ...cancelledRun(), runId: "a1a1a1a1-2b92-4d91-aad4-959b7d4cd7a3" });
  const rootB = RecommendationRunSchema.parse({ ...cancelledRun(), runId: "b1b1b1b1-2b92-4d91-aad4-959b7d4cd7a3" });
  const rootC = RecommendationRunSchema.parse({ ...runningRun(), runId: "c1c1c1c1-2b92-4d91-aad4-959b7d4cd7a3" });
  const warningB = RecommendationRunPreparationSchema.parse({ ...preparation("ready_with_warnings"), preflight: { ...preflight("ready_with_warnings"), items: [{ ...preflight("ready_with_warnings").items[0]!, summary: "B 的确认仍应保留" }] } });
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" }, 409));
    if (input === "/api/recommendation-runs/preparation") return new Promise<Response>((resolve) => { resolvePreparation = resolve; });
    if (input === "/api/recommendation-runs/latest") return new Promise<Response>((resolve) => { resolveLatest = resolve; });
    throw new Error(`unexpected request: ${String(input)}`);
  });
  const view = render(<RecommendationRunPanel initialRun={rootA} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  view.rerender(<RecommendationRunPanel initialRun={rootB} initialPreparation={warningB} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  resolvePreparation(response(preparation()));
  resolveLatest(response({ run: rootC }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("本次推荐已取消");
  expect(screen.getByRole("button", { name: "我已了解，开始今日发现" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "暂停本次推荐" })).not.toBeInTheDocument();
});

it("同 root 的新权威 props 使在途 start 409 不得关闭新确认", async () => {
  let resolvePreparation!: (value: Response) => void;
  let resolveLatest!: (value: Response) => void;
  const root = RecommendationRunSchema.parse({ ...cancelledRun(), runId: "a1a1a1a1-2b92-4d91-aad4-959b7d4cd7a3" });
  const warningPreparation = RecommendationRunPreparationSchema.parse({ ...preparation("ready_with_warnings"), preflight: { ...preflight("ready_with_warnings"), items: [{ ...preflight("ready_with_warnings").items[0]!, summary: "新权威准备状态要求确认" }] } });
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" }, 409));
    if (input === "/api/recommendation-runs/preparation") return new Promise<Response>((resolve) => { resolvePreparation = resolve; });
    if (input === "/api/recommendation-runs/latest") return new Promise<Response>((resolve) => { resolveLatest = resolve; });
    throw new Error(`unexpected request: ${String(input)}`);
  });
  const view = render(<RecommendationRunPanel initialRun={root} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  view.rerender(<RecommendationRunPanel initialRun={root} initialPreparation={warningPreparation} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  expect(screen.getByRole("button", { name: "我已了解，开始今日发现" })).toBeVisible();
  resolvePreparation(response(warningPreparation));
  resolveLatest(response({ run: root }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("本次推荐已取消");
  expect(screen.getByRole("button", { name: "我已了解，开始今日发现" })).toBeVisible();
});
