import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ decideCandidateFact: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { decideCandidateFact: mocks.decideCandidateFact } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { POST } from "./route";

const factId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const context = { params: Promise.resolve({ factId }) };

afterEach(() => vi.clearAllMocks());

it("uses the HttpOnly session to proxy a candidate decision without caching", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.decideCandidateFact.mockResolvedValue({ profileId: null, version: 1, facts: [] });

  const response = await POST(new Request(`http://localhost/api/profile/candidate-facts/${factId}/decisions`, {
    method: "POST", body: JSON.stringify({ expectedVersion: 0, decision: "confirmed" }), headers: { "content-type": "application/json" },
  }), context);

  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ profileId: null, version: 1, facts: [] });
  expect(mocks.decideCandidateFact).toHaveBeenCalledWith("a".repeat(43), factId, { expectedVersion: 0, decision: "confirmed" });
});

it("does not leak an upstream profile conflict", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.decideCandidateFact.mockRejectedValue({ status: 409 });
  const response = await POST(new Request(`http://localhost/api/profile/candidate-facts/${factId}/decisions`, {
    method: "POST", body: JSON.stringify({ expectedVersion: 0, decision: "rejected" }), headers: { "content-type": "application/json" },
  }), context);
  expect(response.status).toBe(409);
  expect(await response.text()).toBe("");
});
