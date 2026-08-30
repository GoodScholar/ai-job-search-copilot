import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkbenchHome: vi.fn(),
  getJobTargets: vi.fn(),
  getLatestAgentRun: vi.fn(),
  getAgentRun: vi.fn(),
  getOpenAgentInbox: vi.fn(),
  getJobDiscoverySchedule: vi.fn(),
  unstableRethrow: vi.fn((error: unknown) => {
    throw error;
  }),
}));

vi.mock("@/lib/server/workbench", () => ({ getWorkbenchHome: mocks.getWorkbenchHome }));
vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: mocks.getJobTargets }));
vi.mock("@/lib/server/agent-runs", () => ({ getLatestAgentRun: mocks.getLatestAgentRun, getAgentRun: mocks.getAgentRun }));
vi.mock("@/lib/server/agent-inbox", () => ({ getOpenAgentInbox: mocks.getOpenAgentInbox }));
vi.mock("@/lib/server/job-discovery-schedules", () => ({ getJobDiscoverySchedule: mocks.getJobDiscoverySchedule }));
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
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });

  await expect(WorkbenchHomePage()).rejects.toThrow("NEXT_REDIRECT:/login?returnTo=%2Fhome");
  expect(mocks.unstableRethrow).toHaveBeenCalledWith(redirectError);
});

it("starts the four authenticated first reads in parallel and passes their strict DTOs to the workbench", async () => {
  let resolveHome!: (value: unknown) => void;
  const homePromise = new Promise((resolve) => { resolveHome = resolve; });
  const home = { account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" }, summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 } };
  const targets = { suggestions: [], targets: [{ targetId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3", version: 1, state: "active", roleFamily: "engineering", preferredLocations: [], workModes: [], employmentTypes: [], salaryCurrency: null, salaryMin: null, salaryMax: null, createdAt: "2026-08-30T02:00:00.000Z", updatedAt: "2026-08-30T02:00:00.000Z" }] };
  const latest = { run: null };
  const inbox = { items: [] };
  mocks.getWorkbenchHome.mockReturnValue(homePromise);
  mocks.getJobTargets.mockResolvedValue(targets);
  mocks.getLatestAgentRun.mockResolvedValue(latest);
  mocks.getOpenAgentInbox.mockResolvedValue(inbox);

  const pendingPage = WorkbenchHomePage();
  await Promise.resolve();
  expect(mocks.getWorkbenchHome).toHaveBeenCalledOnce();
  expect(mocks.getJobTargets).toHaveBeenCalledOnce();
  expect(mocks.getLatestAgentRun).toHaveBeenCalledOnce();
  expect(mocks.getOpenAgentInbox).toHaveBeenCalledOnce();
  expect(mocks.getJobDiscoverySchedule).not.toHaveBeenCalled();
  resolveHome(home);

  const page = await pendingPage;
  expect(page.props).toMatchObject({ home, targets, initialRun: null, inbox });
});

it("只为合法指定 runId 读取 owner-bound 运行，且不回退到 latest", async () => {
  const home = { account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" }, summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 } };
  const targets = { suggestions: [], targets: [] };
  const inbox = { items: [] };
  const runId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
  mocks.getWorkbenchHome.mockResolvedValue(home);
  mocks.getJobTargets.mockResolvedValue(targets);
  mocks.getOpenAgentInbox.mockResolvedValue(inbox);
  mocks.getAgentRun.mockResolvedValue(null);

  const page = await WorkbenchHomePage({ searchParams: Promise.resolve({ runId }) });

  expect(mocks.getAgentRun).toHaveBeenCalledWith(runId);
  expect(mocks.getLatestAgentRun).not.toHaveBeenCalled();
  expect(page.props).toMatchObject({ initialRun: null });
});

it("拒绝非法或数组 runId，且不把它们替换为 latest", async () => {
  mocks.getWorkbenchHome.mockResolvedValue({ account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" }, summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 } });
  mocks.getJobTargets.mockResolvedValue({ suggestions: [], targets: [] });
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });

  const page = await WorkbenchHomePage({ searchParams: Promise.resolve({ runId: ["not-a-uuid"] }) });

  expect(mocks.getAgentRun).not.toHaveBeenCalled();
  expect(mocks.getLatestAgentRun).not.toHaveBeenCalled();
  expect(page.props).toMatchObject({ initialRun: null });
});
