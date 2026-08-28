import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJobTargetOverview: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));

vi.mock("@/lib/server/api-client", () => ({ api: { getJobTargetOverview: mocks.getJobTargetOverview } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getJobTargets } from "./job-targets";

afterEach(() => vi.clearAllMocks());

it("redirects unauthenticated job target reads to their exact return destination", async () => {
  mocks.readSessionToken.mockResolvedValue(null);

  await expect(getJobTargets()).rejects.toThrow("redirect:/login?returnTo=%2Fprofile%2Ftargets");
});

it("rechecks API authentication while reading the complete authenticated overview", async () => {
  const overview = { suggestions: [], targets: [] };
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getJobTargetOverview.mockResolvedValue(overview);

  await expect(getJobTargets()).resolves.toEqual(overview);
  expect(mocks.getJobTargetOverview).toHaveBeenCalledWith("a".repeat(43));

  mocks.getJobTargetOverview.mockRejectedValue({ status: 401 });
  await expect(getJobTargets()).rejects.toThrow("redirect:/login?returnTo=%2Fprofile%2Ftargets");
});
