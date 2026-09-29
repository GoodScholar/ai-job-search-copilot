import { describe, expect, it } from "vitest";
import { FAKE_JOB_NORMALIZER_METADATA } from "@job-copilot/contracts/job-imports";
import { openAiJobNormalizerMetadata } from "@job-copilot/model-access";
import { createConfiguredJobPostingNormalizerResolver } from "./agent-run.module.js";

describe("冻结岗位 normalizer resolver", () => {
  it("使用冻结 modelA，不接受环境中的 modelB 覆写", () => {
    const snapshot = openAiJobNormalizerMetadata("model-a");
    const resolver = createConfiguredJobPostingNormalizerResolver({ OPENAI_API_KEY: "test-key", OPENAI_LOW_COST_MODEL: "model-b" });
    expect(resolver.resolve(snapshot)?.metadata).toEqual(snapshot);
  });

  it("冻结 Fake 时即使环境配置 OpenAI 仍创建 Fake", () => {
    const resolver = createConfiguredJobPostingNormalizerResolver({ OPENAI_API_KEY: "test-key", JOB_POSTING_NORMALIZER_ADAPTER: "openai", OPENAI_LOW_COST_MODEL: "model-b" });
    expect(resolver.resolve(FAKE_JOB_NORMALIZER_METADATA)?.metadata).toEqual(FAKE_JOB_NORMALIZER_METADATA);
  });

  it("拒绝不支持的 snapshot，不构造 provider", () => {
    const snapshot = { ...openAiJobNormalizerMetadata("model-a"), normalizerVersion: "unsupported" };
    const resolver = createConfiguredJobPostingNormalizerResolver({ OPENAI_API_KEY: "test-key" });
    expect(resolver.resolve(snapshot)).toBeUndefined();
  });

  it("缺少凭据时稳定拒绝且不泄露环境值", () => {
    const resolver = createConfiguredJobPostingNormalizerResolver({ OPENAI_LOW_COST_MODEL: "secret-model" });
    expect(resolver.resolve(openAiJobNormalizerMetadata("model-a"))).toBeUndefined();
  });
});
