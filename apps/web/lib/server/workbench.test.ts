import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkbenchHome: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => {
    throw new Error(`redirect:${location}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/api-client", () => ({ api: { getWorkbenchHome: mocks.getWorkbenchHome } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { getWorkbenchHome } from "./workbench";

afterEach(() => {
  vi.clearAllMocks();
});

it("redirects to login when the HttpOnly session cookie is absent", async () => {
  mocks.readSessionToken.mockResolvedValue(null);

  await expect(getWorkbenchHome()).rejects.toThrow("redirect:/login?returnTo=%2Fhome");
  expect(mocks.getWorkbenchHome).not.toHaveBeenCalled();
});

it("reads only the current authenticated account workbench", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getWorkbenchHome.mockResolvedValue({
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false },
  });

  await expect(getWorkbenchHome()).resolves.toMatchObject({
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
  });
  expect(mocks.getWorkbenchHome).toHaveBeenCalledWith("a".repeat(43));
});

it("redirects when the API rejects the current session", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getWorkbenchHome.mockRejectedValue({ status: 401 });

  await expect(getWorkbenchHome()).rejects.toThrow("redirect:/login?returnTo=%2Fhome");
});
