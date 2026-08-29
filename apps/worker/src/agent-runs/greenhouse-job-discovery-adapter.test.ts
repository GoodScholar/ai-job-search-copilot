import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPublicSourceClientForTest } from "@job-copilot/source-access/testing";
import { PublicDiscoveryBatchSearchResultSchema } from "@job-copilot/contracts/agent-runs";

import { GreenhouseDetailResponseSchema, GreenhouseJobDiscoveryAdapter } from "./greenhouse-job-discovery-adapter.js";

const fixture = async (name: string) => JSON.parse(await readFile(fileURLToPath(new URL(`./fixtures/greenhouse/${name}`, import.meta.url)), "utf8")) as unknown;
const targetSnapshot = {
  targetId: "10000000-0000-4000-8000-000000000001", version: 1, priority: "primary" as const, state: "active" as const,
  constraints: { roleFamily: "Engineer", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } },
};
const source = { sourceId: "greenhouse:fictional-labs", watchlistItemId: "20000000-0000-4000-8000-000000000002", canonicalCompanyName: "Snapshot Company", careersUrl: "https://boards.greenhouse.io/fictional-labs", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "fictional-labs" };
const scope = { kind: "company_watchlist" as const, adapter: "greenhouse" as const, adapterVersion: "greenhouse-job-board-v1" as const, watchlistVersion: 1, sources: [source] };

