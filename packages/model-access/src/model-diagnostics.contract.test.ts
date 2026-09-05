import { describe, expect, it, vi } from "vitest";
import type { ModelDiagnosticProbeResult } from "@job-copilot/contracts/model-diagnostics";
import { createOpenAiModelDiagnosticAdapter } from "./index";
import {
  createFakeModelDiagnosticAdapter,
  createOpenAiModelDiagnosticAdapterForTest,
  type ModelDiagnosticFakeScenario,
  type ModelDiagnosticTestTransport,
} from "./testing";

const configuration = {
  apiKey: "sk-test-model-diagnostics",
  endpoint: "https://openai.example.test/v1",
  organization: "org_diagnostic",
  project: "proj_diagnostic",
} as const;

const available: ModelDiagnosticProbeResult = {
  status: "available",
  checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" },
  reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE",
  latencyBucket: "under_1s",
};

const expectedByScenario: Record<ModelDiagnosticFakeScenario["kind"], ModelDiagnosticProbeResult> = {
  success: available,
  authentication_failed: {
    status: "failed",
    checks: { authentication: "failed", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" },
    reasonCode: "MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED",
    latencyBucket: "under_1s",
  },
  access_restricted: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_ACCESS_RESTRICTED",
    latencyBucket: "under_1s",
  },
  low_cost_model_unavailable: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "failed", structuredOutput: "not_verified", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE",
    latencyBucket: "under_1s",
  },
  high_quality_model_unavailable: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "failed", structuredOutput: "not_verified", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_HIGH_QUALITY_MODEL_UNAVAILABLE",
    latencyBucket: "under_1s",
  },
  strict_output_unsupported: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "failed", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED",
    latencyBucket: "under_1s",
  },
  incomplete: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "failed", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED",
    latencyBucket: "under_1s",
  },
  refusal: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "failed", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED",
    latencyBucket: "under_1s",
  },
  queued: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "failed", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED",
    latencyBucket: "under_1s",
  },
  in_progress: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "failed", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED",
    latencyBucket: "under_1s",
  },
  malformed_output: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "failed", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED",
    latencyBucket: "under_1s",
  },
  missing_output: {
    status: "failed",
    checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "failed", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED",
    latencyBucket: "under_1s",
  },
  timeout: {
    status: "temporarily_unavailable",
    checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "failed" },
    reasonCode: "MODEL_DIAGNOSTIC_TIMEOUT",
    latencyBucket: "timeout",
  },
  rate_limited: {
    status: "temporarily_unavailable",
    checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_RATE_LIMITED",
    latencyBucket: "under_1s",
  },
  provider_unavailable: {
    status: "temporarily_unavailable",
    checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE",
    latencyBucket: "under_1s",
  },
  generic_failure: {
    status: "failed",
    checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_FAILED",
    latencyBucket: "under_1s",
  },
  generic_redirect: {
    status: "failed",
    checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "passed" },
    reasonCode: "MODEL_DIAGNOSTIC_FAILED",
    latencyBucket: "under_1s",
  },
};

function completedWireResponse(content: unknown): Response {
  return Response.json({ status: "completed", output: [{ type: "message", content: [content] }] });
}

function responseFor(scenario: ModelDiagnosticFakeScenario, model: string): Response {
  if (scenario.kind === "authentication_failed") return new Response("provider body must not escape", { status: 401 });
  if (scenario.kind === "access_restricted") return new Response("provider body must not escape", { status: 403 });
  if (scenario.kind === "low_cost_model_unavailable" && model === "gpt-5.6-luna") return new Response("provider body must not escape", { status: 404 });
  if (scenario.kind === "high_quality_model_unavailable" && model === "gpt-5.6-terra") return new Response("provider body must not escape", { status: 404 });
  if (scenario.kind === "timeout") return new Response("provider body must not escape", { status: 408 });
  if (scenario.kind === "rate_limited") return new Response("provider body must not escape", { status: 429 });
  if (scenario.kind === "provider_unavailable") return new Response("provider body must not escape", { status: 503 });
  if (scenario.kind === "generic_failure") return new Response("provider body must not escape", { status: 418 });
  if (scenario.kind === "generic_redirect") return new Response("provider body must not escape", { status: 302 });
  if (scenario.kind === "incomplete") return Response.json({ status: "incomplete", output: [] });
  if (scenario.kind === "refusal") return completedWireResponse({ type: "refusal", refusal: "no" });
  if (scenario.kind === "queued") return Response.json({ status: "queued", output: [] });
  if (scenario.kind === "in_progress") return Response.json({ status: "in_progress", output: [] });
  if (scenario.kind === "strict_output_unsupported") return completedWireResponse({ type: "output_text", text: "{\"probe\":\"wrong\"}" });
  if (scenario.kind === "malformed_output") return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{\"probe\":\"ok\"}" }, { type: "output_text", text: "{\"probe\":\"ok\"}" }] }] });
  if (scenario.kind === "missing_output") return Response.json({ status: "completed", output_text: "{\"probe\":\"ok\"}" });
  return completedWireResponse({ type: "output_text", text: "{\"probe\":\"ok\"}" });
}

