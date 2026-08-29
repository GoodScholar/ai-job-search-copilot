import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actOnAgentInboxItem: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { actOnAgentInboxItem: mocks.actOnAgentInboxItem } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { POST } from "./route";

afterEach(() => vi.clearAllMocks());
const itemId = "39d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
const command = { actionId: "59d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "dismiss" };
const context = (value: string) => ({ params: Promise.resolve({ itemId: value }) });

it("缺少会话或无效事项标识时拒绝动作且不调用上游", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(POST(new Request("http://localhost"), context(itemId))).resolves.toMatchObject({ status: 401 });
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context("not-a-uuid"))).resolves.toMatchObject({ status: 404 });
  expect(mocks.actOnAgentInboxItem).not.toHaveBeenCalled();
});

it("严格校验动作并以 no-store 转发结果", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const invalid = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...command, rawError: "secret" }) }), context(itemId));
  expect(invalid.status).toBe(400);
  const result = { applied: true, item: { itemId }, run: null };
  mocks.actOnAgentInboxItem.mockResolvedValue(result);
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context(itemId));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual(result);
  expect(mocks.actOnAgentInboxItem).toHaveBeenCalledWith("a".repeat(43), itemId, command);
});

it("只透传 400/401/404/409，其他异常不暴露", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.actOnAgentInboxItem
    .mockRejectedValueOnce({ status: 400 })
    .mockRejectedValueOnce({ status: 401 })
    .mockRejectedValueOnce({ status: 404 })
    .mockRejectedValueOnce({ status: 409 })
    .mockRejectedValueOnce({ status: 503, message: "Bearer secret internal" });
  for (const status of [400, 401, 404, 409, 502]) {
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context(itemId));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("secret");
  }
});