describe("GreenhouseJobDiscoveryAdapter", () => {
  it("uses exactly one list GET, preserves a full scan beyond five candidates, and obtains detail fields only from the detail GET", async () => {
    const list = await fixture("list-jobs.json");
    const detail = await fixture("job-detail.json");
    const requests: URL[] = [];
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async ({ url }) => {
        requests.push(url);
        const body = url.pathname.endsWith("/jobs") ? list : detail;
        return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) };
      },
    });
    const adapter = new GreenhouseJobDiscoveryAdapter({ client });

    const batch = await adapter.searchBatch({ targetSnapshot, sourceScope: scope });
    expect(batch).toMatchObject({ ok: true, data: { scans: [{ sourceId: "greenhouse:fictional-labs", observedDetailIds: ["701", "702", "703", "704", "705", "706"], complete: true }] } });
    if (!batch.ok) throw new Error("expected successful fixture response");
    expect(batch.data.items[0]).toEqual({ sourceId: "greenhouse:fictional-labs", detailId: "701", company: null, title: "Machine Learning Engineer", location: "Beijing" });
    const parsedBatch = PublicDiscoveryBatchSearchResultSchema.parse(batch);
    if (!parsedBatch.ok) throw new Error("expected parsed public batch");
    expect(parsedBatch.data.items).toHaveLength(5);
    expect(requests).toEqual([new URL("https://boards-api.greenhouse.io/v1/boards/fictional-labs/jobs?content=true")]);

    const result = await adapter.getDetail({ sourceId: source.sourceId, detailId: "701" });
    expect(result).toEqual({ ok: true, data: { sourceId: "greenhouse:fictional-labs", detailId: "701", company: "Fictional Labs", title: "Machine Learning Engineer", location: "Beijing", postedAt: "2026-08-17T08:30:00.000Z", deadline: "2026-09-30T15:59:59.000Z", sourceType: "company_careers", isOfficial: true, rawPayload: detail } });
    expect(requests).toEqual([
      new URL("https://boards-api.greenhouse.io/v1/boards/fictional-labs/jobs?content=true"),
      new URL("https://boards-api.greenhouse.io/v1/boards/fictional-labs/jobs/701"),
    ]);
  });

  it("keeps list fixtures structurally unable to impersonate detail fixtures, including empty and incomplete scans", async () => {
    expect(GreenhouseDetailResponseSchema.safeParse(await fixture("list-jobs.json")).success).toBe(false);
    const empty = await fixture("empty-list-jobs.json");
    const invalid = await fixture("invalid-list-jobs.json");
    const responses = [empty, invalid];
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io", lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(responses.shift())) }),
    });
    const adapter = new GreenhouseJobDiscoveryAdapter({ client });
    await expect(adapter.searchBatch({ targetSnapshot, sourceScope: scope })).resolves.toEqual({ ok: true, data: { items: [], scans: [{ sourceId: source.sourceId, observedDetailIds: [], complete: true }] } });
    await expect(adapter.searchBatch({ targetSnapshot, sourceScope: scope })).resolves.toEqual({ ok: false, error: { code: "GREENHOUSE_LIST_SCHEMA_INVALID", retryable: false } });
  });

  it("rejects a source lacking the exact API host before invoking the public client", async () => {
    let lookups = 0;
    const client = createPublicSourceClientForTest({ exactHosts: ["boards-api.greenhouse.io"], lookup: async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 }]; } });
    const adapter = new GreenhouseJobDiscoveryAdapter({ client });
    const denied = { ...scope, sources: [{ ...source, allowedDomains: ["greenhouse.io"] }] };
    await expect(adapter.searchBatch({ targetSnapshot, sourceScope: denied })).resolves.toEqual({ ok: false, error: { code: "GREENHOUSE_API_HOST_NOT_ALLOWED", retryable: false } });
    expect(lookups).toBe(0);
  });

  it("validates every source before the first list request, so a later policy source produces zero DNS and transport", async () => {
    let lookups = 0;
    let transports = 0;
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"],
      lookup: async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 }]; },
      transport: async () => { transports += 1; throw new Error("must not transport"); },
    });
    const second = { ...source, sourceId: "greenhouse:second-board", careersUrl: "https://job-boards.greenhouse.io/second-board", boardToken: "second-board", allowedDomains: ["greenhouse.io"] };
    const result = await new GreenhouseJobDiscoveryAdapter({ client }).searchBatch({ targetSnapshot, sourceScope: { ...scope, sources: [source, second] } });
    expect(result).toEqual({ ok: false, error: { code: "GREENHOUSE_API_HOST_NOT_ALLOWED", retryable: false } });
    expect({ lookups, transports }).toEqual({ lookups: 0, transports: 0 });
  });

  it("invalidates successful generation state before empty or failed replacement batches", async () => {
    const list = await fixture("list-jobs.json");
    const empty = await fixture("empty-list-jobs.json");
    const responses = [list, await fixture("job-detail.json"), empty, list, { failure: 500 }, { failure: 500 }];
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io", lookup: async () => [{ address: "93.184.216.34", family: 4 }], sleep: async () => undefined,
      transport: async () => {
        const next = responses.shift();
        if (next && typeof next === "object" && "failure" in next) return { status: Number(next.failure), headers: { "content-type": "application/json" }, body: new Uint8Array() };
        return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(next)) };
      },
    });
    const adapter = new GreenhouseJobDiscoveryAdapter({ client });
    await expect(adapter.searchBatch({ targetSnapshot, sourceScope: scope })).resolves.toMatchObject({ ok: true });
    await expect(adapter.getDetail({ sourceId: source.sourceId, detailId: "701" })).resolves.toMatchObject({ ok: true });
    await expect(adapter.searchBatch({ targetSnapshot, sourceScope: scope })).resolves.toMatchObject({ ok: true });
    await expect(adapter.getDetail({ sourceId: source.sourceId, detailId: "701" })).resolves.toEqual({ ok: false, error: { code: "GREENHOUSE_DETAIL_NOT_SELECTED", retryable: false } });
    const second = { ...source, sourceId: "greenhouse:second-board", careersUrl: "https://job-boards.greenhouse.io/second-board", boardToken: "second-board" };
    await expect(adapter.searchBatch({ targetSnapshot, sourceScope: { ...scope, sources: [source, second] } })).resolves.toEqual({ ok: false, error: { code: "GREENHOUSE_SERVER_ERROR", retryable: true } });
    await expect(adapter.getDetail({ sourceId: source.sourceId, detailId: "701" })).resolves.toEqual({ ok: false, error: { code: "GREENHOUSE_DETAIL_NOT_SELECTED", retryable: false } });
  });

  it("does not cache a failed detail, caches a success, and resets that cache for an updated generation", async () => {
    const list = await fixture("list-jobs.json");
    const detail = await fixture("job-detail.json");
    const updated = await fixture("updated-job-detail.json");
    let requests = 0;
    const responses = [list, { failure: 404 }, detail, list, updated];
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io", lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => {
        requests += 1;
        const next = responses.shift();
        if (next && typeof next === "object" && "failure" in next) return { status: Number(next.failure), headers: { "content-type": "application/json" }, body: new Uint8Array() };
        return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(next)) };
      },
    });
    const adapter = new GreenhouseJobDiscoveryAdapter({ client });
    await adapter.searchBatch({ targetSnapshot, sourceScope: scope });
    await expect(adapter.getDetail({ sourceId: source.sourceId, detailId: "701" })).resolves.toEqual({ ok: false, error: { code: "GREENHOUSE_NOT_FOUND", retryable: false } });
    await expect(adapter.getDetail({ sourceId: source.sourceId, detailId: "701" })).resolves.toMatchObject({ ok: true });
    const afterSuccess = requests;
    await expect(adapter.getDetail({ sourceId: source.sourceId, detailId: "701" })).resolves.toMatchObject({ ok: true });
    expect(requests).toBe(afterSuccess);
    await adapter.searchBatch({ targetSnapshot, sourceScope: scope });
    await expect(adapter.getDetail({ sourceId: source.sourceId, detailId: "701" })).resolves.toMatchObject({ ok: true, data: { title: "Senior Machine Learning Engineer", deadline: "2026-10-15T15:59:59.000Z" } });
  });

  it("maps untrusted list failures to stable codes without response bodies or URLs", async () => {
    let attempts = 0;
    const client = createPublicSourceClientForTest({
      exactHosts: ["boards-api.greenhouse.io"], testOrigin: "https://boards-api.greenhouse.io", lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => { attempts += 1; return { status: 429, headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"secret":"do-not-leak"}') }; }, sleep: async () => undefined,
    });
    const result = await new GreenhouseJobDiscoveryAdapter({ client }).searchBatch({ targetSnapshot, sourceScope: scope });
    expect(result).toEqual({ ok: false, error: { code: "GREENHOUSE_RATE_LIMITED", retryable: true } });
    expect(attempts).toBe(2);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
