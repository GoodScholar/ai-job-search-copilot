import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ reorderCompanyWatchlist: vi.fn(), readSessionToken: vi.fn(), rethrow: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { reorderCompanyWatchlist: mocks.reorderCompanyWatchlist } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.rethrow }));
import { POST } from "./route";
const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08"; const itemId = "87ccabf1-f5fe-430c-9129-df14e4789ec0";
const context = { params: Promise.resolve({ targetId }) }; const command = { expectedVersion: 1, orderedItemIds: [itemId] };
const overview = { target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 2, items: [{ itemId, canonicalCompanyName: "曙光云图", careersUrl: "https://careers.aurora.example/jobs", allowedDomains: ["careers.aurora.example"], sourceNote: null, state: "enabled", position: 1 }] };
afterEach(() => vi.clearAllMocks());
it("仅接受完整 UUID 排列命令并通过会话转发排序", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  expect((await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ expectedVersion: 1, orderedItemIds: ["invalid"] }) }), context)).status).toBe(400);
  mocks.reorderCompanyWatchlist.mockResolvedValue(overview);
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context);
  expect(response.status).toBe(201); expect(mocks.reorderCompanyWatchlist).toHaveBeenCalledWith("a".repeat(43), targetId, command);
});

it("在 API 边界将空排序稳定拒绝为 400，且不转发领域命令", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));

  const response = await POST(new Request("http://localhost", {
    method: "POST", body: JSON.stringify({ expectedVersion: 0, orderedItemIds: [] }),
  }), context);

  expect(response.status).toBe(400);
  expect(mocks.reorderCompanyWatchlist).not.toHaveBeenCalled();
});
