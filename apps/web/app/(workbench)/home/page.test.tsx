import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkbenchHome: vi.fn(), getJobTargets: vi.fn(), getLatestAgentRun: vi.fn(), getAgentRun: vi.fn(), getOpenAgentInbox: vi.fn(), getRunPreflight: vi.fn(),
  getRecommendationRunPreparation: vi.fn(), getLatestRecommendationRun: vi.fn(), getRecommendationRun: vi.fn(),
  unstableRethrow: vi.fn<(error: unknown) => void>(),
}));

vi.mock("@/lib/server/workbench", () => ({ getWorkbenchHome: mocks.getWorkbenchHome }));
vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: mocks.getJobTargets }));
vi.mock("@/lib/server/agent-runs", () => ({ getLatestAgentRun: mocks.getLatestAgentRun, getAgentRun: mocks.getAgentRun }));
vi.mock("@/lib/server/agent-inbox", () => ({ getOpenAgentInbox: mocks.getOpenAgentInbox }));
vi.mock("@/lib/server/run-preflight", () => ({ getRunPreflight: mocks.getRunPreflight }));
vi.mock("@/lib/server/recommendation-runs", () => ({ getRecommendationRunPreparation: mocks.getRecommendationRunPreparation, getLatestRecommendationRun: mocks.getLatestRecommendationRun, getRecommendationRun: mocks.getRecommendationRun }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.unstableRethrow }));

import WorkbenchHomePage, { metadata } from "./page";

const home = { account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" }, summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false }, firstRecommendationJourney: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.unstableRethrow.mockImplementation((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("NEXT_REDIRECT:")) throw error;
  });
});

it("declares a stable workbench document title", () => expect(metadata.title).toBe("工作台 | AI Job Search Copilot"));

it("targets 失败不伪造成空数组，并保留成功的运行结果", async () => {
  mocks.getWorkbenchHome.mockResolvedValue(home);
  mocks.getJobTargets.mockRejectedValue(new Error("targets unavailable"));
  const run = { runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" };
  mocks.getLatestAgentRun.mockResolvedValue({ run });
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });
  const page = await WorkbenchHomePage();
  expect(mocks.getWorkbenchHome).toHaveBeenCalledOnce();
  expect(mocks.getJobTargets).toHaveBeenCalledOnce();
  expect(mocks.getLatestAgentRun).toHaveBeenCalledOnce();
  expect(mocks.getOpenAgentInbox).toHaveBeenCalledOnce();
  expect(page.props).toMatchObject({ home, targets: null, initialRun: run, inbox: { items: [] }, unavailableSections: ["targets", "preflight"] });
});

it("运行读取失败不隐藏成功的 targets", async () => {
  const targets = { suggestions: [], targets: [] };
  mocks.getWorkbenchHome.mockResolvedValue(home);
  mocks.getJobTargets.mockResolvedValue(targets);
  mocks.getLatestAgentRun.mockRejectedValue(new Error("run unavailable"));
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });
  const page = await WorkbenchHomePage();
  expect(page.props).toMatchObject({ targets, initialRun: null, unavailableSections: ["run"] });
});

it("不把认证重定向转成局部错误", async () => {
  const redirectError = new Error("NEXT_REDIRECT:/login?returnTo=%2Fhome");
  mocks.getWorkbenchHome.mockRejectedValue(redirectError);
  mocks.getJobTargets.mockResolvedValue({ suggestions: [], targets: [] });
  mocks.getLatestAgentRun.mockResolvedValue({ run: null });
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });
  await expect(WorkbenchHomePage()).rejects.toThrow("NEXT_REDIRECT:/login?returnTo=%2Fhome");
  expect(mocks.unstableRethrow).toHaveBeenCalledWith(redirectError);
});

it("与其他首页投影并行读取主目标的运行前检查，检查失败不隐藏成功区域", async () => {
  const targets = { suggestions: [], targets: [{ targetId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3", priority: "primary", state: "active" }] };
  mocks.getWorkbenchHome.mockResolvedValue(home);
  mocks.getJobTargets.mockResolvedValue(targets);
  mocks.getLatestAgentRun.mockResolvedValue({ run: null });
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });
  mocks.getRunPreflight.mockRejectedValue(new Error("preflight unavailable"));

  const page = await WorkbenchHomePage();
  expect(mocks.getRunPreflight).toHaveBeenCalledWith(targets.targets[0].targetId);
  expect(page.props).toMatchObject({ home, targets, initialRun: null, unavailableSections: ["preflight"], preflight: null });
});

it("默认并行读取推荐准备和最近逻辑运行，逻辑运行明确 404 时才回退物理历史", async () => {
  mocks.getWorkbenchHome.mockResolvedValue(home);
  mocks.getJobTargets.mockResolvedValue({ suggestions: [], targets: [] });
  mocks.getLatestAgentRun.mockResolvedValue({ run: null });
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });
  mocks.getRunPreflight.mockResolvedValue(null);
  mocks.getRecommendationRunPreparation.mockResolvedValue({ target: null });
  const recommendation = { runId: "8f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" };
  mocks.getLatestRecommendationRun.mockResolvedValue(recommendation);
  const page = await WorkbenchHomePage();
  expect(mocks.getRecommendationRunPreparation).toHaveBeenCalledOnce();
  expect(mocks.getLatestRecommendationRun).toHaveBeenCalledOnce();
  expect(page.props).toMatchObject({ initialRecommendationPreparation: { target: null }, initialRecommendationRun: recommendation });
});

it("显式逻辑运行成功时不读取物理历史，非 404 失败保留逻辑不可用", async () => {
  mocks.getWorkbenchHome.mockResolvedValue(home);
  mocks.getJobTargets.mockResolvedValue({ suggestions: [], targets: [] });
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });
  mocks.getRunPreflight.mockResolvedValue(null);
  mocks.getRecommendationRunPreparation.mockResolvedValue({ target: null });
  const runId = "8f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
  mocks.getRecommendationRun.mockResolvedValue({ runId });
  await WorkbenchHomePage({ searchParams: Promise.resolve({ runId }) });
  expect(mocks.getAgentRun).not.toHaveBeenCalled();
});
