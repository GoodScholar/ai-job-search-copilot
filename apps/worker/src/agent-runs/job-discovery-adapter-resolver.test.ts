import { describe, expect, it } from "vitest";

import { createJobDiscoveryAdapterResolver, createSourceHealthDiscoveryAdapterResolver } from "./job-discovery-adapter-resolver.js";
import { FakePublicSourceHealthAdapter } from "./fake-public-source-health-adapter.js";
import { GreenhouseSourceHealthAdapter } from "./greenhouse-source-health-adapter.js";
import { GreenhouseJobDiscoveryAdapter } from "./greenhouse-job-discovery-adapter.js";

const runId = "10000000-0000-4000-8000-000000000001";
const idempotencyKey = "20000000-0000-4000-8000-000000000002";
const targetSnapshot = {
  targetId: "30000000-0000-4000-8000-000000000003", version: 1, priority: "primary" as const, state: "active" as const,
  constraints: {
    roleFamily: "工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
    dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
  },
};
const batchInput = {
  targetSnapshot,
  sourceScope: { kind: "company_watchlist" as const, adapter: "fake" as const, adapterVersion: "fake-job-discovery-v1" as const, watchlistVersion: 0, sources: ["fake:aurora-careers", "fake:orbit-careers"] },
};
const executionSpec = {
  targetSnapshot,
  sourceScope: batchInput.sourceScope,
  workflowVersion: "job-discovery-workflow-v1",
  ruleVersion: "fake-job-discovery-rules-v1",
  adapter: "fake",
  adapterVersion: "fake-job-discovery-v1",
  outputSchemaVersion: "job-discovery-result-v1",
  toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"],
  model: null,
  budget: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
} as const;
const metadata = {
  runId,
  idempotencyKey,
  adapter: "fake",
  adapterVersion: "fake-job-discovery-v1",
  executionSpec,
};
const greenhouseExecutionSpec = {
  targetSnapshot,
  sourceScope: {
    kind: "company_watchlist" as const,
    adapter: "greenhouse" as const,
    adapterVersion: "greenhouse-job-board-v1" as const,
    watchlistVersion: 1,
    sources: [{ sourceId: "greenhouse:example", watchlistItemId: "40000000-0000-4000-8000-000000000004", canonicalCompanyName: "Example", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "example" }],
  },
  workflowVersion: "job-discovery-workflow-v2",
  ruleVersion: "greenhouse-job-discovery-rules-v1",
  adapter: "greenhouse",
  adapterVersion: "greenhouse-job-board-v1",
  outputSchemaVersion: "job-discovery-result-v2",
  toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"],
  model: null,
  budget: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 60, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
} as const;
const sourceHealthExecutionSpec = {
  ...greenhouseExecutionSpec,
  sourceScope: { ...greenhouseExecutionSpec.sourceScope, adapterVersion: "greenhouse-job-board-v2" as const },
  workflowVersion: "job-discovery-workflow-v3",
  ruleVersion: "job-discovery-source-health-rules-v1",
  adapterVersion: "greenhouse-job-board-v2",
  outputSchemaVersion: "job-discovery-result-v3",
  toolAllowlist: ["job_discovery.list_source", "job_discovery.get_detail"],
} as const;

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

  it("local 未配置场景时返回正常 Fake，并只接受持久化 adapter 元数据", async () => {
    const resolver = createJobDiscoveryAdapterResolver({ APP_ENV: "local" });
    await expect(resolver.resolve({ ...metadata, attemptCount: 1 }).searchBatch(batchInput)).resolves.toMatchObject({ ok: true });
    expect(() => resolver.resolve({ ...metadata, executionSpec: { ...executionSpec, adapter: "other" }, attemptCount: 1 } as any)).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
    expect(() => resolver.resolve({ ...metadata, executionSpec: { ...executionSpec, adapterVersion: "other-v1" }, attemptCount: 1 } as any)).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
  });

  it("production 仅解析完整精确的 legacy Fake v1 执行规格，local 只有显式 opt-in 才解析 Greenhouse，test 始终 fail-closed", async () => {
    const greenhouse = { runId, idempotencyKey, executionSpec: greenhouseExecutionSpec, attemptCount: 1 };
    await expect(createJobDiscoveryAdapterResolver({ APP_ENV: "production" }).resolve({ ...metadata, attemptCount: 1 }).searchBatch(batchInput)).resolves.toMatchObject({ ok: true });
    expect(() => createJobDiscoveryAdapterResolver({ APP_ENV: "production" }).resolve({ ...metadata, executionSpec: { ...executionSpec, workflowVersion: "job-discovery-workflow-v2" }, attemptCount: 1 } as any)).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
    expect(() => createJobDiscoveryAdapterResolver({ APP_ENV: "local" }).resolve(greenhouse)).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
    expect(createJobDiscoveryAdapterResolver({ APP_ENV: "local", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }).resolve(greenhouse)).toBeInstanceOf(GreenhouseJobDiscoveryAdapter);
    expect(createJobDiscoveryAdapterResolver({ APP_ENV: "production" }).resolve(greenhouse)).toBeInstanceOf(GreenhouseJobDiscoveryAdapter);
    expect(() => createJobDiscoveryAdapterResolver({ APP_ENV: "test", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }).resolve(greenhouse)).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
  });

  it("未知 APP_ENV 时拒绝启动", () => {
    expect(() => createJobDiscoveryAdapterResolver({ APP_ENV: "staging" })).toThrow("JobDiscoveryAdapter 环境未获允许");
  });

  it("v3 只在测试环境通过受控场景映射选择无网络 fake-public", async () => {
    const resolver = createSourceHealthDiscoveryAdapterResolver({
      APP_ENV: "test",
      E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: JSON.stringify({ [idempotencyKey]: { "greenhouse:example": "rate_limited" } }),
    });
    const adapter = resolver.resolve({ runId, idempotencyKey, executionSpec: sourceHealthExecutionSpec, attemptCount: 1 });

    expect(adapter).toBeInstanceOf(FakePublicSourceHealthAdapter);
    await expect(adapter.listSource({ targetSnapshot, source: { ...sourceHealthExecutionSpec.sourceScope.sources[0]!, allowedDomains: [...sourceHealthExecutionSpec.sourceScope.sources[0]!.allowedDomains] } })).resolves.toEqual({
      ok: false, failure: { category: "rate_limited", reasonCode: "SOURCE_RATE_LIMITED", retryable: true, attemptCount: 2 },
    });
    expect(() => createSourceHealthDiscoveryAdapterResolver({ APP_ENV: "production", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: "{}" }))
      .toThrow("E2E Public Source Health 场景只允许测试环境");
  });

  it("v3 production 使用 greenhouse，local 必须显式 opt-in，并拒绝无效测试场景", () => {
    const metadata = { runId, idempotencyKey, executionSpec: sourceHealthExecutionSpec, attemptCount: 1 };

    expect(createSourceHealthDiscoveryAdapterResolver({ APP_ENV: "production" }).resolve(metadata)).toBeInstanceOf(GreenhouseSourceHealthAdapter);
    expect(() => createSourceHealthDiscoveryAdapterResolver({ APP_ENV: "local" }).resolve(metadata)).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
    expect(createSourceHealthDiscoveryAdapterResolver({ APP_ENV: "local", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }).resolve(metadata)).toBeInstanceOf(GreenhouseSourceHealthAdapter);
    expect(() => createSourceHealthDiscoveryAdapterResolver({ APP_ENV: "test", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: JSON.stringify({ [idempotencyKey]: { invalid: "healthy" } }) }))
      .toThrow("E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS 格式无效");
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
