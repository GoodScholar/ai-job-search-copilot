import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicSourceAccessError } from "@job-copilot/source-access";
import { createPublicSourceClientForTest } from "@job-copilot/source-access/testing";

import { GreenhouseSourceHealthAdapter } from "./greenhouse-source-health-adapter.js";

const targetSnapshot = {
  targetId: "10000000-0000-4000-8000-000000000001", version: 1, priority: "primary" as const, state: "active" as const,
  constraints: {
    roleFamily: "工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
    dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
  },
};
const source = {
  sourceId: "greenhouse:fictional-labs", watchlistItemId: "20000000-0000-4000-8000-000000000002", canonicalCompanyName: "Fictional Labs",
  careersUrl: "https://boards.greenhouse.io/fictional-labs", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "fictional-labs",
};

describe("GreenhouseSourceHealthAdapter", () => {
  const previousAppEnv = process.env.APP_ENV;

  beforeAll(() => { process.env.APP_ENV = "test"; });
  afterAll(() => {
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
  });

  it("将每来源列表的结构损坏归类为 parser_degraded，并保留一次安全尝试证据", async () => {
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"secret":"not-leaked"}') }),
    });

    await expect(new GreenhouseSourceHealthAdapter({ client }).listSource({ targetSnapshot, source })).resolves.toEqual({
      ok: false,
      failure: { category: "parser_degraded", reasonCode: "SOURCE_LIST_SCHEMA_INVALID", retryable: false, attemptCount: 1 },
    });
  });

  it("按来源返回已观察岗位和候选岗位，且成功也保留请求次数", async () => {
    const body = { jobs: [{ id: 701, title: "Platform Engineer", location: { name: "Beijing" } }], meta: { total: 1 } };
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) }),
    });

    await expect(new GreenhouseSourceHealthAdapter({ client }).listSource({ targetSnapshot: { ...targetSnapshot, constraints: { ...targetSnapshot.constraints, roleFamily: "Platform" } }, source })).resolves.toEqual({
      ok: true,
      data: { sourceId: source.sourceId, observedDetailIds: ["701"], candidates: [{ sourceId: source.sourceId, detailId: "701", company: null, title: "Platform Engineer", location: "Beijing" }] },
      attemptCount: 1,
    });
  });

  it.each([
    ["missing fields", { id: 701 }, "SOURCE_DETAIL_FIELDS_MISSING"],
    ["invalid absolute URL", { id: 701, title: "Platform Engineer", company_name: "Fictional Labs", location: { name: "Beijing" }, first_published: "2026-08-17T08:30:00.000Z", application_deadline: null, absolute_url: "/jobs/701" }, "SOURCE_DETAIL_URL_INVALID"],
    ["identity mismatch", { id: 999, title: "Platform Engineer", company_name: "Fictional Labs", location: { name: "Beijing" }, first_published: "2026-08-17T08:30:00.000Z", application_deadline: null, absolute_url: "https://boards.greenhouse.io/fictional-labs/jobs/701" }, "SOURCE_DETAIL_IDENTITY_INVALID"],
  ])("将详情 %s 归类为结构化 parser 失败", async (_label, body, reasonCode) => {
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) }),
    });

    await expect(new GreenhouseSourceHealthAdapter({ client }).getSourceDetail({ source, detailId: "701" })).resolves.toEqual({
      ok: false, failure: { category: "parser_degraded", reasonCode, retryable: false, attemptCount: 1 },
    });
  });

  it("在既有有界重试后将 429 保留为 rate_limited", async () => {
    let requests = 0;
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }], sleep: async () => undefined,
      transport: async () => { requests += 1; return { status: 429, headers: { "content-type": "application/json" }, body: new Uint8Array() }; },
    });

    await expect(new GreenhouseSourceHealthAdapter({ client }).listSource({ targetSnapshot, source })).resolves.toEqual({
      ok: false, failure: { category: "rate_limited", reasonCode: "SOURCE_RATE_LIMITED", retryable: true, attemptCount: 2 },
    });
    expect(requests).toBe(2);
  });

  it.each([
    ["auth", async () => ({ status: 401, headers: { "content-type": "application/json" }, body: new Uint8Array() }), "SOURCE_AUTH_FAILED", false, 1],
    ["server", async () => ({ status: 500, headers: { "content-type": "application/json" }, body: new Uint8Array() }), "SOURCE_SERVER_ERROR", true, 2],
    ["timeout", async () => { throw new PublicSourceAccessError("PUBLIC_SOURCE_TIMEOUT", 2); }, "SOURCE_TIMEOUT", true, 2],
    ["unreachable", async () => { throw new PublicSourceAccessError("PUBLIC_SOURCE_UNREACHABLE", 2); }, "SOURCE_UNREACHABLE", true, 2],
  ])("将 %s 归类为 hard_failed", async (_label, transport, reasonCode, retryable, attemptCount) => {
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }], sleep: async () => undefined,
      transport,
    });

    await expect(new GreenhouseSourceHealthAdapter({ client }).listSource({ targetSnapshot, source })).resolves.toEqual({
      ok: false, failure: { category: "hard_failed", reasonCode, retryable, attemptCount },
    });
  });

  it("将未经授权的来源归类为安全的 policy hard failure，且不请求网络", async () => {
    let requests = 0;
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => { requests += 1; throw new Error("must not request"); },
    });
    const denied = { ...source, allowedDomains: ["boards.greenhouse.io"] };

    await expect(new GreenhouseSourceHealthAdapter({ client }).listSource({ targetSnapshot, source: denied as typeof source })).resolves.toEqual({
      ok: false, failure: { category: "hard_failed", reasonCode: "SOURCE_POLICY_REJECTED", retryable: false, attemptCount: 1 },
    });
    expect(requests).toBe(0);
  });
});
