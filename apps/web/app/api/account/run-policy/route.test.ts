import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), token: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/api-client", () => ({ api: { getAccountRunPolicy: mocks.get, saveAccountRunPolicy: mocks.save } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.token }));
import { GET, PUT } from "./route";

const settings = { discovery: { trustedSourceLimit: 50, publicQueryLimit: 5, verificationCandidateLimit: 10, enabledProviders: ["anysearch"] }, budgets: { publicDiscovery: { maxActiveDurationMs: 180000, maxAttempts: 3, maxToolCalls: 60, maxResults: 5, maxModelCalls: 0, maxTokens: 0 }, deepMatch: { maxActiveDurationMs: 180000, maxAttempts: 3, maxToolCalls: 0, maxResults: 10, maxModelCalls: 10, maxTokens: 20000 }, fake: { maxActiveDurationMs: 60000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 } }, backgroundWindow: { start: "08:00", end: "22:00", timeZone: "Asia/Shanghai" } } as const;
const response = { revision: { revisionNumber: 0, isSystemBaseline: true, createdAt: "1970-01-01T00:00:00.000Z", settings }, system: { defaults: settings, hardLimits: { discovery: { ...settings.discovery, publicQueryLimit: 10 }, budgets: settings.budgets, backgroundWindow: { timeZone: "Asia/Shanghai", allowsAllDay: true } } }, userSettings: null, effective: settings };
afterEach(() => vi.clearAllMocks());

it("仅代理认证账户，并安全透传已知策略问题体", async () => {
  mocks.token.mockResolvedValue(null);
  await expect(GET()).resolves.toMatchObject({ status: 401 });
  mocks.token.mockResolvedValue("a".repeat(43));
  mocks.get.mockResolvedValue(response);
  expect(await (await GET()).json()).toEqual(response);
  mocks.save.mockRejectedValue({ status: 400, problem: { code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", message: "安全中文说明", issues: [{ reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", path: ["settings", "discovery", "publicQueryLimit"], maximum: 10, suggestedAction: "reduce_to_system_hard_limit" }] } });
  const put = await PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ expectedVersion: 0, settings }) }));
  expect(put.status).toBe(400);
  expect(await put.json()).toEqual({ code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", message: "安全中文说明", issues: [{ reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", path: ["settings", "discovery", "publicQueryLimit"], maximum: 10, suggestedAction: "reduce_to_system_hard_limit" }] });
});

it("遮蔽未知上游问题和无效请求", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  mocks.save.mockRejectedValue({ status: 409, problem: { code: "PRIVATE", message: "secret" } });
  const unknown = await PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ expectedVersion: 0, settings }) }));
  expect(unknown.status).toBe(502);
  expect(await unknown.text()).toBe("");
  await expect(PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ userId: "not-allowed" }) }))).resolves.toMatchObject({ status: 400 });
});

it("本地策略硬上限和空窗口返回可安全投影的问题体", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  const tooHigh = { ...settings, discovery: { ...settings.discovery, publicQueryLimit: 11 } };
  const hard = await PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ expectedVersion: 0, settings: tooHigh }) }));
  expect(hard.status).toBe(400);
  expect(await hard.json()).toEqual({
    code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", message: "运行策略超过系统硬上限",
    issues: [{ reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", path: ["settings", "discovery", "publicQueryLimit"], maximum: 10, suggestedAction: "reduce_to_system_hard_limit" }],
  });
  const emptyWindow = { ...settings, backgroundWindow: { ...settings.backgroundWindow, end: settings.backgroundWindow.start } };
  const window = await PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ expectedVersion: 0, settings: emptyWindow }) }));
  expect(window.status).toBe(400);
  expect(await window.json()).toEqual({
    code: "ACCOUNT_RUN_POLICY_BACKGROUND_WINDOW_INVALID", message: "后台运行时间窗口无效",
    issues: [{ reasonCode: "ACCOUNT_RUN_POLICY_BACKGROUND_WINDOW_INVALID", path: ["settings", "backgroundWindow", "end"], maximum: null, suggestedAction: "choose_a_non_empty_background_window" }],
  });
  expect(mocks.save).not.toHaveBeenCalled();
});

it("经真实 API 客户端解析后仍安全透传上游策略问题", async () => {
  mocks.token.mockResolvedValue("a".repeat(43));
  const { createApiClient } = await vi.importActual<typeof import("@/lib/server/api-client")>("@/lib/server/api-client");
  const client = createApiClient({
    apiInternalUrl: "http://api.internal", devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", message: "运行策略超过系统硬上限", requestId: "00000000-0000-4000-8000-000000000001",
      issues: [{ reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", path: ["settings", "discovery", "publicQueryLimit"], maximum: 10, suggestedAction: "reduce_to_system_hard_limit" }],
    }), { status: 400, headers: { "content-type": "application/json" } })),
  });
  mocks.save.mockImplementation((token, command) => client.saveAccountRunPolicy(token, command));
  const result = await PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ expectedVersion: 0, settings }) }));
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({
    code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", message: "运行策略超过系统硬上限",
    issues: [{ reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", path: ["settings", "discovery", "publicQueryLimit"], maximum: 10, suggestedAction: "reduce_to_system_hard_limit" }],
  });
});
