import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSourceCapabilities: vi.fn(), readSessionToken: vi.fn(), rethrow: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getSourceCapabilities: mocks.getSourceCapabilities } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.rethrow }));
import { GET } from "./route";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const context = (value = targetId) => ({ params: Promise.resolve({ targetId: value }) });
const overview = { targetId, watchlistVersion: 0, sources: [] };
afterEach(() => vi.clearAllMocks());

it("BFF 只代理严格的 owner-bound 能力投影", async () => {
  expect((await GET(new Request("http://localhost"), context("invalid"))).status).toBe(404);
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getSourceCapabilities.mockResolvedValue(overview);
  const response = await GET(new Request("http://localhost"), context());
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual(overview);
  expect(mocks.getSourceCapabilities).toHaveBeenCalledWith("a".repeat(43), targetId);
  mocks.getSourceCapabilities.mockResolvedValue({ ...overview, leaked: true });
  expect((await GET(new Request("http://localhost"), context())).status).toBe(502);
});
