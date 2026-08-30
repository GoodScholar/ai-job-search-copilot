import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentRunJobResults,
  agentRuns,
  createDatabase,
  jobAccounts,
  jobDiscoveryAttributions,
  jobDiscoveryLeads,
  jobOpportunities,
  jobSourcePostingVersions,
  jobSourcePostings,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createJobDiscoveryLeadRepository } from "./job-discovery-leads";
import { createVerifiedJobSourceGate } from "./verified-job-source-gate";

const now = new Date("2026-08-30T12:00:00.000Z");
const normalizedUrl = "https://careers.acme.com/jobs/123?job=123";
const candidateFingerprint = createHash("sha256").update(normalizedUrl, "utf8").digest("hex");
const queryFingerprint = "b".repeat(64);

class EvidenceStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  failAtPut: number | null = null;

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/html" | "text/plain" }): Promise<{ created: boolean }> {
    this.puts.push(input.objectKey);
    if (this.failAtPut === this.puts.length) throw new Error("object store unavailable");
    const created = !this.objects.has(input.objectKey);
    if (created) this.objects.set(input.objectKey, input.bytes);
    return { created };
  }

  async delete(input: { objectKey: string }): Promise<void> {
    this.deletes.push(input.objectKey);
    this.objects.delete(input.objectKey);
  }
}

