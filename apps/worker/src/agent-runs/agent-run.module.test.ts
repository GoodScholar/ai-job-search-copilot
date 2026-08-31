import { describe, expect, it } from "vitest";

import { createConfiguredJobDiscoveryAdapterResolver, createConfiguredJobDiscoveryExecutionMode } from "./agent-run.module.js";

const legacyExecutionSpec = {
  targetSnapshot: {
    targetId: "30000000-0000-4000-8000-000000000003", version: 1, priority: "primary" as const, state: "active" as const,
    constraints: { roleFamily: "工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } },
  },
  sourceScope: { kind: "company_watchlist" as const, adapter: "fake" as const, adapterVersion: "fake-job-discovery-v1" as const, watchlistVersion: 0, sources: ["fake:aurora-careers", "fake:orbit-careers"] },
  workflowVersion: "job-discovery-workflow-v1",
  ruleVersion: "fake-job-discovery-rules-v1",
  adapter: "fake",
  adapterVersion: "fake-job-discovery-v1",
  outputSchemaVersion: "job-discovery-result-v1",
  toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"],
  model: null,
  budget: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
} as const;

describe("AgentRunModule", () => {
  it.each([
    [{ APP_ENV: "production" }, "layered_public"],
    [{ APP_ENV: "test", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }, "fake"],
    [{ APP_ENV: "local" }, "fake"],
    [{ APP_ENV: "local", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }, "greenhouse"],
  ] as const)("为 %o 选择与 API 相同的新运行执行模式", (environment, expected) => {
    expect(createConfiguredJobDiscoveryExecutionMode(environment)).toBe(expected);
  });

  it.each(["local", "test"])("%s 环境构造按持久化元数据解析的 Fake resolver", async (appEnv) => {
    const resolver = createConfiguredJobDiscoveryAdapterResolver({ APP_ENV: appEnv });
    await expect(resolver.resolve({
      runId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "20000000-0000-4000-8000-000000000002",
      executionSpec: legacyExecutionSpec,
      attemptCount: 1,
    }).searchBatch({
      targetSnapshot: {
        targetId: "30000000-0000-4000-8000-000000000003", version: 1, priority: "primary", state: "active",
        constraints: { roleFamily: "工程师", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } },
      },
      sourceScope: { kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1", watchlistVersion: 0, sources: ["fake:aurora-careers", "fake:orbit-careers"] },
    })).resolves.toMatchObject({ ok: true });
  });

  it("production 环境拒绝不完整的遗留 Fake metadata", () => {
    const resolver = createConfiguredJobDiscoveryAdapterResolver({ APP_ENV: "production" });
    expect(() => resolver.resolve({
      runId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "20000000-0000-4000-8000-000000000002",
      executionSpec: { ...legacyExecutionSpec, outputSchemaVersion: "forged" }, attemptCount: 1,
    })).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
  });

  it.each([undefined, "development", "staging", "LOCAL", "tesst"])(
    "APP_ENV=%s 时 fail-closed 拒绝 Fake",
    (appEnv) => {
      expect(() => createConfiguredJobDiscoveryAdapterResolver(appEnv === undefined ? {} : { APP_ENV: appEnv }))
        .toThrow("JobDiscoveryAdapter 环境未获允许");
    },
  );
});
