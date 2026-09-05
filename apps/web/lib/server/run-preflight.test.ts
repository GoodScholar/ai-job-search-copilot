import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createApiClient } from "./api-client";

const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const response = { version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId, status: "ready", warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z", items: [{ code: "MODEL_DIAGNOSTIC_READY", severity: "informational", summary: "模型诊断已就绪", impact: "当前模型诊断显示可安全使用。", retryable: false, suggestedActions: [], evidence: { kind: "model_diagnostic", status: "available", checkedAt: "2026-09-05T00:00:00.000Z" } }] };

it("读取预检时编码 targetId，并严格校验成功响应", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  await expect(api.getRunPreflight("a".repeat(43), targetId)).resolves.toEqual(response);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:3021/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${encodeURIComponent(targetId)}`);
});