describe("verified public job source gate", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  async function owner(url = normalizedUrl, queryKind: "general" | "target_company" = "target_company") {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const queryId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active" });
    await database.insert(agentRuns).values({
      id: runId, userId, targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1,
      targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "workflow-v4", ruleVersion: "rules-v1",
      adapter: "layered-public", adapterVersion: "v1", outputSchemaVersion: "result-v4", toolAllowlist: [],
      status: "queued", currentStep: "queued", createdAt: now, updatedAt: now, queuedAt: now,
    });
    const lead = await createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() }).recordPending({
      userId, runId, targetId, queryId, queryKind, queryFingerprint, normalizedUrl: url,
      stableFingerprint: createHash("sha256").update(url, "utf8").digest("hex"), now,
    });
    return { userId, runId, targetId, queryId, leadId: lead.leadId };
  }

  async function anotherLead(subject: { userId: string; targetId: string }, url = normalizedUrl) {
    const runId = crypto.randomUUID();
    const queryId = crypto.randomUUID();
    await database.insert(agentRuns).values({
      id: runId, userId: subject.userId, targetId: subject.targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1,
      targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "workflow-v4", ruleVersion: "rules-v1",
      adapter: "layered-public", adapterVersion: "v1", outputSchemaVersion: "result-v4", toolAllowlist: [],
      status: "queued", currentStep: "queued", createdAt: now, updatedAt: now, queuedAt: now,
    });
    const lead = await createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() }).recordPending({
      userId: subject.userId, runId, targetId: subject.targetId, queryId, queryKind: "target_company", queryFingerprint,
      normalizedUrl: url, stableFingerprint: createHash("sha256").update(url, "utf8").digest("hex"), now,
    });
    return { userId: subject.userId, runId, targetId: subject.targetId, queryId, leadId: lead.leadId };
  }

  function page(url = normalizedUrl) {
    return {
      requestedUrl: url,
      finalUrl: url,
      canonicalUrl: url,
      rawHtml: "<main><h1>Senior Engineer</h1><p>Local source evidence only.</p></main>",
      visibleText: "# Senior Engineer\nLocal source evidence only.",
      pageClassification: "job" as const,
      sourceKind: "official" as const,
    };
  }

  it("仅由本地已验证页面建立真实来源版本，并把 AnySearch 保持为归因", async () => {
    const subject = await owner();
    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });

    const result = await gate.verify({
      userId: subject.userId, leadId: subject.leadId,
      candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint },
      extract: { normalizedUrl }, page: page(), now,
    });

    expect(result.lead).toMatchObject({ leadId: subject.leadId, state: "verified" });
    expect(result.attribution).toMatchObject({ leadId: subject.leadId, provider: "anysearch", queryId: subject.queryId });
    expect(result.sourcePosting).toMatchObject({ sourceIdentifier: createHash("sha256").update(normalizedUrl, "utf8").digest("hex"), sourceId: normalizedUrl, sourceType: "company_careers", isOfficial: true });
    expect(result.sourcePosting.sourceIdentity).toEqual({ taxonomyPolicy: "public-job-source-taxonomy-v1", canonicalUrl: normalizedUrl, finalUrl: normalizedUrl });
    expect(result.sourcePostingVersion.rawObjectReference).toEqual(expect.objectContaining({ rawHtmlObjectKey: expect.stringContaining(`/public-job-pages/`), visibleTextObjectKey: expect.stringContaining(`/public-job-pages/`) }));
    expect(JSON.stringify(result)).not.toContain("AnySearch title sentinel");
    expect(store.objects).toHaveLength(2);
    await expect(Promise.all([
      database.select().from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.id, subject.leadId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, subject.leadId)),
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, subject.userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, subject.userId)),
      database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, subject.userId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, subject.userId)),
    ])).resolves.toEqual([
      [expect.objectContaining({ state: "verified" })],
      [expect.objectContaining({ provider: "anysearch" })],
      [expect.objectContaining({ sourceId: normalizedUrl })],
      [expect.objectContaining({ sourcePostingId: result.sourcePosting.postingId })],
      [],
      [],
    ]);
  });

  it("拒绝终态页面错误但不把可重试错误变为 rejected", async () => {
    const terminalCodes = [
      "JOB_PAGE_URL_INVALID", "JOB_PAGE_TARGET_REJECTED", "JOB_PAGE_REDIRECT_INVALID", "JOB_PAGE_LOGIN_REQUIRED",
      "JOB_PAGE_LISTING", "JOB_PAGE_EXPIRED", "JOB_PAGE_UNRECOGNIZED", "JOB_PAGE_RESPONSE_TOO_LARGE", "JOB_PAGE_CONTENT_TYPE_INVALID",
    ] as const;
    const retryableCodes = ["JOB_PAGE_TIMEOUT", "JOB_PAGE_CANCELLED", "JOB_PAGE_UNREACHABLE", "JOB_PAGE_RATE_LIMITED"] as const;
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() });

    for (const code of terminalCodes) {
      const subject = await owner();
      await expect(gate.reject({ userId: subject.userId, leadId: subject.leadId, code, now }))
        .resolves.toMatchObject({ state: "rejected", rejectionCode: code, sourcePostingVersionId: null });
      await expect(Promise.all([
        database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, subject.userId)),
        database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, subject.leadId)),
      ])).resolves.toEqual([[], []]);
    }
    for (const code of retryableCodes) {
      const subject = await owner();
      await expect(gate.reject({ userId: subject.userId, leadId: subject.leadId, code, now }))
        .rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_RETRYABLE_FAILURE" });
      await expect(createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() }).getLead({ userId: subject.userId, leadId: subject.leadId, now }))
        .resolves.toMatchObject({ state: "pending" });
    }
  });

  it("对象写入失败会补偿仅本次新对象且不会留下来源记录", async () => {
    for (const failAtPut of [1, 2]) {
      const subject = await owner();
      const store = new EvidenceStore();
      store.failAtPut = failAtPut;
      const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });

      await expect(gate.verify({
        userId: subject.userId, leadId: subject.leadId,
        candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
      })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_STORAGE_FAILED" });
      expect(store.objects).toEqual(new Map());
      expect(store.deletes).toEqual(failAtPut === 1 ? [] : [store.puts[0]]);
      await expect(Promise.all([
        database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, subject.userId)),
        database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, subject.userId)),
        database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, subject.leadId)),
      ])).resolves.toEqual([[], [], []]);
    }
  });

  it("Attribution 持久化冲突会回滚来源并仅补偿本次写入的对象", async () => {
    const first = await owner();
    const firstStore = new EvidenceStore();
    const firstResult = await createVerifiedJobSourceGate({ db: database, contentStore: firstStore, id: () => crypto.randomUUID() }).verify({
      userId: first.userId, leadId: first.leadId,
      candidate: { queryId: first.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });
    const secondUrl = "https://careers.acme.com/jobs/999?job=999";
    const secondFingerprint = createHash("sha256").update(secondUrl, "utf8").digest("hex");
    const second = await owner(secondUrl);
    const store = new EvidenceStore();
    store.objects.set("already-referenced", new Uint8Array([1]));
    const ids = [crypto.randomUUID(), crypto.randomUUID(), firstResult.attribution.attributionId];
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => ids.shift()! });

    await expect(gate.verify({
      userId: second.userId, leadId: second.leadId,
      candidate: { queryId: second.queryId, normalizedUrl: secondUrl, candidateFingerprint: secondFingerprint },
      extract: { normalizedUrl: secondUrl }, page: page(secondUrl), now,
    })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_PERSIST_FAILED" });
    expect(store.objects).toEqual(new Map([["already-referenced", new Uint8Array([1])]]));
    expect(store.deletes).toEqual(store.puts);
    await expect(Promise.all([
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, second.userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, second.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, second.leadId)),
    ])).resolves.toEqual([[], [], []]);
  });

  it("严格校验整个候选链，拒绝不匹配与 provider content 而不写入任何事实", async () => {
    const subject = await owner();
    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
    const valid = {
      userId: subject.userId, leadId: subject.leadId,
      candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    };
    const foreignUrl = "https://jobs.example.net/123?job=123";
    for (const invalid of [
      { ...valid, candidate: { ...valid.candidate, candidateFingerprint: "c".repeat(64) } },
      { ...valid, extract: { normalizedUrl: foreignUrl } },
      { ...valid, page: { ...page(), requestedUrl: foreignUrl } },
      { ...valid, page: { ...page(), finalUrl: foreignUrl } },
      { ...valid, page: { ...page(), canonicalUrl: foreignUrl } },
      { ...valid, extract: { normalizedUrl, content: "provider-content-sentinel" } },
      { ...valid, title: "provider-title-sentinel" },
    ]) {
      await expect(gate.verify(invalid)).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_INVALID_INPUT" });
    }
    for (const conflicting of [
      { ...valid, candidate: { ...valid.candidate, queryId: crypto.randomUUID() } },
      { ...valid, candidate: { queryId: subject.queryId, normalizedUrl: foreignUrl, candidateFingerprint: createHash("sha256").update(foreignUrl, "utf8").digest("hex") }, extract: { normalizedUrl: foreignUrl }, page: page(foreignUrl) },
    ]) {
      await expect(gate.verify(conflicting)).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_LEAD_CONFLICT" });
    }
    expect(store.puts).toEqual([]);
    await expect(Promise.all([
      createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() }).getLead({ userId: subject.userId, leadId: subject.leadId, now }),
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, subject.userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, subject.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, subject.leadId)),
    ])).resolves.toEqual([
      expect.objectContaining({ state: "pending" }), [], [], [],
    ]);
  });

  it("按 canonical 与双 hash 去重来源版本，并让两个 Lead 独立归因且 replay 零写入", async () => {
    const first = await owner();
    const second = await anotherLead(first);
    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
    const firstInput = { userId: first.userId, leadId: first.leadId, candidate: { queryId: first.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now };
    const firstResult = await gate.verify(firstInput);
    const putCount = store.puts.length;
    const replay = await gate.verify(firstInput);
    const secondResult = await gate.verify({
      userId: second.userId, leadId: second.leadId,
      candidate: { queryId: second.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });

    expect(replay).toEqual(firstResult);
    expect(secondResult.sourcePostingVersion.sourcePostingVersionId).toBe(firstResult.sourcePostingVersion.sourcePostingVersionId);
    expect(store.puts).toHaveLength(putCount);
    await expect(Promise.all([
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, first.userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, first.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.userId, first.userId)),
    ])).resolves.toEqual([
      [expect.objectContaining({ id: firstResult.sourcePosting.postingId })],
      [expect.objectContaining({ id: firstResult.sourcePostingVersion.sourcePostingVersionId, version: 1 })],
      expect.arrayContaining([
        expect.objectContaining({ leadId: first.leadId, sourcePostingVersionId: firstResult.sourcePostingVersion.sourcePostingVersionId }),
        expect.objectContaining({ leadId: second.leadId, sourcePostingVersionId: firstResult.sourcePostingVersion.sourcePostingVersionId }),
      ]),
    ]);
  });

  it("任一真实页面 hash 改变会追加版本，而不会创建第二个 canonical posting", async () => {
    const first = await owner();
    const second = await anotherLead(first);
    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
    const firstResult = await gate.verify({
      userId: first.userId, leadId: first.leadId,
      candidate: { queryId: first.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });
    const secondResult = await gate.verify({
      userId: second.userId, leadId: second.leadId,
      candidate: { queryId: second.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl },
      page: { ...page(), rawHtml: "<main><h1>Senior Engineer</h1><p>Changed local raw evidence.</p></main>" }, now,
    });

    expect(secondResult.sourcePosting.postingId).toBe(firstResult.sourcePosting.postingId);
    expect(secondResult.sourcePostingVersion.version).toBe(2);
    expect(secondResult.sourcePostingVersion.rawContentSha256).not.toBe(firstResult.sourcePostingVersion.rawContentSha256);
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.sourcePostingId, firstResult.sourcePosting.postingId)))
      .resolves.toHaveLength(2);
  });

  it("采用固定 taxonomy，只由本地 canonical host 和 fetched sourceKind 派生真实来源身份", async () => {
    const platformUrl = "https://www.zhipin.com/job/123?job=123";
    const platformFingerprint = createHash("sha256").update(platformUrl, "utf8").digest("hex");
    const subject = await owner(platformUrl);
    const result = await createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }).verify({
      userId: subject.userId, leadId: subject.leadId,
      candidate: { queryId: subject.queryId, normalizedUrl: platformUrl, candidateFingerprint: platformFingerprint },
      extract: { normalizedUrl: platformUrl }, page: { ...page(platformUrl), sourceKind: "aggregator" }, now,
    });

    expect(result.sourcePosting).toMatchObject({ sourceType: "recruitment_platform", sourceId: platformUrl, isOfficial: false });
    expect(result.sourcePosting.sourceIdentity).toEqual({ taxonomyPolicy: "public-job-source-taxonomy-v1", canonicalUrl: platformUrl, finalUrl: platformUrl });

    const atsUrl = "https://job-boards.greenhouse.io/acme/jobs/456?job=456";
    const atsFingerprint = createHash("sha256").update(atsUrl, "utf8").digest("hex");
    const ats = await owner(atsUrl, "general");
    const atsResult = await createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }).verify({
      userId: ats.userId, leadId: ats.leadId,
      candidate: { queryId: ats.queryId, normalizedUrl: atsUrl, candidateFingerprint: atsFingerprint },
      extract: { normalizedUrl: atsUrl }, page: { ...page(atsUrl), sourceKind: "official" }, now,
    });
    expect(atsResult.sourcePosting).toMatchObject({ sourceType: "company_careers", isOfficial: true });
  });
});
