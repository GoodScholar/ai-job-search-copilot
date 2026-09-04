import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listAgentInbox: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { listAgentInbox: mocks.listAgentInbox } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());
const get = (status?: string) => (GET as unknown as (request: Request) => Promise<Response>)(new Request(`http://localhost/api/agent-inbox${status === undefined ? "" : `?status=${status}`}`));

it("缺少会话时不读取 Inbox", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(get()).resolves.toMatchObject({ status: 401 });
  expect(mocks.listAgentInbox).not.toHaveBeenCalled();
});

it.each(["pending", "unread", "read", "resolved"] as const)("校验并透传 %s Inbox 状态且禁止缓存", async (status) => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listAgentInbox.mockResolvedValue({ items: [] });
  const response = await get(status);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({ items: [] });
  expect(mocks.listAgentInbox).toHaveBeenCalledWith("a".repeat(43), status);
});

it("省略状态时默认读取待处理 Inbox", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listAgentInbox.mockResolvedValue({ items: [] });
  await expect(get()).resolves.toMatchObject({ status: 200 });
  expect(mocks.listAgentInbox).toHaveBeenCalledWith("a".repeat(43), "pending");
});

it("拒绝非法 Inbox 状态且不读取上游", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(get("open")).resolves.toMatchObject({ status: 400 });
  expect(mocks.listAgentInbox).not.toHaveBeenCalled();
});

it("只透传安全上游状态，并折叠内部错误", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listAgentInbox
    .mockRejectedValueOnce({ status: 401 })
    .mockRejectedValueOnce({ status: 404 })
    .mockRejectedValueOnce({ status: 503, message: "Bearer secret" });
  await expect(get()).resolves.toMatchObject({ status: 401 });
  await expect(get()).resolves.toMatchObject({ status: 404 });
  const response = await get();
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret");
});
