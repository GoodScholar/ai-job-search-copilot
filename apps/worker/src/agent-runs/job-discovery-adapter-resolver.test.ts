import { describe, expect, it } from "vitest";

import { createJobDiscoveryAdapterResolver } from "./job-discovery-adapter-resolver.js";

const runId = "10000000-0000-4000-8000-000000000001";
const idempotencyKey = "20000000-0000-4000-8000-000000000002";
const metadata = {
  runId,
  idempotencyKey,
  adapter: "fake",
  adapterVersion: "fake-job-discovery-v1",
};
const targetSnapshot = {
  targetId: "30000000-0000-4000-8000-000000000003", version: 1, priority: "primary" as const, state: "active" as const,
  constraints: {
    roleFamily: "工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
    dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
  },
};
const batchInput = {
  targetSnapshot,
  sourceScope: { kind: "company_watchlist" as const, adapter: "fake" as const, adapterVersion: "fake-job-discovery-v1" as const, sources: ["fake:aurora-careers", "fake:orbit-careers"] as ["fake:aurora-careers", "fake:orbit-careers"] },
};

describe("JobDiscoveryAdapterResolver", () => {
  it("非测试环境携带场景配置时 fail-closed", () => {
    expect(() => createJobDiscoveryAdapterResolver({
      APP_ENV: "production",
      E2E_AGENT_RUN_SCENARIOS: JSON.stringify({ [idempotencyKey]: "retry_once" }),
    })).toThrow("E2E Agent Run 场景只允许测试环境");
  });

  it("测试环境严格拒绝非法场景映射", () => {
    expect(() => createJobDiscoveryAdapterResolver({ APP_ENV: "test", E2E_AGENT_RUN_SCENARIOS: "{bad" }))
      .toThrow("E2E_AGENT_RUN_SCENARIOS 格式无效");
    expect(() => createJobDiscoveryAdapterResolver({ APP_ENV: "test", E2E_AGENT_RUN_SCENARIOS: JSON.stringify({ invalid: "retry_once" }) }))
      .toThrow("E2E_AGENT_RUN_SCENARIOS 格式无效");
  });

  it("local/test 未配置场景时返回正常 Fake，并只接受持久化 adapter 元数据", async () => {
    const resolver = createJobDiscoveryAdapterResolver({ APP_ENV: "local" });
    await expect(resolver.resolve({ ...metadata, attemptCount: 1 }).searchBatch(batchInput)).resolves.toMatchObject({ ok: true });
    expect(() => resolver.resolve({ ...metadata, adapter: "other", attemptCount: 1 })).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
    expect(() => resolver.resolve({ ...metadata, adapterVersion: "other-v1", attemptCount: 1 })).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
  });

  it("retry_once 仅使第一次持久化 attempt 返回可重试来源错误", async () => {
    const resolver = createJobDiscoveryAdapterResolver({
      APP_ENV: "test",
      E2E_AGENT_RUN_SCENARIOS: JSON.stringify({ [idempotencyKey]: "retry_once" }),
    });

    await expect(resolver.resolve({ ...metadata, attemptCount: 1 }).searchBatch(batchInput))
      .resolves.toEqual({ ok: false, error: { code: "FAKE_SCENARIO_RETRY_ONCE", retryable: true } });
    await expect(resolver.resolve({ ...metadata, attemptCount: 2 }).searchBatch(batchInput)).resolves.toMatchObject({ ok: true });
  });

  it("retry_until_budget 每次 attempt 都返回可重试来源错误", async () => {
    const resolver = createJobDiscoveryAdapterResolver({
      APP_ENV: "test",
      E2E_AGENT_RUN_SCENARIOS: JSON.stringify({ [idempotencyKey]: "retry_until_budget" }),
    });

    for (const attemptCount of [1, 2, 3]) {
      await expect(resolver.resolve({ ...metadata, attemptCount }).searchBatch(batchInput))
        .resolves.toEqual({ ok: false, error: { code: "FAKE_SCENARIO_RETRY_UNTIL_BUDGET", retryable: true } });
    }
  });

  it("slow_checkpoint 仅引入有限延迟，不从目标文本读取场景", async () => {
    const resolver = createJobDiscoveryAdapterResolver({
      APP_ENV: "test",
      E2E_AGENT_RUN_SCENARIOS: JSON.stringify({ [idempotencyKey]: "slow_checkpoint" }),
    });
    const startedAt = Date.now();
    await expect(resolver.resolve({ ...metadata, attemptCount: 1 }).searchBatch(batchInput)).resolves.toMatchObject({ ok: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
  });
});
