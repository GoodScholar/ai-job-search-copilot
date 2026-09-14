import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecommendationRunPreparationSchema, RecommendationRunSchema, type RecommendationRun } from "@job-copilot/contracts/recommendation-runs";

const boundary = vi.hoisted(() => ({
  getWorkbenchHome: vi.fn(), getJobTargets: vi.fn(), getLatestAgentRun: vi.fn(), getAgentRun: vi.fn(), getOpenAgentInbox: vi.fn(), getRunPreflight: vi.fn(),
  getRecommendationRunPreparation: vi.fn(), getLatestRecommendationRun: vi.fn(), getRecommendationRun: vi.fn(), unstableRethrow: vi.fn<(error: unknown) => void>(),
  refresh: vi.fn(), replace: vi.fn(), href: "",
}));

vi.mock("@/lib/server/workbench", () => ({ getWorkbenchHome: boundary.getWorkbenchHome }));
vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: boundary.getJobTargets }));
vi.mock("@/lib/server/agent-runs", () => ({ getLatestAgentRun: boundary.getLatestAgentRun, getAgentRun: boundary.getAgentRun }));
vi.mock("@/lib/server/agent-inbox", () => ({ getOpenAgentInbox: boundary.getOpenAgentInbox }));
vi.mock("@/lib/server/run-preflight", () => ({ getRunPreflight: boundary.getRunPreflight }));
vi.mock("@/lib/server/recommendation-runs", () => ({ getRecommendationRunPreparation: boundary.getRecommendationRunPreparation, getLatestRecommendationRun: boundary.getLatestRecommendationRun, getRecommendationRun: boundary.getRecommendationRun }));
vi.mock("next/navigation", () => ({ unstable_rethrow: boundary.unstableRethrow, useRouter: () => ({ refresh: boundary.refresh, replace: boundary.replace }) }));

import WorkbenchHomePage from "./page";

const rootAId = "a1a1a1a1-2b92-4d91-aad4-959b7d4cd7a3";
const rootBId = "b1b1b1b1-2b92-4d91-aad4-959b7d4cd7a3";
const targetId = "5f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const checkedAt = "2026-09-14T00:00:00.000Z";
const budget = { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 };
const preparation = RecommendationRunPreparationSchema.parse({
  target: { targetId, targetVersion: 1, roleFamily: "AI 应用工程师" }, sourceScope: { trustedSourceCount: 1, publicQueryCount: 0 }, accountPolicyRevisionNumber: 1,
  budgets: { discovery: budget, deepMatch: budget },
  preflight: { version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId, status: "ready", warningFingerprint: null, checkedAt, items: [] },
});
const home = { account: { userId: targetId }, summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false }, firstRecommendationJourney: null };

function recommendationRun(runId: string, status: "cancelled" | "running" | "paused"): RecommendationRun {
  const running = status !== "cancelled";
  return RecommendationRunSchema.parse({
    runId, status, currentStage: running ? "discovery" : null,
    stages: [
      { key: "discovery", status: running ? "running" : "cancelled", startedAt: checkedAt, completedAt: running ? null : checkedAt },
      { key: "qualification", status: "pending", startedAt: null, completedAt: null }, { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
      { key: "deep_matching", status: "pending", startedAt: null, completedAt: null }, { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
    ],
    target: preparation.target!, sourceScope: preparation.sourceScope, accountPolicyRevisionNumber: 1, budgets: preparation.budgets, preflightSnapshot: preparation.preflight,
    result: null, failure: null, createdAt: checkedAt, updatedAt: checkedAt,
  });
}

function searchParamsForNavigation() {
  const url = new URL(boundary.href, "https://copilot.test");
  return { runId: url.searchParams.get("runId") ?? undefined };
}

beforeEach(() => {
  const historicalRun = recommendationRun(rootAId, "cancelled");
  let serverRun = historicalRun;
  boundary.href = `/home?runId=${rootAId}`;
  vi.clearAllMocks();
  boundary.replace.mockImplementation((href: string) => { boundary.href = href; });
  boundary.unstableRethrow.mockImplementation((error: unknown) => { if (error instanceof Error && error.message.startsWith("NEXT_REDIRECT:")) throw error; });
  boundary.getWorkbenchHome.mockResolvedValue(home);
  boundary.getJobTargets.mockResolvedValue({ suggestions: [], targets: [] });
  boundary.getLatestAgentRun.mockResolvedValue({ run: null });
  boundary.getOpenAgentInbox.mockResolvedValue({ items: [] });
  boundary.getRunPreflight.mockResolvedValue(null);
  boundary.getRecommendationRunPreparation.mockResolvedValue(preparation);
  boundary.getRecommendationRun.mockImplementation(async (runId: string) => runId === rootAId ? RecommendationRunSchema.parse(historicalRun) : runId === rootBId ? serverRun : null);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/recommendation-runs" && init?.method === "POST") {
      serverRun = recommendationRun(rootBId, "running");
      return Response.json({ run: serverRun, reused: false }, { status: 201 });
    }
    if (url === `/api/recommendation-runs/${rootBId}` && !init?.method) return Response.json(serverRun);
    if (url === `/api/recommendation-runs/${rootBId}/controls` && init?.method === "POST") {
      serverRun = recommendationRun(rootBId, "paused");
      return Response.json({ run: serverRun, applied: true });
    }
    return Response.json({ message: "unexpected request" }, { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("历史 A 重跑后的 SSR 回灌继续读取并控制服务端 B", async () => {
  const user = userEvent.setup();
  const initialPage = await WorkbenchHomePage({ searchParams: Promise.resolve({ runId: rootAId }) });
  const view = render(initialPage);
  await user.click(screen.getByRole("button", { name: "开始今日发现" }));

  await waitFor(() => expect(boundary.refresh).toHaveBeenCalled());
  const reloadedPage = await WorkbenchHomePage({ searchParams: Promise.resolve(searchParamsForNavigation()) });
  await act(async () => { view.rerender(reloadedPage); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

  const panel = within(screen.getByRole("region", { name: "开始今日完整推荐" }));
  expect(panel.getByRole("status")).toHaveTextContent("正在完成今日发现");
  expect(boundary.getRecommendationRun).toHaveBeenLastCalledWith(rootBId);
  expect(panel.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
  vi.mocked(fetch).mockClear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/recommendation-runs/${rootBId}`, expect.objectContaining({ cache: "no-store" })));
  await user.click(panel.getByRole("button", { name: "暂停本次推荐" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/recommendation-runs/${rootBId}/controls`, expect.objectContaining({ method: "POST" })));

  const pausedBPage = await WorkbenchHomePage({ searchParams: Promise.resolve(searchParamsForNavigation()) });
  expect(boundary.getRecommendationRun).toHaveBeenLastCalledWith(rootBId);
  await act(async () => { view.rerender(pausedBPage); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(panel.getByRole("status")).toHaveTextContent("本次推荐已暂停");
  expect(panel.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
});
