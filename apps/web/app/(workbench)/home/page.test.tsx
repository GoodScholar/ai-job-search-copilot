import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkbenchHome: vi.fn(), getJobTargets: vi.fn(), getLatestAgentRun: vi.fn(), getAgentRun: vi.fn(), getOpenAgentInbox: vi.fn(),
  unstableRethrow: vi.fn<(error: unknown) => void>(),
}));

vi.mock("@/lib/server/workbench", () => ({ getWorkbenchHome: mocks.getWorkbenchHome }));
vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: mocks.getJobTargets }));
vi.mock("@/lib/server/agent-runs", () => ({ getLatestAgentRun: mocks.getLatestAgentRun, getAgentRun: mocks.getAgentRun }));
vi.mock("@/lib/server/agent-inbox", () => ({ getOpenAgentInbox: mocks.getOpenAgentInbox }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.unstableRethrow }));

import WorkbenchHomePage, { metadata } from "./page";

const home = { account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" }, summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.unstableRethrow.mockImplementation((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("NEXT_REDIRECT:")) throw error;
  });
});

it("declares a stable workbench document title", () => expect(metadata.title).toBe("工作台 | AI Job Search Copilot"));

it("并行读取独立区块，一项失败时仍把成功结果和不可用区块交给工作台", async () => {
  mocks.getWorkbenchHome.mockResolvedValue(home);
  mocks.getJobTargets.mockRejectedValue(new Error("targets unavailable"));
  mocks.getLatestAgentRun.mockResolvedValue({ run: null });
  mocks.getOpenAgentInbox.mockResolvedValue({ items: [] });
  const page = await WorkbenchHomePage();
  expect(mocks.getWorkbenchHome).toHaveBeenCalledOnce();
  expect(mocks.getJobTargets).toHaveBeenCalledOnce();
  expect(mocks.getLatestAgentRun).toHaveBeenCalledOnce();
  expect(mocks.getOpenAgentInbox).toHaveBeenCalledOnce();
  expect(page.props).toMatchObject({ home, targets: { suggestions: [], targets: [] }, inbox: { items: [] }, unavailableSections: ["targets"] });
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
