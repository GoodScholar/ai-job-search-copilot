import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getSourceCapabilities: vi.fn(), readSessionToken: vi.fn(), redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }) }));
vi.mock("@/lib/server/api-client", () => ({ api: { getSourceCapabilities: mocks.getSourceCapabilities } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("server-only", () => ({}));
import { getSourceCapabilities } from "./source-capabilities";
const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
afterEach(() => vi.clearAllMocks());
it("服务器能力查询绑定会话并保留认证重定向", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(getSourceCapabilities(targetId)).rejects.toThrow("redirect:/login?returnTo=");
  mocks.readSessionToken.mockResolvedValue("a".repeat(43)); mocks.getSourceCapabilities.mockResolvedValue({ targetId, watchlistVersion: 0, sources: [] });
  await expect(getSourceCapabilities(targetId)).resolves.toMatchObject({ targetId });
});
