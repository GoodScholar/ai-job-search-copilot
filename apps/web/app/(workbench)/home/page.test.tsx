import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkbenchHome: vi.fn(),
  getJobTargets: vi.fn(),
  getLatestAgentRun: vi.fn(),
  unstableRethrow: vi.fn((error: unknown) => {
    throw error;
  }),
}));

vi.mock("@/lib/server/workbench", () => ({ getWorkbenchHome: mocks.getWorkbenchHome }));
vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: mocks.getJobTargets }));
vi.mock("@/lib/server/agent-runs", () => ({ getLatestAgentRun: mocks.getLatestAgentRun }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.unstableRethrow }));

import WorkbenchHomePage, { metadata } from "./page";

beforeEach(() => vi.clearAllMocks());

it("declares a stable workbench document title", () => {
  expect(metadata.title).toBe("工作台 | AI Job Search Copilot");
});

it("does not turn an authentication redirect into a retryable workbench error", async () => {
  const redirectError = new Error("NEXT_REDIRECT:/login?returnTo=%2Fhome");
  mocks.getWorkbenchHome.mockRejectedValue(redirectError);
  mocks.getJobTargets.mockResolvedValue({ suggestions: [], targets: [] });
  mocks.getLatestAgentRun.mockResolvedValue({ run: null });

  await expect(WorkbenchHomePage()).rejects.toThrow("NEXT_REDIRECT:/login?returnTo=%2Fhome");
  expect(mocks.unstableRethrow).toHaveBeenCalledWith(redirectError);
});

it("starts the three authenticated first reads in parallel and passes their strict DTOs to the workbench", async () => {
  let resolveHome!: (value: unknown) => void;
  const homePromise = new Promise((resolve) => { resolveHome = resolve; });
  const home = { account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" }, summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 } };
  const targets = { suggestions: [], targets: [] };
  const latest = { run: null };
  mocks.getWorkbenchHome.mockReturnValue(homePromise);
  mocks.getJobTargets.mockResolvedValue(targets);
  mocks.getLatestAgentRun.mockResolvedValue(latest);

  const pendingPage = WorkbenchHomePage();
  await Promise.resolve();
  expect(mocks.getWorkbenchHome).toHaveBeenCalledOnce();
  expect(mocks.getJobTargets).toHaveBeenCalledOnce();
  expect(mocks.getLatestAgentRun).toHaveBeenCalledOnce();
  resolveHome(home);

  const page = await pendingPage;
  expect(page.props).toMatchObject({ home, targets, initialRun: null });
});
