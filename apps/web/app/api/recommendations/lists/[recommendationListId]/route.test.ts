import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getRecommendationList: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getRecommendationList: mocks.getRecommendationList } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
import { GET } from "./route";
afterEach(() => vi.clearAllMocks());
const listId = "00000000-0000-4000-8000-000000000001"; const targetId = "00000000-0000-4000-8000-000000000002";
it("精确清单路由要求 targetId 且不回退 latest", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(GET(new Request("http://localhost/api/recommendations/lists/x"), { params: Promise.resolve({ recommendationListId: listId }) })).resolves.toMatchObject({ status: 400 });
  mocks.getRecommendationList.mockRejectedValue({ status: 404, message: "secret" });
  const response = await GET(new Request(`http://localhost/api/recommendations/lists/${listId}?targetId=${targetId}`), { params: Promise.resolve({ recommendationListId: listId }) });
  expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store"); expect(mocks.getRecommendationList).toHaveBeenCalledWith("a".repeat(43), targetId, listId);
});
it("精确清单代理成功、401 与未知上游，并保持 no-store", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43)); mocks.getRecommendationList.mockResolvedValue({ recommendationListId: listId });
  const success = await GET(new Request(`http://localhost/api/recommendations/lists/${listId}?targetId=${targetId}`), { params: Promise.resolve({ recommendationListId: listId }) }); expect(success.status).toBe(200); expect(await success.json()).toEqual({ recommendationListId: listId });
  mocks.getRecommendationList.mockRejectedValue({ status: 401 }); const unauthorized = await GET(new Request(`http://localhost/api/recommendations/lists/${listId}?targetId=${targetId}`), { params: Promise.resolve({ recommendationListId: listId }) });
  mocks.getRecommendationList.mockRejectedValue({ status: 200, kind: "invalid_response" }); const unknown = await GET(new Request(`http://localhost/api/recommendations/lists/${listId}?targetId=${targetId}`), { params: Promise.resolve({ recommendationListId: listId }) });
  mocks.readSessionToken.mockResolvedValue(null); const localUnauthorized = await GET(new Request(`http://localhost/api/recommendations/lists/${listId}?targetId=${targetId}`), { params: Promise.resolve({ recommendationListId: listId }) });
  expect([unauthorized.status, unknown.status, localUnauthorized.status]).toEqual([401, 502, 401]); for (const response of [success, unauthorized, unknown, localUnauthorized]) expect(response.headers.get("cache-control")).toBe("no-store");
});
