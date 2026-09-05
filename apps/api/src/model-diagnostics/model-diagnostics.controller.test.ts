import { describe, expect, it } from "vitest";
import { ModelDiagnosticsController } from "./model-diagnostics.controller";

const response = {
  status: "available" as const, checks: { authentication: "passed" as const, modelAvailability: "passed" as const, structuredOutput: "passed" as const, timeout: "passed" as const }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE" as const,
  reasonSummary: "模型连接正常", impact: "两档业务模型可以执行受限诊断。", suggestedActions: [], checkedAt: "2026-09-05T00:00:00.000Z", latencyBucket: "under_1s" as const, retryAt: null,
};

describe("模型连接诊断控制器", () => {
  const controller = (get = async () => response, run = async () => response) => new ModelDiagnosticsController({ get, run });
  const reply = () => ({ headers: [] as string[], header(name: string, value: string) { this.headers.push(`${name}:${value}`); } });

  it("GET 和 POST 仅返回安全投影并明确禁用缓存", async () => {
    const getReply = reply(); const postReply = reply();
    await expect(controller().get(getReply as never)).resolves.toEqual(response);
    await expect(controller().run(postReply as never, {})).resolves.toEqual(response);
    expect([getReply.headers, postReply.headers]).toEqual([["Cache-Control:no-store"], ["Cache-Control:no-store"]]);
    expect(Object.keys(response)).not.toEqual(expect.arrayContaining(["configurationFingerprint", "apiKey", "providerResponse", "organization", "project", "model"]));
  });

  it("POST 仅接受没有键的空对象", async () => {
    await expect(controller().run(reply() as never, { unexpected: "input" })).rejects.toMatchObject({ status: 400 });
  });
});
