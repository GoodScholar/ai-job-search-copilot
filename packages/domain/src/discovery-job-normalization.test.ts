import { describe, expect, it, vi } from "vitest";
import { JobNormalizerOutputSchema } from "@job-copilot/contracts/job-imports";
import { type JobNormalizerMetadata } from "@job-copilot/contracts/job-normalizer";
import { createDiscoveryJobNormalizer } from "./discovery-job-normalization.js";

const metadata: JobNormalizerMetadata = { adapter: "fake", normalizerVersion: "fake-job-normalizer-v2", promptVersion: "job-normalizer-prompt-v1", outputSchemaVersion: "job-normalizer-v1", ruleVersion: "job-normalization-evidence-v2", model: null };
const content = "公司：示例科技\n标题：工程师";
const output = JobNormalizerOutputSchema.parse({ ...metadata, company: "示例科技", title: "工程师", location: null, postedAt: null, deadline: null, description: null, qualifications: { workMode: null, relocationRequired: null, salary: null, seniority: null, education: null, languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: null }, fieldEvidence: [{ field: "company", path: "lines:1-1", rawValue: "示例科技", normalizedValue: "示例科技" }, { field: "title", path: "lines:2-2", rawValue: "工程师", normalizedValue: "工程师" }], usage: { status: "known", inputTokens: 3, outputTokens: 5, totalTokens: 8 } });

function fixture(decisions: Array<{ kind: string }> = [{ kind: "continue" }, { kind: "continue" }]) {
  const checkpoint = { check: vi.fn(async () => decisions.shift() ?? { kind: "continue" }) };
  const normalizer = { metadata, normalize: vi.fn(async (_content: string, options: any) => { await options.beforeRequest({ inputTokenBound: 1_500, maxOutputTokens: 2_000 }); await options.onUsage({ inputTokens: 3, outputTokens: 5 }); return output; }) };
  const markUsageIncomplete = vi.fn(async () => undefined);
  const helper = createDiscoveryJobNormalizer({ metadata, normalizerResolver: { resolve: () => normalizer }, checkpoint, userId: "user", runId: "run", claimToken: "claim", attemptCount: 1, clock: () => new Date("2026-09-26T00:00:00.000Z"), deadline: new Date("2026-09-26T00:00:10.000Z"), signal: new AbortController().signal, markUsageIncomplete });
  return { checkpoint, normalizer, markUsageIncomplete, helper };
}

