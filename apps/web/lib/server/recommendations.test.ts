import { afterEach, expect, it, vi } from "vitest";
import { RecommendationListSchema } from "@job-copilot/contracts/recommendations";

const mocks = vi.hoisted(() => ({ readSessionToken: vi.fn(), getLatestRecommendations: vi.fn(), getRecommendationList: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: mocks }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("server-only", () => ({}));

import { getRecommendationList } from "./recommendations";

afterEach(() => vi.clearAllMocks());

const exactList = RecommendationListSchema.parse({ recommendationListId: "00000000-0000-4000-8000-000000000002", targetId: "00000000-0000-4000-8000-000000000001", localDate: "2026-09-14", sequence: 1, createdAt: "2026-09-14T00:00:00.000Z", exclusions: [], items: [] });

it("精确清单读取将 owner/target/list 三元组交给 API，404 不回退为最新清单", async () => {
  const targetId = "00000000-0000-4000-8000-000000000001";
  const listId = "00000000-0000-4000-8000-000000000002";
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getRecommendationList.mockRejectedValue({ status: 404 });
  mocks.getLatestRecommendations.mockResolvedValue(RecommendationListSchema.parse({ ...exactList, recommendationListId: "00000000-0000-4000-8000-000000000003" }));

  await expect(getRecommendationList(targetId, listId)).rejects.toEqual({ status: 404 });
  expect(mocks.getRecommendationList).toHaveBeenCalledWith("a".repeat(43), targetId, listId);
  expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
});

it("精确清单读取返回 API 的完整不可变清单；未登录只投影为空", async () => {
  mocks.readSessionToken.mockResolvedValueOnce("a".repeat(43)).mockResolvedValueOnce(null);
  mocks.getRecommendationList.mockResolvedValue(exactList);
  await expect(getRecommendationList(exactList.targetId, exactList.recommendationListId)).resolves.toEqual(exactList);
  await expect(getRecommendationList(exactList.targetId, exactList.recommendationListId)).resolves.toBeNull();
  expect(mocks.getRecommendationList).toHaveBeenCalledTimes(1);
  expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
});

it("精确清单读取透传非 404 失败且不调用最新清单", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getRecommendationList.mockRejectedValue({ status: 502 });
  await expect(getRecommendationList(exactList.targetId, exactList.recommendationListId)).rejects.toEqual({ status: 502 });
  expect(mocks.getLatestRecommendations).not.toHaveBeenCalled();
});
