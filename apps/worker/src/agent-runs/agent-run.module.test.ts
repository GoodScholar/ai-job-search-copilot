import { describe, expect, it } from "vitest";

import { createConfiguredJobDiscoveryAdapterResolver, createConfiguredJobDiscoveryExecutionMode } from "./agent-run.module.js";

describe("AgentRunModule", () => {
  it.each([
    [{ APP_ENV: "production" }, "greenhouse"],
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
      adapter: "fake",
      adapterVersion: "fake-job-discovery-v1",
      attemptCount: 1,
    }).searchBatch({
      targetSnapshot: {
        targetId: "30000000-0000-4000-8000-000000000003", version: 1, priority: "primary", state: "active",
        constraints: { roleFamily: "工程师", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } },
      },
      sourceScope: { kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1", watchlistVersion: 0, sources: ["fake:aurora-careers", "fake:orbit-careers"] },
    })).resolves.toMatchObject({ ok: true });
  });

  it("production 环境拒绝遗留 Fake metadata", () => {
    const resolver = createConfiguredJobDiscoveryAdapterResolver({ APP_ENV: "production" });
    expect(() => resolver.resolve({
      runId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "20000000-0000-4000-8000-000000000002",
      adapter: "fake", adapterVersion: "fake-job-discovery-v1", attemptCount: 1,
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
