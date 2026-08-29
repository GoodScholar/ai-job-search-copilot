import { describe, expect, it } from "vitest";

import { createConfiguredJobDiscoveryAdapterResolver } from "./agent-run.module.js";

describe("AgentRunModule", () => {
  it.each(["local", "test", "production"])("%s 环境构造按持久化元数据解析的 Fake resolver", async (appEnv) => {
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
      sourceScope: { kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1", sources: ["fake:aurora-careers", "fake:orbit-careers"] },
    })).resolves.toMatchObject({ ok: true });
  });

  it.each([undefined, "development", "staging", "LOCAL", "tesst"])(
    "APP_ENV=%s 时 fail-closed 拒绝 Fake",
    (appEnv) => {
      expect(() => createConfiguredJobDiscoveryAdapterResolver(appEnv === undefined ? {} : { APP_ENV: appEnv }))
        .toThrow("JobDiscoveryAdapter 环境未获允许");
    },
  );
});
