import { describe, expect, it } from "vitest";
import { DeepMatchAdapterError, FakeDeepMatchAdapter, isDeepMatchTriageEligible, type DeepMatchAdapter } from "./deep-match";
import { DEEP_MATCH_EVALUATION_VERSION, runDeepMatchEvaluation } from "./deep-match-evaluation";

describe("deep-match-rules-v1 versioned evaluation gate", () => {
  it("keeps the Fake adapter's evidence closure, stable ranking, quality floor, and per-call token ceiling", async () => {
    const report = await runDeepMatchEvaluation(new FakeDeepMatchAdapter());
    expect(report).toEqual({
      evaluationVersion: DEEP_MATCH_EVALUATION_VERSION,
      cases: 2,
      acceptedOpportunityIds: ["00000000-0000-4000-8000-000000000010"],
      rejectedOpportunityIds: ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012"],
    });
  });

  it.each([
    ["编造岗位证据", async (base: FakeDeepMatchAdapter) => ({ ...adapterIdentity(base), assess: async (...args: Parameters<DeepMatchAdapter["assess"]>) => {
      const result = await base.assess(...args);
      return { ...result, assessments: result.assessments.map((assessment, index) => index === 0 ? { ...assessment, dimensions: assessment.dimensions.map((dimension, dimensionIndex) => dimensionIndex === 0 ? { ...dimension, jobEvidenceIds: ["job:invented"] } : dimension) } : assessment) };
    } })],
    ["伪造使用量", async (base: FakeDeepMatchAdapter) => ({ ...adapterIdentity(base), assess: async (...args: Parameters<DeepMatchAdapter["assess"]>) => ({ ...(await base.assess(...args)), usage: { inputTokens: 81, outputTokens: 0, latencyMs: 1 } }) })],
    ["伪造延迟", async (base: FakeDeepMatchAdapter) => ({ ...adapterIdentity(base), assess: async (...args: Parameters<DeepMatchAdapter["assess"]>) => ({ ...(await base.assess(...args)), usage: { inputTokens: 1, outputTokens: 1, latencyMs: 5_001 } }) })],
    ["错误 adapter 身份", async (base: FakeDeepMatchAdapter) => ({ ...adapterIdentity(base), adapterVersion: "wrong-version", assess: base.assess.bind(base) })],
    ["负数使用量", async (base: FakeDeepMatchAdapter) => ({ ...adapterIdentity(base), assess: async (...args: Parameters<DeepMatchAdapter["assess"]>) => ({ ...(await base.assess(...args)), usage: { inputTokens: -1, outputTokens: 1, latencyMs: 1 } }) })],
    ["超预算使用量", async (base: FakeDeepMatchAdapter) => ({ ...adapterIdentity(base), assess: async (...args: Parameters<DeepMatchAdapter["assess"]>) => ({ ...(await base.assess(...args)), usage: { inputTokens: 80, outputTokens: 1, latencyMs: 1 } }) })],
    ["不完整结果", async (base: FakeDeepMatchAdapter) => ({ ...adapterIdentity(base), assess: async (...args: Parameters<DeepMatchAdapter["assess"]>) => ({ ...(await base.assess(...args)), assessments: [] }) })],
    ["稳定 adapter 错误", async (base: FakeDeepMatchAdapter) => ({ ...adapterIdentity(base), assess: async () => { throw new DeepMatchAdapterError("auth"); } })],
  ])("拒绝%s mutant", async (_name, mutate) => {
    const adapter = await mutate(new FakeDeepMatchAdapter());
    await expect(runDeepMatchEvaluation(adapter)).rejects.toThrow(/DEEP_MATCH_EVALUATION|citation/i);
  });

  it("在取消前不调用 adapter", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runDeepMatchEvaluation(new FakeDeepMatchAdapter(), { signal: controller.signal })).rejects.toThrow("DEEP_MATCH_EVALUATION_CANCELLED");
  });

  it.each([
    ["旧目标版本", { targetVersion: 1 }],
    ["非 pass", { overallVerdict: "fail" as const }],
    ["过期", { deadlineStatus: "expired" as const }],
    ["低于阈值", { overallScore: 69 }],
  ])("共享资格 policy 拒绝%s", (_name, mutation) => {
    expect(isDeepMatchTriageEligible({
      sourcePostingVersionId: "00000000-0000-4000-8000-000000000110", expectedSourcePostingVersionId: "00000000-0000-4000-8000-000000000110",
      targetVersion: 2, expectedTargetVersion: 2, overallVerdict: "pass", deadlineStatus: "valid", availability: "open", overallScore: 70, threshold: 70,
      ...mutation,
    })).toBe(false);
  });
});

function adapterIdentity(base: FakeDeepMatchAdapter): Omit<DeepMatchAdapter, "assess"> {
  return { adapter: base.adapter, adapterVersion: base.adapterVersion, model: base.model, reservedUsage: base.reservedUsage };
}
