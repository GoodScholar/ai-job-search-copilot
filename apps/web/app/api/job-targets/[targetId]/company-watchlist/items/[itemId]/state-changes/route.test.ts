import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ setCompanyWatchlistItemState: vi.fn(), readSessionToken: vi.fn(), rethrow: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { setCompanyWatchlistItemState: mocks.setCompanyWatchlistItemState } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.rethrow }));
import { POST } from "./route";
const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08"; const itemId = "87ccabf1-f5fe-430c-9129-df14e4789ec0";
const context = { params: Promise.resolve({ targetId, itemId }) }; const command = { expectedVersion: 1, state: "disabled" };
const overview = { target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 2, items: [{ itemId, canonicalCompanyName: "曙光云图", careersUrl: "https://careers.aurora.example/jobs", allowedDomains: ["careers.aurora.example"], sourceNote: null, state: "disabled", position: 1 }] };
afterEach(() => vi.clearAllMocks());
it("仅接受精确的启停命令并传递认证和 409", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  expect((await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...command, state: "paused" }) }), context)).status).toBe(400);
  mocks.setCompanyWatchlistItemState.mockRejectedValueOnce({ status: 409 });
  expect((await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context)).status).toBe(409);
  mocks.setCompanyWatchlistItemState.mockResolvedValue(overview);
  expect((await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context)).status).toBe(201);
  expect(mocks.setCompanyWatchlistItemState).toHaveBeenCalledWith("a".repeat(43), targetId, itemId, command);
});
