import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSourceHealth: vi.fn(), readSessionToken: vi.fn(), rethrow: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getSourceHealth: mocks.getSourceHealth } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.rethrow }));

import { GET } from "./route";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const context = (value = targetId) => ({ params: Promise.resolve({ targetId: value }) });
const overview = { targetId, watchlistVersion: 0, sources: [] };

afterEach(() => vi.clearAllMocks());

it("在 BFF 边界拒绝无效路径和未认证请求，并以 no-store 代理严格健康概览", async () => {
  expect((await GET(new Request("http://localhost"), context("invalid"))).status).toBe(404);
  mocks.readSessionToken.mockResolvedValue(null);
  expect((await GET(new Request("http://localhost"), context())).status).toBe(401);
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getSourceHealth.mockResolvedValue(overview);
  const response = await GET(new Request("http://localhost"), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual(overview);
  expect(mocks.getSourceHealth).toHaveBeenCalledWith("a".repeat(43), targetId);
});

it("不把上游内部错误泄漏给浏览器，并保留安全 404", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getSourceHealth.mockRejectedValue({ status: 404, message: "http://internal-api:3021 secret" });
  const response = await GET(new Request("http://localhost"), context());
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("internal-api");
});
