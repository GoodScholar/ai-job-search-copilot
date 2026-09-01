import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createJobTriageVersion: vi.fn(), getLatestJobTriageVersion: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { createJobTriageVersion: mocks.createJobTriageVersion, getLatestJobTriageVersion: mocks.getLatestJobTriageVersion } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET, POST } from "./route";

const opportunityId = "f4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";
const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";

afterEach(() => vi.clearAllMocks());

it("需要会话、严格验证目标并以 no-store 代理 triage 创建", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ targetId }) }), { params: Promise.resolve({ opportunityId }) }))
    .resolves.toMatchObject({ status: 401 });

  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ targetId, rawJobText: "不得传递" }) }), { params: Promise.resolve({ opportunityId }) }))
    .resolves.toMatchObject({ status: 400 });

  mocks.createJobTriageVersion.mockResolvedValue({ triageVersionId: "e4d4a7c1-9a17-4a8c-8b36-0f815d042e9a" });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ targetId }) }), { params: Promise.resolve({ opportunityId }) });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.createJobTriageVersion).toHaveBeenCalledWith("a".repeat(43), opportunityId, { targetId });
});

it("以 no-store 读取所有者的持久化最新版本", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getLatestJobTriageVersion.mockResolvedValue({ triageVersionId: "e4d4a7c1-9a17-4a8c-8b36-0f815d042e9a" });
  const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ opportunityId }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.getLatestJobTriageVersion).toHaveBeenCalledWith("a".repeat(43), opportunityId);
});
