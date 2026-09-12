import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getAccountRunControl: mocks.get } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.token }));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());

it("只从会话账户读取独立运行控制状态，并以 no-store 返回", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  mocks.get.mockResolvedValue({ stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null });

  const response = await GET();

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null });
});

it("未认证时不调用上游", async () => {
  mocks.token.mockResolvedValue(null);

  const response = await GET();
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.get).not.toHaveBeenCalled();
});

it("畸形上游读取错误安全降级为无正文 502", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  mocks.get.mockRejectedValue(new Error("upstream-secret"));

  const response = await GET();

  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
});