describe("discovery job normalization", () => {
  it("在请求前预检、在验证前结算 usage，并复用同一 attempt 的相同正文", async () => {
    const { helper, checkpoint, normalizer } = fixture();
    await expect(helper.normalizePosting({ identity: "lead", content })).resolves.toEqual(output);
    await expect(helper.normalizePosting({ identity: "lead", content })).resolves.toEqual(output);
    expect(normalizer.normalize).toHaveBeenCalledOnce();
    expect(checkpoint.check).toHaveBeenNthCalledWith(1, expect.objectContaining({ reserve: {} }));
    expect(checkpoint.check).toHaveBeenNthCalledWith(2, expect.objectContaining({ reserve: { inputTokens: 3, outputTokens: 5, settleActual: true, invocationAttemptCount: 1 } }));
  });

  it("预检预算耗尽时不发送请求", async () => {
    const { helper, normalizer } = fixture([{ kind: "budget_exhausted" }]);
    await expect(helper.normalizePosting({ identity: "lead", content })).rejects.toMatchObject({ code: "DISCOVERY_JOB_NORMALIZATION_INTERRUPTED" });
    expect(normalizer.normalize).toHaveBeenCalledOnce();
  });

  it("未知 usage 后终止并阻止后续请求", async () => {
    const { helper, normalizer, markUsageIncomplete } = fixture();
    normalizer.normalize.mockImplementationOnce(async (_content: string, options: any) => { await options.beforeRequest({ inputTokenBound: 1_500, maxOutputTokens: 2_000 }); throw new Error("network after request"); });
    await expect(helper.normalizePosting({ identity: "first", content })).rejects.toMatchObject({ code: "DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE" });
    await expect(helper.normalizePosting({ identity: "second", content })).rejects.toMatchObject({ code: "DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE" });
    expect(markUsageIncomplete).toHaveBeenCalledOnce();
    expect(normalizer.normalize).toHaveBeenCalledOnce();
  });

  it("非法或中断后未结算的 usage 会降级完整性并阻止后续请求", async () => {
    const invalid = fixture();
    invalid.normalizer.normalize.mockImplementationOnce(async (_content: string, options: any) => { await options.beforeRequest({ inputTokenBound: 1_500, maxOutputTokens: 2_000 }); await options.onUsage({ inputTokens: -1, outputTokens: 5 }); return output; });
    await expect(invalid.helper.normalizePosting({ identity: "invalid", content })).rejects.toMatchObject({ code: "DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE" });
    await expect(invalid.helper.normalizePosting({ identity: "blocked", content })).rejects.toMatchObject({ code: "DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE" });
    expect(invalid.markUsageIncomplete).toHaveBeenCalledOnce();
    expect(invalid.normalizer.normalize).toHaveBeenCalledOnce();

    const controller = new AbortController();
    const checkpoint = { check: vi.fn(async () => ({ kind: "continue" })) };
    const normalizer = { metadata, normalize: vi.fn(async (_content: string, options: any) => { await options.beforeRequest({ inputTokenBound: 1_500, maxOutputTokens: 2_000 }); controller.abort(); throw new Error("provider cancelled before usage"); }) };
    const markUsageIncomplete = vi.fn(async () => undefined);
    const helper = createDiscoveryJobNormalizer({ metadata, normalizerResolver: { resolve: () => normalizer }, checkpoint, userId: "user", runId: "run", claimToken: "claim", attemptCount: 1, clock: () => new Date("2026-09-26T00:00:00.000Z"), deadline: new Date("2026-09-26T00:00:10.000Z"), signal: controller.signal, markUsageIncomplete });
    await expect(helper.normalizePosting({ identity: "cancelled", content })).rejects.toMatchObject({ code: "DISCOVERY_JOB_NORMALIZATION_INTERRUPTED" });
    expect(markUsageIncomplete).toHaveBeenCalledOnce();
  });

  it("按 Adapter 的完整预检额度在运行预算不足时零 transport，额度足够时才调用", async () => {
    const paidMetadata = { ...metadata, adapter: "openai" as const, normalizerVersion: "openai-test", model: "test-model" };
    const paidOutput = JobNormalizerOutputSchema.parse({ ...output, ...paidMetadata });
    const transport = vi.fn();
    const insufficientCheckpoint = { check: vi.fn(async ({ reserve }: { reserve: Record<string, number | boolean> }) => reserve.budgetTokens === 11_000 ? { kind: "budget_exhausted" } : { kind: "continue" }) };
    const insufficientNormalizer = { metadata: paidMetadata, normalize: vi.fn(async (_content: string, options: any) => {
      await options.beforeRequest({ inputTokenBound: 9_000, maxOutputTokens: 2_000 });
      transport();
      await options.onUsage({ inputTokens: 3, outputTokens: 5 });
      return paidOutput;
    }) };
    const common = { metadata: paidMetadata, normalizerResolver: { resolve: () => insufficientNormalizer }, userId: "user", runId: "run", claimToken: "claim", attemptCount: 1, clock: () => new Date("2026-09-26T00:00:00.000Z"), deadline: new Date("2026-09-26T00:00:10.000Z"), signal: new AbortController().signal, markUsageIncomplete: async () => undefined };
    const insufficient = createDiscoveryJobNormalizer({ ...common, checkpoint: insufficientCheckpoint });
    await expect(insufficient.normalizePosting({ identity: "paid-insufficient", content })).rejects.toMatchObject({ code: "DISCOVERY_JOB_NORMALIZATION_INTERRUPTED", interruption: "budget_exhausted" });
    expect(insufficientCheckpoint.check).toHaveBeenCalledWith(expect.objectContaining({ reserve: { modelCalls: 1, budgetTokens: 11_000 } }));
    expect(transport).not.toHaveBeenCalled();

    const sufficientCheckpoint = { check: vi.fn(async () => ({ kind: "continue" })) };
    const sufficientNormalizer = { ...insufficientNormalizer, normalize: vi.fn(async (_content: string, options: any) => {
      await options.beforeRequest({ inputTokenBound: 9_000, maxOutputTokens: 2_000 });
      transport();
      await options.onUsage({ inputTokens: 3, outputTokens: 5 });
      return paidOutput;
    }) };
    const sufficient = createDiscoveryJobNormalizer({ ...common, normalizerResolver: { resolve: () => sufficientNormalizer }, checkpoint: sufficientCheckpoint });
    await expect(sufficient.normalizePosting({ identity: "paid-sufficient", content })).resolves.toEqual(paidOutput);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("usage checkpoint 已给出预算终态时，即使同时 abort 也保留其权威 kind", async () => {
    const controller = new AbortController();
    const checkpoint = { check: vi.fn(async ({ checkpointKey }: { checkpointKey: string }) => {
      if (checkpointKey.endsWith(":usage")) { controller.abort(); return { kind: "budget_exhausted" }; }
      return { kind: "continue" };
    }) };
    const normalizer = { metadata, normalize: async (_content: string, options: any) => { await options.beforeRequest({ inputTokenBound: 1_500, maxOutputTokens: 2_000 }); await options.onUsage({ inputTokens: 3, outputTokens: 5 }); return output; } };
    const helper = createDiscoveryJobNormalizer({ metadata, normalizerResolver: { resolve: () => normalizer }, checkpoint, userId: "user", runId: "run", claimToken: "claim", attemptCount: 1, clock: () => new Date("2026-09-26T00:00:00.000Z"), deadline: new Date("2026-09-26T00:00:10.000Z"), signal: controller.signal, markUsageIncomplete: async () => undefined });
    await expect(helper.normalizePosting({ identity: "settled-budget", content })).rejects.toMatchObject({ code: "DISCOVERY_JOB_NORMALIZATION_INTERRUPTED", interruption: "budget_exhausted" });
  });
});
