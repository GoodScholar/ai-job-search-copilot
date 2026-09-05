import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getRunPreflight: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getRunPreflight: mocks.getRunPreflight } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
import { GET } from "./route";

afterEach(() => vi.clearAllMocks());
it("BFF 仅接受 targetId，固定 discovery/manual 并禁用缓存", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getRunPreflight.mockResolvedValue({ version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3", status: "ready", warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z", items: [] });
  const response = await GET(new Request("http://localhost/api/run-preflight?targetId=4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.getRunPreflight).toHaveBeenCalledWith("a".repeat(43), "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3");
});
