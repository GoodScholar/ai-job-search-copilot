import { describe, expect, it } from "vitest";

import { createConfiguredJobPostingNormalizer, resolveE2eJobNormalizerDelayMs } from "./job-import.module.js";

describe("resolveE2eJobNormalizerDelayMs", () => {
  it("仅在测试环境接受有限、非负且受上限约束的毫秒数", () => {
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "test", E2E_JOB_NORMALIZER_DELAY_MS: "750" })).toBe(750);
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "test", E2E_JOB_NORMALIZER_DELAY_MS: "0" })).toBe(0);
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "test", E2E_JOB_NORMALIZER_DELAY_MS: "5000" })).toBe(5000);
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "test", E2E_JOB_NORMALIZER_DELAY_MS: "-1" })).toBe(0);
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "test", E2E_JOB_NORMALIZER_DELAY_MS: "not-a-number" })).toBe(0);
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "test", E2E_JOB_NORMALIZER_DELAY_MS: "Infinity" })).toBe(0);
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "test", E2E_JOB_NORMALIZER_DELAY_MS: "5001" })).toBe(0);
  });

  it("在非测试环境或未配置时禁用延迟", () => {
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "development", E2E_JOB_NORMALIZER_DELAY_MS: "750" })).toBe(0);
    expect(resolveE2eJobNormalizerDelayMs({ APP_ENV: "test" })).toBe(0);
  });
});

describe("createConfiguredJobPostingNormalizer", () => {
  it("默认与测试环境使用 Fake，显式配置凭据后使用生产 Adapter", () => {
    expect(createConfiguredJobPostingNormalizer({ APP_ENV: "test" })).toBeDefined();
    expect(createConfiguredJobPostingNormalizer({ APP_ENV: "production" })).toBeDefined();
    expect(createConfiguredJobPostingNormalizer({ JOB_POSTING_NORMALIZER_ADAPTER: "openai", OPENAI_API_KEY: "test-key" })).toMatchObject({ metadata: { adapter: "openai" } });
    expect(() => createConfiguredJobPostingNormalizer({ JOB_POSTING_NORMALIZER_ADAPTER: "openai" })).toThrow("JOB_NORMALIZER_CREDENTIALS_MISSING");
  });
});
