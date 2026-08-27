import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createProfileFact: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { createProfileFact: mocks.createProfileFact } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { POST } from "./route";

afterEach(() => vi.clearAllMocks());

it("uses the HttpOnly session to create a manual profile fact without caching", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createProfileFact.mockResolvedValue({ profileId: null, version: 1, facts: [] });
  const command = { expectedVersion: 0, factType: "work_eligibility", factValue: { summary: "可在中国大陆工作" } };

  const response = await POST(new Request("http://localhost/api/profile/facts", {
    method: "POST", body: JSON.stringify(command), headers: { "content-type": "application/json" },
  }));

  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.createProfileFact).toHaveBeenCalledWith("a".repeat(43), command);
});
