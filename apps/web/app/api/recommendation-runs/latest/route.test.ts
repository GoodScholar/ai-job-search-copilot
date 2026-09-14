import { expect, it, vi } from "vitest"; vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: vi.fn().mockResolvedValue(null) })); vi.mock("@/lib/server/api-client", () => ({ api: {} })); import { GET } from "./route";
it("latest 未认证响应 no-store", async () => { const r = await GET(); expect(r.status).toBe(401); expect(r.headers.get("cache-control")).toBe("no-store"); });
