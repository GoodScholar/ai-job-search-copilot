import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createApiClient } from "./api-client";

const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const response = { version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId, status: "ready", warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z", items: [{ code: "MODEL_DIAGNOSTIC_READY", severity: "informational", summary: "模型诊断已就绪", impact: "当前模型诊断显示可安全使用。", retryable: false, suggestedActions: [], evidence: { kind: "model_diagnostic", status: "available", checkedAt: "2026-09-05T00:00:00.000Z" } }] };

it("读取预检时对运行时特殊字符 targetId 编码，并严格校验成功响应", async () => {
  const untrustedTargetId = "target?&=#%";
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  await expect(api.getRunPreflight("a".repeat(43), untrustedTargetId)).resolves.toEqual(response);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3021/v1/run-preflight?workflow=discovery&trigger=manual&targetId=target%3F%26%3D%23%25");
});

it("预检 client 区分认证失败、畸形成功响应与网络错误", async () => {
  const unauthorized = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "AUTH_REQUIRED", message: "登录已失效" }), { status: 401 })) });
  const malformed = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...response, rawPayload: "secret" }), { status: 200 })) });
  const network = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")) });

  await expect(unauthorized.getRunPreflight("a".repeat(43))).rejects.toMatchObject({ kind: "api", status: 401 });
  await expect(malformed.getRunPreflight("a".repeat(43))).rejects.toMatchObject({ kind: "invalid_response", status: 200 });
  await expect(network.getRunPreflight("a".repeat(43))).rejects.toMatchObject({ kind: "network" });
});

it("仅将严格预检 409 作为可信冲突交给调用方", async () => {
  const preflight = {
    version: "run-preflight-v1", workflow: "deep_match", trigger: "manual", targetId,
    status: "blocked", warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z",
    items: [{ code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: "缺少主求职目标", impact: "请先创建主求职目标。", retryable: false, suggestedActions: ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: "2026-09-05T00:00:00.000Z" } }],
  };
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "RUN_PREFLIGHT_BLOCKED", message: "运行前检查未通过", requestId: "00000000-0000-4000-0000-000000000001", preflight }), { status: 409 })) });

  await expect(api.startDeepMatchRun("a".repeat(43), targetId, "00000000-0000-4000-0000-000000000002", "00000000-0000-4000-0000-000000000003")).rejects.toMatchObject({ kind: "api", status: 409, problem: { code: "RUN_PREFLIGHT_BLOCKED", preflight } });
});
