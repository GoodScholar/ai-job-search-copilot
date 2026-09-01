import { describe, expect, it } from "vitest";
import { FakeDeepMatchAdapter, type DeepMatchAdapter } from "./deep-match";
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
  ])("拒绝%s mutant", async (_name, mutate) => {
    const adapter = await mutate(new FakeDeepMatchAdapter());
    await expect(runDeepMatchEvaluation(adapter)).rejects.toThrow(/DEEP_MATCH_EVALUATION|citation/i);
  });
});

function adapterIdentity(base: FakeDeepMatchAdapter): Omit<DeepMatchAdapter, "assess"> {
  return { adapter: base.adapter, adapterVersion: base.adapterVersion, model: base.model, reservedUsage: base.reservedUsage };
}
