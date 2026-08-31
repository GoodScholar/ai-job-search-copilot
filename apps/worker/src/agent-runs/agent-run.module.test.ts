import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_JOB_DISCOVERY_BUDGET } from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/job-discovery";

import { createConfiguredJobDiscoveryAdapterResolver, createConfiguredJobDiscoveryExecutionMode, createConfiguredLayeredPublicJobDiscoveryWorkflowResolver } from "./agent-run.module.js";

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
const layeredExecutionSpec = {
  targetSnapshot: legacyExecutionSpec.targetSnapshot,
  profileSnapshot: { targetId: legacyExecutionSpec.targetSnapshot.targetId, version: 1, confirmedActiveSkillNames: [] },
  watchlistSnapshot: { targetId: legacyExecutionSpec.targetSnapshot.targetId, version: 0, companies: [] },
  sourceScope: { kind: "layered_public" as const, trustedSources: [], publicDiscovery: { provider: "anysearch" as const, batchSize: 5 as const, maxVerificationCandidates: 10 as const, queries: [{ ordinal: 1, queryId: "40000000-0000-4000-8000-000000000004", kind: "general" as const, stableFingerprint: "a".repeat(64), query: "工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 as const }] } },
  workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION,
  adapter: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, adapterVersion: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
  toolAllowlist: ["job_discovery.list_source", "job_discovery.search", "job_discovery.extract", "job_discovery.fetch"] as const, model: null, budget: PUBLIC_JOB_DISCOVERY_BUDGET,
} as const;

describe("AgentRunModule", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("production module 构造可解析 v4 的真实 workflow resolver，而非只 export helper", () => {
    const resolver = createConfiguredLayeredPublicJobDiscoveryWorkflowResolver({
      environment: { APP_ENV: "production", ANYSEARCH_API_KEY: "configured-key" }, db: {} as never, auditTrail: {} as never,
      contentStore: { put: async () => undefined, delete: async () => undefined }, evidenceStore: { put: async () => ({ created: true }), delete: async () => undefined }, id: () => crypto.randomUUID(),
    });
    expect(typeof resolver.resolve({ runId: "10000000-0000-4000-8000-000000000001", idempotencyKey: "20000000-0000-4000-8000-000000000002", executionSpec: layeredExecutionSpec as never, attemptCount: 1 }).run).toBe("function");
  });

  it.each([undefined, "   "])("缺少 AnySearch key 时不 checkpoint 或匿名请求，且保留 source issue: %j", async (apiKey) => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const resolver = createConfiguredLayeredPublicJobDiscoveryWorkflowResolver({
      environment: { APP_ENV: "production", ANYSEARCH_API_KEY: apiKey }, db: {} as never, auditTrail: {} as never,
      contentStore: { put: async () => undefined, delete: async () => undefined }, evidenceStore: { put: async () => ({ created: true }), delete: async () => undefined }, id: () => crypto.randomUUID(),
    });
    const result = await resolver.resolve({ runId: "10000000-0000-4000-8000-000000000001", idempotencyKey: "20000000-0000-4000-8000-000000000002", executionSpec: layeredExecutionSpec as never, attemptCount: 1 }).run({
      userId: legacyExecutionSpec.targetSnapshot.targetId, runId: "10000000-0000-4000-8000-000000000001", claimToken: "50000000-0000-4000-8000-000000000005", now: new Date(), executionSpec: layeredExecutionSpec as never, attemptCount: 1,
      beforePhysicalOperation: async () => { throw new Error("not a physical request"); }, onDiagnostics: () => undefined, signal: new AbortController().signal,
    });
    expect({ transport: transport.mock.calls.length, result }).toMatchObject({ transport: 0, result: { branchOutcome: { trusted: "failed", publicDiscovery: "failed" }, diagnostics: [{ scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 1 }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 }] } });
  });

  it("test 环境的 resolver 拒绝 v4，保证旧 Fake 与 v3 health 路径不被抢占", () => {
    const resolver = createConfiguredLayeredPublicJobDiscoveryWorkflowResolver({
      environment: { APP_ENV: "test", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: "{}" }, db: {} as never, auditTrail: {} as never,
      contentStore: { put: async () => undefined, delete: async () => undefined }, evidenceStore: { put: async () => ({ created: true }), delete: async () => undefined }, id: () => crypto.randomUUID(),
    });
    expect(() => resolver.resolve({ runId: "10000000-0000-4000-8000-000000000001", idempotencyKey: "20000000-0000-4000-8000-000000000002", executionSpec: layeredExecutionSpec as never, attemptCount: 1 })).toThrow("AGENT_RUN_ADAPTER_UNSUPPORTED");
  });

  it.each([
    [{ APP_ENV: "production" }, "layered_public"],
    [{ APP_ENV: "test", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }, "fake"],
    [{ APP_ENV: "local" }, "fake"],
    [{ APP_ENV: "local", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" }, "greenhouse"],
  ] as const)("为 %o 选择与 API 相同的新运行执行模式", (environment, expected) => {
    expect(createConfiguredJobDiscoveryExecutionMode(environment)).toBe(expected);
  });

  it.each([
    { APP_ENV: "local", PUBLIC_JOB_DISCOVERY_ADAPTER: "unknown" },
    { APP_ENV: "production", PUBLIC_JOB_DISCOVERY_ADAPTER: "fake" },
    { APP_ENV: "production", PUBLIC_JOB_DISCOVERY_ADAPTER: "greenhouse" },
    { APP_ENV: "production", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: "{}" },
    { APP_ENV: "production", E2E_AGENT_RUN_SCENARIOS: '{"sentinel":"retry_once"}' },
    { APP_ENV: "local", E2E_AGENT_RUN_SCENARIOS: '{"sentinel":"retry_once"}' },
    { APP_ENV: "local", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"sentinel":{}}' },
    { APP_ENV: "local", ANYSEARCH_BASE_URL: "https://test.invalid" },
  ])("拒绝非受控运行时配置 %o", (environment) => {
    expect(() => createConfiguredJobDiscoveryExecutionMode(environment)).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
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
        .toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
    },
  );

  it.each([undefined, "", "   "])("test 下空白 health scenario 保持 Fake: %j", (scenario) => {
    expect(createConfiguredJobDiscoveryExecutionMode({ APP_ENV: "test", E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: scenario })).toBe("fake");
  });

  it("resolver 的 malformed scenario 只返回稳定脱敏常量", () => {
    const sentinel = "malformed-sentinel-never-echo";
    expect(() => createConfiguredJobDiscoveryAdapterResolver({ APP_ENV: "test", E2E_AGENT_RUN_SCENARIOS: `{${sentinel}` })).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
    try { createConfiguredJobDiscoveryAdapterResolver({ APP_ENV: "test", E2E_AGENT_RUN_SCENARIOS: `{${sentinel}` }); } catch (error) { expect(String(error)).not.toContain(sentinel); }
  });

  it.each([
    { E2E_AGENT_RUN_SCENARIOS: "{" },
    { E2E_AGENT_RUN_SCENARIOS: '{"not-a-uuid":"retry_once"}' },
    { E2E_AGENT_RUN_SCENARIOS: '{"11111111-1111-4111-8111-111111111111":"unknown"}' },
    { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: "{" },
    { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"not-a-uuid":{"greenhouse:example":"healthy"}}' },
    { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"11111111-1111-4111-8111-111111111111":{"invalid-source":"healthy"}}' },
    { E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS: '{"11111111-1111-4111-8111-111111111111":{"greenhouse:example":"unknown"}}' },
  ])("configured v4 resolver 与 API 同样拒绝两种非法 scenario: %o", (scenario) => {
    const create = () => createConfiguredLayeredPublicJobDiscoveryWorkflowResolver({
      environment: { APP_ENV: "test", ...scenario }, db: {} as never, auditTrail: {} as never,
      contentStore: { put: async () => undefined, delete: async () => undefined }, evidenceStore: { put: async () => ({ created: true }), delete: async () => undefined }, id: () => crypto.randomUUID(),
    });
    expect(create).toThrow("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
  });
});
