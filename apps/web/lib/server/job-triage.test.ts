import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getLatestJobTriageVersion: vi.fn(), readSessionToken: vi.fn(), redirect: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/api-client", () => ({ api: { getLatestJobTriageVersion: mocks.getLatestJobTriageVersion } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { getLatestJobTriageVersion } from "./job-triage";

const opportunityId = "f4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";

it("uses the HttpOnly session to load the persisted latest triage version", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getLatestJobTriageVersion.mockResolvedValue({ triageVersionId: "e4d4a7c1-9a17-4a8c-8b36-0f815d042e9a" });
  await expect(getLatestJobTriageVersion(opportunityId)).resolves.toEqual({ triageVersionId: "e4d4a7c1-9a17-4a8c-8b36-0f815d042e9a" });
  expect(mocks.getLatestJobTriageVersion).toHaveBeenCalledWith("a".repeat(43), opportunityId);
});
