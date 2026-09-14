import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRecommendationRunPreparation: vi.fn(), getLatestRecommendationRun: vi.fn(), getRecommendationRun: vi.fn(), readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));
vi.mock("@/lib/server/api-client", () => ({ api: mocks }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));

import { getLatestRecommendationRun, getRecommendationRun, getRecommendationRunPreparation } from "./recommendation-runs";

afterEach(() => vi.clearAllMocks());

it("未登录时重定向，登录后读取推荐准备和最近运行", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(getRecommendationRunPreparation()).rejects.toThrow("redirect:/login?returnTo=%2F");
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getRecommendationRunPreparation.mockResolvedValue({ target: null });
  mocks.getLatestRecommendationRun.mockResolvedValue(null);
  await expect(getRecommendationRunPreparation()).resolves.toEqual({ target: null });
  await expect(getLatestRecommendationRun()).resolves.toBeNull();
});

it("owner-hidden 的逻辑运行只在 404 时投影为空，其他错误继续透传", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getRecommendationRun.mockRejectedValueOnce({ status: 404 }).mockRejectedValueOnce({ status: 502 });
  await expect(getRecommendationRun("4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3")).resolves.toBeNull();
  await expect(getRecommendationRun("4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3")).rejects.toEqual({ status: 502 });
});

it.each([
  ["准备", getRecommendationRunPreparation, "getRecommendationRunPreparation"],
  ["最近运行", getLatestRecommendationRun, "getLatestRecommendationRun"],
  ["指定运行", () => getRecommendationRun("4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3"), "getRecommendationRun"],
] as const)("缺少 session 时%s重定向且不调用 API", async (_label, read, apiMethod) => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(read()).rejects.toThrow("redirect:/login?returnTo=%2F");
  expect(mocks[apiMethod]).not.toHaveBeenCalled();
});

it.each([
  ["准备", getRecommendationRunPreparation, "getRecommendationRunPreparation"],
  ["最近运行", getLatestRecommendationRun, "getLatestRecommendationRun"],
  ["指定运行", () => getRecommendationRun("4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3"), "getRecommendationRun"],
] as const)("上游 401 时%s重定向", async (_label, read, apiMethod) => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks[apiMethod].mockRejectedValue({ status: 401 });
  await expect(read()).rejects.toThrow("redirect:/login?returnTo=%2F");
});
