import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ update: vi.fn(), readSessionToken: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/api-client", () => ({ api: { updateFirstRecommendationJourneyInteraction: mocks.update } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { PUT } from "./route";

const sessionToken = "a".repeat(43);
const command = { action: "visit_step" as const, stepId: "career_materials" as const, expectedVersion: 0 };
const interaction = { version: 1, dismissedAt: null, lastVisitedStep: "career_materials" };

afterEach(() => vi.clearAllMocks());

it("只以 HttpOnly 会话代理严格的首次推荐旅程交互，并禁用缓存", async () => {
  mocks.readSessionToken.mockResolvedValue(sessionToken);
  mocks.update.mockResolvedValue(interaction);

  const response = await PUT(new Request("http://localhost/api/workbench/first-recommendation-journey", {
    method: "PUT", body: JSON.stringify(command),
  }));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(interaction);
  expect(mocks.update).toHaveBeenCalledWith(sessionToken, command);
});

it("在读取会话或严格校验请求失败时拒绝请求且不调用上游", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  const missingSession = await PUT(new Request("http://localhost/api/workbench/first-recommendation-journey", {
    method: "PUT", body: JSON.stringify(command),
  }));
  expect(missingSession.status).toBe(401);
  expect(missingSession.headers.get("cache-control")).toBe("no-store");

  mocks.readSessionToken.mockResolvedValue(sessionToken);
  for (const body of ["{", JSON.stringify({ ...command, userId: "00000000-0000-4000-8000-000000000001" })]) {
    const response = await PUT(new Request("http://localhost/api/workbench/first-recommendation-journey", { method: "PUT", body }));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(mocks.update).not.toHaveBeenCalled();
});

it.each([401, 404, 409])("仅收窄透传上游的 %i 状态", async (status) => {
  mocks.readSessionToken.mockResolvedValue(sessionToken);
  mocks.update.mockRejectedValue({ status, upstreamBody: "do-not-leak" });

  const response = await PUT(new Request("http://localhost/api/workbench/first-recommendation-journey", {
    method: "PUT", body: JSON.stringify(command),
  }));

  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
});

it("将网络、未知上游错误和非法成功体收窄为不泄密的 502", async () => {
  mocks.readSessionToken.mockResolvedValue(sessionToken);
  for (const failure of [new Error("upstream secret"), { status: 500, upstreamBody: "upstream secret" }, { status: 200, kind: "invalid_response" }]) {
    mocks.update.mockRejectedValueOnce(failure);
    const response = await PUT(new Request("http://localhost/api/workbench/first-recommendation-journey", {
      method: "PUT", body: JSON.stringify(command),
    }));
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  }

  mocks.update.mockResolvedValue({ version: 1, dismissedAt: null, lastVisitedStep: "career_materials", unexpected: true });
  const invalidSuccess = await PUT(new Request("http://localhost/api/workbench/first-recommendation-journey", {
    method: "PUT", body: JSON.stringify(command),
  }));
  expect(invalidSuccess.status).toBe(502);
  expect(invalidSuccess.headers.get("cache-control")).toBe("no-store");
  expect(await invalidSuccess.text()).toBe("");
});
