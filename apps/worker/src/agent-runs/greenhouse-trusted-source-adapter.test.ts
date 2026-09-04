import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicSourceClient } from "@job-copilot/source-access";

import { GreenhouseTrustedSourceAdapter } from "./greenhouse-trusted-source-adapter.js";

const source = {
  sourceId: "greenhouse:example", watchlistItemId: "10000000-0000-4000-8000-000000000001", canonicalCompanyName: "Example",
  careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "example",
};
const targetSnapshot = {
  targetId: "20000000-0000-4000-8000-000000000002", version: 1, priority: "primary" as const, state: "active" as const,
  constraints: { roleFamily: "Engineer", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } },
};

describe("GreenhouseTrustedSourceAdapter", () => {
  const previousAppEnv = process.env.APP_ENV;

  beforeEach(() => { process.env.APP_ENV = "test"; });
  afterEach(() => {
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
  });

  it("使用冻结来源并将同一 AbortSignal 原样传到列表与详情 PublicSourceClient 调用", async () => {
    const calls: Array<{ url: URL; signal: AbortSignal | undefined }> = [];
    const client: PublicSourceClient = {
      get: vi.fn(async ({ url, signal }) => {
        calls.push({ url, signal });
        const body = url.pathname.endsWith("/jobs")
          ? { jobs: [{ id: 7, title: "Platform Engineer", location: { name: "Shanghai" } }], meta: { total: 1 } }
          : { id: 7, title: "Platform Engineer", company_name: "Example", location: { name: "Shanghai" }, first_published: "2026-08-30T00:00:00.000Z", application_deadline: null };
        return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)), finalUrl: url, attemptCount: 1 };
      }),
    };
    const adapter = new GreenhouseTrustedSourceAdapter({ client });
    const controller = new AbortController();

    await expect(adapter.listSource({ source, targetSnapshot, signal: controller.signal })).resolves.toMatchObject({ ok: true, data: { sourceId: source.sourceId, observedDetailIds: ["7"], candidates: [{ sourceId: source.sourceId, detailId: "7" }] } });
    await expect(adapter.getSourceDetail({ source, detailId: "7", signal: controller.signal })).resolves.toMatchObject({ ok: true, data: { sourceId: source.sourceId, detailId: "7", sourceType: "company_careers", isOfficial: true } });
    expect(calls).toEqual([
      { url: new URL("https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true"), signal: controller.signal },
      { url: new URL("https://boards-api.greenhouse.io/v1/boards/example/jobs/7"), signal: controller.signal },
    ]);
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input.retry)).toEqual(["none", "none"]);
  });
});
