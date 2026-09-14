import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ readSessionToken: vi.fn(), getRecommendationRunPreparation: vi.fn() }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("@/lib/server/api-client", () => ({ api: { getRecommendationRunPreparation: mocks.getRecommendationRunPreparation } }));
import { GET } from "./route";
afterEach(() => vi.clearAllMocks());
it("preparation 代理成功、401 与未知上游，并始终 no-store", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43)); mocks.getRecommendationRunPreparation.mockResolvedValue({ target: null });
  const success = await GET(); expect(success.status).toBe(200); expect(await success.json()).toEqual({ target: null }); expect(mocks.getRecommendationRunPreparation).toHaveBeenCalledWith("a".repeat(43));
  mocks.getRecommendationRunPreparation.mockRejectedValue({ status: 401 }); const unauthorized = await GET(); expect(unauthorized.status).toBe(401);
  mocks.getRecommendationRunPreparation.mockRejectedValue({ status: 200, kind: "invalid_response" }); const unknown = await GET(); expect(unknown.status).toBe(502); expect(await unknown.text()).toBe("");
  mocks.getRecommendationRunPreparation.mockRejectedValue(new Error("unknown")); const ordinaryUnknown = await GET(); expect(ordinaryUnknown.status).toBe(502); expect(await ordinaryUnknown.text()).toBe(""); expect(ordinaryUnknown.headers.get("cache-control")).toBe("no-store");
  mocks.readSessionToken.mockResolvedValue(null); const localUnauthorized = await GET(); expect(localUnauthorized.status).toBe(401);
  for (const response of [success, unauthorized, unknown, localUnauthorized]) expect(response.headers.get("cache-control")).toBe("no-store");
});
