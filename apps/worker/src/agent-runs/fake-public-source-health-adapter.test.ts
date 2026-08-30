import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakePublicSourceHealthAdapter } from "./fake-public-source-health-adapter.js";

const targetSnapshot = {
  targetId: "10000000-0000-4000-8000-000000000001", version: 1, priority: "primary" as const, state: "active" as const,
  constraints: {
    roleFamily: "Engineer", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
    dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
  },
};
const healthy = {
  sourceId: "greenhouse:healthy", watchlistItemId: "20000000-0000-4000-8000-000000000002", canonicalCompanyName: "Healthy Inc",
  careersUrl: "https://boards.greenhouse.io/healthy", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "healthy",
};
const zero = { ...healthy, sourceId: "greenhouse:zero", watchlistItemId: "30000000-0000-4000-8000-000000000003", canonicalCompanyName: "Zero Inc", careersUrl: "https://boards.greenhouse.io/zero", boardToken: "zero" };

describe("FakePublicSourceHealthAdapter", () => {
  const previousAppEnv = process.env.APP_ENV;

  beforeAll(() => { process.env.APP_ENV = "test"; });
  afterAll(() => {
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
  });

  it("以稳定的单来源结果覆盖 healthy、zero 与混合来源", async () => {
    const adapter = new FakePublicSourceHealthAdapter({ [zero.sourceId]: "zero_valid_results" });

    await expect(adapter.listSource({ targetSnapshot, source: healthy })).resolves.toEqual({
      ok: true,
      data: { sourceId: healthy.sourceId, observedDetailIds: ["healthy-engineer-001"], candidates: [{ sourceId: healthy.sourceId, detailId: "healthy-engineer-001", company: null, title: "Engineer", location: "Beijing" }] },
      attemptCount: 1,
    });
    await expect(adapter.listSource({ targetSnapshot, source: zero })).resolves.toEqual({
      ok: true, data: { sourceId: zero.sourceId, observedDetailIds: [], candidates: [] }, attemptCount: 1,
    });
  });

  it.each([
    ["missing_field", "SOURCE_DETAIL_FIELDS_MISSING"],
    ["invalid_url", "SOURCE_DETAIL_URL_INVALID"],
    ["invalid_identity", "SOURCE_DETAIL_IDENTITY_INVALID"],
  ] as const)("将 %s 固定为对应的 parser 场景", async (scenario, reasonCode) => {
    const adapter = new FakePublicSourceHealthAdapter({ [healthy.sourceId]: scenario });

    await expect(adapter.getSourceDetail({ source: healthy, detailId: "healthy-engineer-001" })).resolves.toEqual({
      ok: false, failure: { category: "parser_degraded", reasonCode, retryable: false, attemptCount: 1 },
    });
  });

  it.each([
    ["rate_limited", { category: "rate_limited", reasonCode: "SOURCE_RATE_LIMITED", retryable: true, attemptCount: 2 }],
    ["hard_failed", { category: "hard_failed", reasonCode: "SOURCE_UNREACHABLE", retryable: true, attemptCount: 2 }],
  ] as const)("将 %s 固定为可审计的来源失败", async (scenario, failure) => {
    const adapter = new FakePublicSourceHealthAdapter({ [healthy.sourceId]: scenario });

    await expect(adapter.listSource({ targetSnapshot, source: healthy })).resolves.toEqual({ ok: false, failure });
  });

  it("拒绝在非测试环境构造 Fake public adapter", () => {
    expect(() => new FakePublicSourceHealthAdapter({}, "production")).toThrow("FAKE_PUBLIC_SOURCE_HEALTH_TEST_ONLY");
  });
});