function controlledTransport(scenario: ModelDiagnosticFakeScenario, calls: Array<{ url: string; init: RequestInit }>): ModelDiagnosticTestTransport {
  return async ({ url, init }) => {
    calls.push({ url, init });
    const body = JSON.parse(String(init.body)) as { model: string };
    return responseFor(scenario, body.model);
  };
}

describe("OpenAI 模型诊断 adapter", () => {
  it.each(Object.entries(expectedByScenario))("对 %s 以相同稳定结果聚合受控 transport 与 Fake", async (kind, expected) => {
    const scenario = { kind } as ModelDiagnosticFakeScenario;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const productionShape = createOpenAiModelDiagnosticAdapterForTest(configuration, controlledTransport(scenario, calls));
    const fake = createFakeModelDiagnosticAdapter(scenario);

    await expect(productionShape.diagnose({ signal: new AbortController().signal })).resolves.toEqual(expected);
    await expect(fake.diagnose({ signal: new AbortController().signal })).resolves.toEqual(expected);
    expect(calls).toHaveLength(2);
  });

  it("为两档模型仅发送无个人数据的固定严格 Responses 请求", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, controlledTransport({ kind: "success" }, calls));

    await expect(adapter.diagnose({ signal: new AbortController().signal })).resolves.toEqual(available);
    expect(calls.map((call) => call.url)).toEqual(["https://openai.example.test/v1/responses", "https://openai.example.test/v1/responses"]);
    for (const call of calls) {
      expect(call.init.redirect).toBe("error");
      expect(JSON.parse(String(call.init.body))).toMatchObject({ store: false });
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      const request = JSON.parse(String(call.init.body));
      expect(request).toMatchObject({
        reasoning: { effort: "none" },
        max_output_tokens: 256,
        text: { format: { type: "json_schema", strict: true, name: "model_diagnostic_probe", schema: { type: "object", additionalProperties: false, required: ["probe"] } } },
      });
      expect(JSON.stringify(request)).not.toContain("职业");
      expect(JSON.stringify(request)).not.toContain("account");
      expect(JSON.stringify(request)).not.toContain("sk-test-model-diagnostics");
    }
  });

  it("共享二十秒截止时间，即使底层 transport 无视 signal 也会取消两次调用并完成", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const transport: ModelDiagnosticTestTransport = ({ signal }) => {
        signals.push(signal);
        return Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200 }));
      };
      const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, transport);
      const pending = adapter.diagnose({ signal: new AbortController().signal });

      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toEqual(expectedByScenario.timeout);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [999, "under_1s"],
    [1_000, "1_to_5s"],
    [5_000, "5_to_10s"],
    [10_000, "10_to_20s"],
  ] as const)("按整轮真实耗时 %dms 归入 %s", async (elapsedMs, latencyBucket) => {
    let now = 0;
    const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, async () => {
      now = elapsedMs;
      return responseFor({ kind: "success" }, "gpt-5.6-luna");
    }, { now: () => now });

    await expect(adapter.diagnose({ signal: new AbortController().signal })).resolves.toEqual({ ...available, latencyBucket });
  });

  it.each([
    [{ kind: "authentication_failed" }, { kind: "timeout" }, {
      status: "failed", checks: { authentication: "failed", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" }, reasonCode: "MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED", latencyBucket: "timeout",
    }],
    [{ kind: "authentication_failed" }, { kind: "high_quality_model_unavailable" }, {
      status: "failed", checks: { authentication: "failed", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" }, reasonCode: "MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED", latencyBucket: "under_1s",
    }],
    [{ kind: "low_cost_model_unavailable" }, { kind: "timeout" }, {
      status: "failed", checks: { authentication: "not_verified", modelAvailability: "failed", structuredOutput: "not_verified", timeout: "failed" }, reasonCode: "MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE", latencyBucket: "timeout",
    }],
    [{ kind: "strict_output_unsupported" }, { kind: "timeout" }, {
      status: "failed", checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "failed", timeout: "failed" }, reasonCode: "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED", latencyBucket: "timeout",
    }],
    [{ kind: "success" }, { kind: "rate_limited" }, {
      status: "temporarily_unavailable", checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_RATE_LIMITED", latencyBucket: "under_1s",
    }],
  ] as const)("混合结果 %o / %o 只报告已证实的检查", async (lowCost, highQuality, expected) => {
    const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, async ({ init }) => {
      const model = (JSON.parse(String(init.body)) as { model: string }).model;
      return responseFor(model === "gpt-5.6-luna" ? lowCost : highQuality, model);
    });
    await expect(adapter.diagnose({ signal: new AbortController().signal })).resolves.toEqual(expected);
  });

  it("遍历 completed 输出，允许 reasoning 和非输出 metadata，只接受唯一合法 output_text", async () => {
    const response = Response.json({
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "internal" }] },
        { type: "message", content: [{ type: "output_text", text: "{\"probe\":\"ok\"}" }, { type: "metadata", key: "safe" }] },
      ],
    });
    const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, async () => response.clone());

    await expect(adapter.diagnose({ signal: new AbortController().signal })).resolves.toEqual(available);
  });

  it.each([
    [{ status: "completed", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "{\"probe\":\"ok\"}" }, { type: "output_text", text: "{\"probe\":\"ok\"}" }] }] }],
    [{ status: "completed", output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "{\"probe\":\"ok\"}" }, { type: "refusal", refusal: "no" }] }] }],
  ])("多重 output_text 或 refusal 都不能形成成功结果", async (wire) => {
    const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, async () => Response.json(wire));
    await expect(adapter.diagnose({ signal: new AbortController().signal })).resolves.toEqual(expectedByScenario.strict_output_unsupported);
  });

  it("已取消的父 signal 零请求并立即收敛为稳定超时", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn<ModelDiagnosticTestTransport>();
    const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, transport);

    await expect(adapter.diagnose({ signal: controller.signal })).resolves.toEqual(expectedByScenario.timeout);
    expect(transport).not.toHaveBeenCalled();
  });

  it("诊断中父 signal 取消后不等待无视 signal 的 transport", async () => {
    const controller = new AbortController();
    const transport: ModelDiagnosticTestTransport = () => new Promise<Response>(() => undefined);
    const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, transport);
    const pending = adapter.diagnose({ signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual(expectedByScenario.timeout);
  });

  it("抛出携带秘密的 transport 错误只返回稳定临时失败", async () => {
    const secret = "provider-body-and-secret";
    const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, async () => { throw new Error(secret); });
    const result = await adapter.diagnose({ signal: new AbortController().signal });

    expect(result).toEqual(expectedByScenario.provider_unavailable);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("指纹覆盖全部有效配置和秘密，但生产构造入口不接收受控 transport", () => {
    const first = createOpenAiModelDiagnosticAdapter(configuration);
    const changedKey = createOpenAiModelDiagnosticAdapter({ ...configuration, apiKey: "sk-replaced" });
    const changedModel = createOpenAiModelDiagnosticAdapter({ ...configuration, lowCostModel: "gpt-5.6-luna-variant" });
    const changedEndpoint = createOpenAiModelDiagnosticAdapter({ ...configuration, endpoint: "https://other.example.test/v1" });
    const changedOrganization = createOpenAiModelDiagnosticAdapter({ ...configuration, organization: "org_other" });
    const changedProject = createOpenAiModelDiagnosticAdapter({ ...configuration, project: "project_other" });
    const changedHighQualityModel = createOpenAiModelDiagnosticAdapter({ ...configuration, highQualityModel: "gpt-5.6-terra-variant" });

    expect(first.configurationFingerprint).not.toBe(changedKey.configurationFingerprint);
    expect(first.configurationFingerprint).not.toBe(changedModel.configurationFingerprint);
    expect(first.configurationFingerprint).not.toBe(changedEndpoint.configurationFingerprint);
    expect(first.configurationFingerprint).not.toBe(changedOrganization.configurationFingerprint);
    expect(first.configurationFingerprint).not.toBe(changedProject.configurationFingerprint);
    expect(first.configurationFingerprint).not.toBe(changedHighQualityModel.configurationFingerprint);
    expect(first.configurationFingerprint).not.toContain(configuration.apiKey);
  });

  it("仅测试工厂可变更诊断版本并使同一配置的指纹失效", () => {
    const v1 = createOpenAiModelDiagnosticAdapterForTest(configuration, async () => responseFor({ kind: "success" }, "gpt-5.6-luna"), { diagnosticVersion: "probe-v1" });
    const v2 = createOpenAiModelDiagnosticAdapterForTest(configuration, async () => responseFor({ kind: "success" }, "gpt-5.6-luna"), { diagnosticVersion: "probe-v2" });
    expect(v1.configurationFingerprint).not.toBe(v2.configurationFingerprint);
  });

  it("测试契约每个固定请求字段变动均使指纹失效并进入实际请求", async () => {
    const base = { method: "POST", path: "/responses", contentType: "application/json", redirect: "error" as RequestRedirect, store: false, input: [{ role: "user", content: [{ type: "input_text", text: "Return the requested JSON object." }] }], reasoningEffort: "none", maxOutputTokens: 256, format: { type: "json_schema", name: "model_diagnostic_probe", strict: true, schema: { type: "object", additionalProperties: false, required: ["probe"], properties: { probe: { type: "string", enum: ["ok"] } } } }, timeoutMs: 20_000 };
    const variants = [ { ...base, method: "PUT" }, { ...base, path: "/other" }, { ...base, contentType: "application/problem+json" }, { ...base, redirect: "manual" as RequestRedirect }, { ...base, store: true }, { ...base, input: [{ role: "developer", content: base.input[0]!.content }] }, { ...base, input: [{ role: "user", content: [{ type: "other", text: base.input[0]!.content[0]!.text }] }] }, { ...base, input: [{ role: "user", content: [{ type: "input_text", text: "changed" }] }] }, { ...base, reasoningEffort: "low" }, { ...base, maxOutputTokens: 257 }, { ...base, format: { ...base.format, type: "other" } }, { ...base, format: { ...base.format, name: "other" } }, { ...base, format: { ...base.format, strict: false } }, { ...base, format: { ...base.format, schema: { ...base.format.schema, required: ["changed"] } } }, { ...base, timeoutMs: 19_999 } ];
    const original = createOpenAiModelDiagnosticAdapterForTest(configuration, async () => responseFor({ kind: "success" }, "gpt-5.6-luna"), { contract: base });
    for (const contract of variants) expect(createOpenAiModelDiagnosticAdapterForTest(configuration, async () => responseFor({ kind: "success" }, "gpt-5.6-luna"), { contract }).configurationFingerprint).not.toBe(original.configurationFingerprint);
    const calls: Parameters<ModelDiagnosticTestTransport>[0][] = []; const adapter = createOpenAiModelDiagnosticAdapterForTest(configuration, async (request) => { calls.push(request); return responseFor({ kind: "success" }, "gpt-5.6-luna"); }, { contract: base });
    await adapter.diagnose({ signal: new AbortController().signal });
    expect(calls).toHaveLength(2); expect(calls[0]!.url).toBe("https://openai.example.test/v1/responses"); expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error", headers: expect.objectContaining({ "content-type": "application/json" }) }); expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ model: "gpt-5.6-luna", store: false, input: base.input, reasoning: { effort: "none" }, max_output_tokens: 256, text: { format: base.format } });
  });

  it.each([{ apiKey: "" }, { endpoint: "not-a-url" }, { lowCostModel: "" }, { highQualityModel: "" }])("配置 %o 无效时以稳定失败返回且不发出外部请求", async (invalid) => {
    const calls: unknown[] = [];
    const adapter = createOpenAiModelDiagnosticAdapterForTest({ ...configuration, ...invalid }, async (request) => {
      calls.push(request);
      return responseFor({ kind: "success" }, "gpt-5.6-luna");
    });

    await expect(adapter.diagnose({ signal: new AbortController().signal })).resolves.toEqual({
      status: "failed",
      checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" },
      reasonCode: "MODEL_DIAGNOSTIC_CONFIGURATION_MISSING",
      latencyBucket: "under_1s",
    });
    expect(calls).toEqual([]);
  });
});
