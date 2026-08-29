import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJobDiscoverySchedule: vi.fn(),
  setJobDiscoverySchedule: vi.fn(),
  readSessionToken: vi.fn(),
}));
vi.mock("@/lib/server/api-client", () => ({ api: {
  getJobDiscoverySchedule: mocks.getJobDiscoverySchedule,
  setJobDiscoverySchedule: mocks.setJobDiscoverySchedule,
} }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET, PUT } from "./route";

afterEach(() => vi.clearAllMocks());
const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const schedule = {
  schedule: null,
  sourceSupport: { status: "policy_required", message: "需允许 boards-api.greenhouse.io" },
} as const;
const context = (id = targetId) => ({ params: Promise.resolve({ targetId: id }) });

it("要求 HttpOnly 会话，并严格校验目标和请求体", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(GET(new Request("http://localhost"), context())).resolves.toMatchObject({ status: 401 });
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ expectedVersion: 0, state: "enabled", dailyTime: "09:30", timeZone: "Asia/Shanghai" }) }), context())).resolves.toMatchObject({ status: 400 });
  await expect(GET(new Request("http://localhost"), context("not-a-uuid"))).resolves.toMatchObject({ status: 404 });
  expect(mocks.getJobDiscoverySchedule).not.toHaveBeenCalled();
});

it("以 Bearer session 代理严格的无缓存计划响应与 CAS 状态", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getJobDiscoverySchedule.mockResolvedValue(schedule);
  const get = await GET(new Request("http://localhost"), context());
  expect(get.status).toBe(200);
  expect(get.headers.get("cache-control")).toBe("no-store");
  expect(await get.json()).toEqual(schedule);
  expect(mocks.getJobDiscoverySchedule).toHaveBeenCalledWith("a".repeat(43), targetId);

  mocks.setJobDiscoverySchedule.mockRejectedValue({ status: 409, message: "private source", problem: { code: "SOURCE_POLICY_REQUIRED", message: "private source https://secret.test" } });
  const put = await PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ expectedVersion: 0, state: "enabled", dailyTime: "09:30" }) }), context());
  expect(put.status).toBe(409);
  expect(await put.json()).toEqual({ code: "SOURCE_POLICY_REQUIRED" });
});
