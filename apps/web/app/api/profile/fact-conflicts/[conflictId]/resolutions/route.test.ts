import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveCareerFactConflict: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { resolveCareerFactConflict: mocks.resolveCareerFactConflict } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { POST } from "./route";

const conflictId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const context = { params: Promise.resolve({ conflictId }) };
const resolved = {
  profile: { profileId: null, version: 1, facts: [] },
  conflict: { conflictId, kind: "date", status: "resolved", resolution: "use_existing", profileVersion: 1, resolvedAt: "2026-08-27T08:00:00.000Z" },
};

afterEach(() => vi.clearAllMocks());

it("以 HttpOnly 会话转发严格的冲突解决命令且不缓存", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.resolveCareerFactConflict.mockResolvedValue(resolved);
  const response = await POST(new Request(`http://localhost/api/profile/fact-conflicts/${conflictId}/resolutions`, {
    method: "POST", body: JSON.stringify({ expectedVersion: 0, resolution: "use_existing" }), headers: { "content-type": "application/json" },
  }), context);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(resolved);
  expect(mocks.resolveCareerFactConflict).toHaveBeenCalledWith("a".repeat(43), conflictId, { expectedVersion: 0, resolution: "use_existing" });
});

it.each([
  ["缺少会话", undefined, context, { expectedVersion: 0, resolution: "use_existing" }, 401],
  ["非法 UUID", "a".repeat(43), { params: Promise.resolve({ conflictId: "not-a-uuid" }) }, { expectedVersion: 0, resolution: "use_existing" }, 404],
  ["非法请求体", "a".repeat(43), context, { expectedVersion: -1, resolution: "other" }, 400],
])("稳定拒绝%s", async (_label, token, requestContext, body, status) => {
  mocks.readSessionToken.mockResolvedValue(token);
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }), requestContext);
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
});

it.each([400, 404, 409, 401])("透传允许的上游状态 %i 且不泄露内容", async (status) => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.resolveCareerFactConflict.mockRejectedValue({ status, message: "敏感上游文本" });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ expectedVersion: 0, resolution: "keep_both" }) }), context);
  expect(response.status).toBe(status);
  expect(await response.text()).toBe("");
});

it("将未知上游错误映射为不泄露详情的 502", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.resolveCareerFactConflict.mockRejectedValue(new Error("敏感事实正文"));
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ expectedVersion: 0, resolution: "keep_both" }) }), context);
  expect(response.status).toBe(502);
  expect(await response.text()).toBe("");
});
