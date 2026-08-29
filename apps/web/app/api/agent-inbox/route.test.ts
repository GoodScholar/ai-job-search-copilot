import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listAgentInbox: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { listAgentInbox: mocks.listAgentInbox } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());

it("缺少会话时不读取 Inbox", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(GET()).resolves.toMatchObject({ status: 401 });
  expect(mocks.listAgentInbox).not.toHaveBeenCalled();
});

it("只读取打开的 Inbox 并禁止缓存", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listAgentInbox.mockResolvedValue({ items: [] });
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({ items: [] });
  expect(mocks.listAgentInbox).toHaveBeenCalledWith("a".repeat(43), "open");
});

it("只透传安全上游状态，并折叠内部错误", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listAgentInbox
    .mockRejectedValueOnce({ status: 401 })
    .mockRejectedValueOnce({ status: 404 })
    .mockRejectedValueOnce({ status: 503, message: "Bearer secret" });
  await expect(GET()).resolves.toMatchObject({ status: 401 });
  await expect(GET()).resolves.toMatchObject({ status: 404 });
  const response = await GET();
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret");
});
