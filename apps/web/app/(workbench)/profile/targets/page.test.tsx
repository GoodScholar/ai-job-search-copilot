import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJobTargets: vi.fn(),
  jobTargetsView: vi.fn(() => null),
  unstableRethrow: vi.fn((error: unknown) => {
    if (error instanceof Error && error.message.startsWith("NEXT_")) throw error;
  }),
}));

vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: mocks.getJobTargets }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.unstableRethrow }));
vi.mock("@/components/workbench/job-targets-view", () => ({ JobTargetsView: mocks.jobTargetsView }));

import JobTargetsPage, { metadata } from "./page";

it("declares the target page and preserves Next control-flow errors", async () => {
  expect(metadata.title).toBe("求职目标 | AI Job Search Copilot");
  const redirectError = new Error("NEXT_REDIRECT:/login?returnTo=%2Fprofile%2Ftargets");
  mocks.getJobTargets.mockRejectedValue(redirectError);

  await expect(JobTargetsPage()).rejects.toThrow("NEXT_REDIRECT:/login?returnTo=%2Fprofile%2Ftargets");
  expect(mocks.unstableRethrow).toHaveBeenCalledWith(redirectError);
});

it("passes the complete authenticated first read to the target client view", async () => {
  const overview = { suggestions: [], targets: [] };
  mocks.getJobTargets.mockResolvedValue(overview);

  const page = await JobTargetsPage();

  expect(page.props.initialOverview).toEqual(overview);
});

it("shows a fixed retry state without leaking recoverable server internals", async () => {
  mocks.getJobTargets.mockRejectedValue(new Error("http://internal-api:3021 secret failure"));

  const page = await JobTargetsPage();

  expect(page.props.children.props.children[2].props.children).toBe("暂时无法读取你的求职目标。请稍后重新尝试。");
  expect(JSON.stringify(page)).not.toContain("internal-api");
});
