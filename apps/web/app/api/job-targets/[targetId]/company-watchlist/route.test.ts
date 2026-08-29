import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCompanyWatchlist: vi.fn(), readSessionToken: vi.fn(), rethrow: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getCompanyWatchlist: mocks.getCompanyWatchlist } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.rethrow }));
import { GET } from "./route";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const context = (value = targetId) => ({ params: Promise.resolve({ targetId: value }) });
const overview = { target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 0, items: [] };
afterEach(() => vi.clearAllMocks());

it("先拒绝无效目标标识，再通过会话代理经过契约验证的读取", async () => {
  const invalid = await GET(new Request("http://localhost"), context("invalid"));
  expect(invalid.status).toBe(404);
  expect(mocks.readSessionToken).not.toHaveBeenCalled();
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getCompanyWatchlist.mockResolvedValue(overview);
  const response = await GET(new Request("http://localhost"), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual(overview);
  expect(mocks.getCompanyWatchlist).toHaveBeenCalledWith("a".repeat(43), targetId);
});

it("保留安全上游状态并不泄漏内部问题", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getCompanyWatchlist.mockRejectedValue({ status: 409, message: "http://internal-api:3021 secret" });
  const response = await GET(new Request("http://localhost"), context());
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("internal-api");
});
