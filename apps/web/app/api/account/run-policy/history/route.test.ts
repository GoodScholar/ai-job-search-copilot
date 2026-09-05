import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ history: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getAccountRunPolicyHistory: mocks.history } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.token }));
import { GET } from "./route";
it("只将认证账户的严格历史转发给浏览器", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  mocks.history.mockResolvedValue({ revisions: [] });
  const response = await GET();
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ revisions: [] });
});
