import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentRunJobResults,
  agentRuns,
  auditEvents,
  createDatabase,
  jobAccounts,
  jobDiscoveryAttributions,
  jobDiscoveryLeads,
  jobOpportunities,
  jobSourcePostingVersions,
  jobSourcePostings,
  jobSourceHealthChecks,
  jobTargets,
  migrateDatabase,
  type Database,
} from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCheckpoint } from "./agent-runs";
import { createJobDiscoveryLeadRepository } from "./job-discovery-leads";
import { createVerifiedJobSourceGate, VerifiedJobEvidenceStoreUnavailableError } from "./verified-job-source-gate";

const now = new Date("2026-08-30T12:00:00.000Z");
const normalizedUrl = "https://careers.acme.com/jobs/123?job=123";
const candidateFingerprint = createHash("sha256").update(normalizedUrl, "utf8").digest("hex");
const queryFingerprint = "b".repeat(64);

class EvidenceStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  failAtPut: number | null = null;
  unknownAtPut: { ordinal: number; error: Error } | null = null;
  failDelete = false;
  unknownDelete: Error | null = null;
  onDelete: ((objectKey: string) => Promise<void>) | undefined;

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/html" | "text/plain" }): Promise<{ created: boolean }> {
    this.puts.push(input.objectKey);
    if (this.unknownAtPut?.ordinal === this.puts.length) throw this.unknownAtPut.error;
    if (this.failAtPut === this.puts.length) throw new VerifiedJobEvidenceStoreUnavailableError();
    const created = !this.objects.has(input.objectKey);
    if (created) this.objects.set(input.objectKey, input.bytes);
    return { created };
  }

  async delete(input: { objectKey: string }): Promise<void> {
    this.deletes.push(input.objectKey);
    await this.onDelete?.(input.objectKey);
    if (this.unknownDelete) throw this.unknownDelete;
    if (this.failDelete) throw new VerifiedJobEvidenceStoreUnavailableError();
    this.objects.delete(input.objectKey);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function generationId(userId: string, leadId: string, sourceType: string, canonicalUrl: string, rawHash: string, visibleHash: string): string {
  const value = createHash("sha256").update([
    "public-job-source-generation-v1", userId, leadId, sourceType, canonicalUrl, rawHash, visibleHash,
  ].join("\u001f"), "utf8").digest();
  value[6] = (value[6]! & 0x0f) | 0x80;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = value.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

  async function owner(url = normalizedUrl, queryKind: "general" | "target_company" | "site_constrained" = "target_company") {
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

  async function noWrites(userId: string, leadId: string, store: EvidenceStore) {
    await expect(Promise.all([
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, leadId)),
      database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, userId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, userId)),
    ])).resolves.toEqual([[], [], [], [], []]);
    expect(store.puts).toEqual([]);
  }

  it("旧 claim authority 在接管后不能 verify 或留下 evidence，new claim 可完成", async () => {
    const subject = await owner(); const oldToken = crypto.randomUUID(); const newToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", startedAt: now, claimToken: oldToken, claimExpiresAt: new Date(Date.now() + 60_000), activeSliceStartedAt: now }).where(eq(agentRuns.id, subject.runId));
    await database.update(agentRuns).set({ claimToken: newToken, claimExpiresAt: new Date(Date.now() + 60_000) }).where(eq(agentRuns.id, subject.runId));
    const store = new EvidenceStore(); const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
    const input = { userId: subject.userId, leadId: subject.leadId, candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now };
    await expect(gate.verifyForClaim({ ...input, claimToken: oldToken })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLAIM_STALE" });
    await noWrites(subject.userId, subject.leadId, store);
    await expect(gate.verifyForClaim({ ...input, claimToken: newToken })).resolves.toMatchObject({ lead: { state: "verified" } });
  });

  it("旧 claim authority 在接管后不能 reject，new claim 才能终结 Lead", async () => {
    const subject = await owner(); const oldToken = crypto.randomUUID(); const newToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", startedAt: now, claimToken: oldToken, claimExpiresAt: new Date(Date.now() + 60_000), activeSliceStartedAt: now }).where(eq(agentRuns.id, subject.runId));
    await database.update(agentRuns).set({ claimToken: newToken, claimExpiresAt: new Date(Date.now() + 60_000) }).where(eq(agentRuns.id, subject.runId));
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() });
    const input = { userId: subject.userId, leadId: subject.leadId, code: "JOB_PAGE_URL_INVALID" as const, now };
    await expect(gate.rejectForClaim({ ...input, claimToken: oldToken })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLAIM_STALE" });
    await expect(database.select({ state: jobDiscoveryLeads.state }).from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.id, subject.leadId))).resolves.toEqual([{ state: "pending" }]);
    await expect(gate.rejectForClaim({ ...input, claimToken: newToken })).resolves.toMatchObject({ state: "rejected" });
  });

  it("checkpoint continue 后的 claim 接管会原子围栏所有 Lead 与 Gate mutation", async () => {
    const subject = await owner();
    const repository = createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() });
    const verifyLead = subject.leadId;
    const rejectLead = await repository.recordPending({
      userId: subject.userId, runId: subject.runId, targetId: subject.targetId, queryId: crypto.randomUUID(),
      queryKind: "target_company", queryFingerprint, normalizedUrl: "https://careers.acme.com/jobs/456?job=456",
      stableFingerprint: createHash("sha256").update("https://careers.acme.com/jobs/456?job=456", "utf8").digest("hex"), now,
    });
    const oldToken = crypto.randomUUID();
    const newToken = crypto.randomUUID();
    const claimedAt = new Date();
    const claimExpiresAt = new Date(claimedAt.getTime() + 60_000);
    await database.update(agentRuns).set({
      status: "running", startedAt: claimedAt, claimToken: oldToken, claimExpiresAt, activeSliceStartedAt: claimedAt,
    }).where(eq(agentRuns.id, subject.runId));
    const checkpoint = createAgentRunCheckpoint({
      db: database, auditTrail: createAuditTrail({ db: database, clock: () => claimedAt }),
      id: () => crypto.randomUUID(), clock: () => claimedAt,
    });
    await expect(checkpoint.check({
      userId: subject.userId, runId: subject.runId, claimToken: oldToken,
      checkpointKey: `${oldToken}:claim-mutation-fence`,
    })).resolves.toEqual({ kind: "continue" });
    await database.update(agentRuns).set({ claimToken: newToken, claimExpiresAt }).where(eq(agentRuns.id, subject.runId));

    const staleQueryId = crypto.randomUUID();
    const staleUrl = "https://careers.acme.com/jobs/789?job=789";
    await expect(repository.recordPendingForClaim({
      userId: subject.userId, runId: subject.runId, targetId: subject.targetId, queryId: staleQueryId,
      queryKind: "target_company", queryFingerprint, normalizedUrl: staleUrl,
      stableFingerprint: createHash("sha256").update(staleUrl, "utf8").digest("hex"), claimToken: oldToken, now,
    })).rejects.toMatchObject({ code: "JOB_DISCOVERY_CLAIM_STALE" });
    await expect(database.select().from(jobDiscoveryLeads).where(and(eq(jobDiscoveryLeads.runId, subject.runId), eq(jobDiscoveryLeads.queryId, staleQueryId)))).resolves.toEqual([]);

    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
    const verifyInput = {
      userId: subject.userId, leadId: verifyLead,
      candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    };
    await expect(gate.verifyForClaim({ ...verifyInput, claimToken: oldToken })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLAIM_STALE" });
    await noWrites(subject.userId, verifyLead, store);

    const rejectInput = { userId: subject.userId, leadId: rejectLead.leadId, code: "JOB_PAGE_URL_INVALID" as const, now };
    await expect(gate.rejectForClaim({ ...rejectInput, claimToken: oldToken })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLAIM_STALE" });
    await expect(database.select({ state: jobDiscoveryLeads.state }).from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.id, rejectLead.leadId))).resolves.toEqual([{ state: "pending" }]);

    await expect(repository.recordPendingForClaim({
      userId: subject.userId, runId: subject.runId, targetId: subject.targetId, queryId: staleQueryId,
      queryKind: "target_company", queryFingerprint, normalizedUrl: staleUrl,
      stableFingerprint: createHash("sha256").update(staleUrl, "utf8").digest("hex"), claimToken: newToken, now,
    })).resolves.toMatchObject({ state: "pending" });
    await expect(gate.verifyForClaim({ ...verifyInput, claimToken: newToken })).resolves.toMatchObject({ lead: { state: "verified" } });
    await expect(gate.rejectForClaim({ ...rejectInput, claimToken: newToken })).resolves.toMatchObject({ state: "rejected" });
  });

  it.each(["pause_requested", "cancel_requested"] as const)("checkpoint continue 后 %s 会围栏 strict claim mutation，同时保留普通 API", async (controlState) => {
    const subject = await owner();
    const rejectSubject = await anotherLead(subject, "https://careers.acme.com/jobs/456?job=456");
    const repository = createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() }) as any;
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }) as any;
    const claimToken = crypto.randomUUID();
    const claimedAt = new Date();
    const claimExpiresAt = new Date(claimedAt.getTime() + 60_000);
    await database.update(agentRuns).set({ status: "running", startedAt: claimedAt, claimToken, claimExpiresAt, activeSliceStartedAt: claimedAt }).where(eq(agentRuns.id, subject.runId));
    const checkpoint = createAgentRunCheckpoint({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => claimedAt }), id: () => crypto.randomUUID(), clock: () => claimedAt });
    await expect(checkpoint.check({ userId: subject.userId, runId: subject.runId, claimToken, checkpointKey: `${claimToken}:${controlState}` })).resolves.toEqual({ kind: "continue" });
    await database.update(agentRuns).set({ controlState }).where(eq(agentRuns.id, subject.runId));

    const staleUrl = "https://careers.acme.com/jobs/789?job=789";
    await expect(repository.recordPendingForClaim({
      userId: subject.userId, runId: subject.runId, targetId: subject.targetId, queryId: crypto.randomUUID(), queryKind: "target_company", queryFingerprint,
      normalizedUrl: staleUrl, stableFingerprint: createHash("sha256").update(staleUrl, "utf8").digest("hex"), claimToken, now,
    })).rejects.toMatchObject({ code: "JOB_DISCOVERY_CLAIM_STALE" });
    await expect(gate.verifyForClaim({
      userId: subject.userId, leadId: subject.leadId, candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), claimToken, now,
    })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLAIM_STALE" });
    await expect(gate.rejectForClaim({ userId: subject.userId, leadId: rejectSubject.leadId, code: "JOB_PAGE_URL_INVALID", claimToken, now })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLAIM_STALE" });
    await expect(database.select({ state: jobDiscoveryLeads.state }).from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.id, rejectSubject.leadId))).resolves.toEqual([{ state: "pending" }]);
    await expect(repository.recordPending({
      userId: subject.userId, runId: subject.runId, targetId: subject.targetId, queryId: crypto.randomUUID(), queryKind: "target_company", queryFingerprint,
      normalizedUrl: "https://careers.acme.com/jobs/999?job=999", stableFingerprint: createHash("sha256").update("https://careers.acme.com/jobs/999?job=999", "utf8").digest("hex"), now,
    })).resolves.toMatchObject({ state: "pending" });
    await expect(repository.recordPendingForClaim({ userId: subject.userId, runId: subject.runId, targetId: subject.targetId, queryId: crypto.randomUUID(), queryKind: "target_company", queryFingerprint, normalizedUrl: staleUrl, stableFingerprint: createHash("sha256").update(staleUrl, "utf8").digest("hex"), now })).rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_INVALID_INPUT" });
  });

  it("仅由本地已验证页面建立真实来源版本，并把 AnySearch 保持为归因", async () => {
    const subject = await owner();
    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
    const localPage = { ...page(), rawHtml: "<main>raw-local-evidence-sentinel</main>", visibleText: "visible-local-evidence-sentinel" };

    const result = await gate.verify({
      userId: subject.userId, leadId: subject.leadId,
      candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: localPage, now,
    });

    expect(result.lead).toMatchObject({ leadId: subject.leadId, state: "verified" });
    expect(result.attribution).toMatchObject({ leadId: subject.leadId, provider: "anysearch", queryId: subject.queryId });
    expect(result.sourcePosting).toMatchObject({ sourceIdentifier: createHash("sha256").update(normalizedUrl, "utf8").digest("hex"), sourceId: normalizedUrl, sourceType: "company_careers", isOfficial: true });
    expect(result.sourcePosting.sourceIdentity).toEqual({ taxonomyPolicy: "public-job-source-taxonomy-v1", canonicalUrl: normalizedUrl, finalUrl: normalizedUrl, observedFinalUrls: { [normalizedUrl]: normalizedUrl } });
    expect(result.sourcePostingVersion.rawObjectReference).toEqual(expect.objectContaining({ rawHtmlObjectKey: expect.stringContaining(`/public-job-pages/`), visibleTextObjectKey: expect.stringContaining(`/public-job-pages/`) }));
    expect(JSON.stringify(result)).not.toContain("AnySearch title sentinel");
    expect(store.objects).toHaveLength(2);
    const refs = result.sourcePostingVersion.rawObjectReference as { rawHtmlObjectKey: string; visibleTextObjectKey: string };
    expect(store.objects.get(refs.rawHtmlObjectKey)).toEqual(new TextEncoder().encode(localPage.rawHtml));
    expect(store.objects.get(refs.visibleTextObjectKey)).toEqual(new TextEncoder().encode(localPage.visibleText));
    expect(createHash("sha256").update(store.objects.get(refs.rawHtmlObjectKey)!).digest("hex")).toBe(result.sourcePostingVersion.rawContentSha256);
    expect(createHash("sha256").update(store.objects.get(refs.visibleTextObjectKey)!).digest("hex")).toBe(result.sourcePostingVersion.contentSha256);
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
      "JOB_PAGE_LISTING", "JOB_PAGE_EXPIRED", "JOB_PAGE_UNRECOGNIZED", "JOB_PAGE_RESPONSE_TOO_LARGE", "JOB_PAGE_CONTENT_TYPE_INVALID", "POLICY_REJECTED",
    ] as const;
    const retryableCodes = ["JOB_PAGE_TIMEOUT", "JOB_PAGE_CANCELLED", "JOB_PAGE_UNREACHABLE", "JOB_PAGE_RATE_LIMITED"] as const;
    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });

    for (const code of terminalCodes) {
      const subject = await owner();
      await expect(gate.reject({ userId: subject.userId, leadId: subject.leadId, code, now }))
        .resolves.toMatchObject({ state: "rejected", rejectionCode: code, sourcePostingVersionId: null });
      await noWrites(subject.userId, subject.leadId, store);
    }
    for (const code of retryableCodes) {
      const subject = await owner();
      await expect(gate.reject({ userId: subject.userId, leadId: subject.leadId, code, now }))
        .rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_RETRYABLE_FAILURE" });
      await expect(createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() }).getLead({ userId: subject.userId, leadId: subject.leadId, now }))
        .resolves.toMatchObject({ state: "pending" });
      await noWrites(subject.userId, subject.leadId, store);
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

  it("已存在的本次代际目标 key 返回 created=false 时，Attribution 冲突不会删除它们", async () => {
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
    const postingId = crypto.randomUUID();
    const rawHash = createHash("sha256").update(page(secondUrl).rawHtml, "utf8").digest("hex");
    const visibleHash = createHash("sha256").update(page(secondUrl).visibleText, "utf8").digest("hex");
    const sourceVersionId = generationId(second.userId, second.leadId, "company_careers", secondUrl, rawHash, visibleHash);
    const rawKey = `accounts/${second.userId}/public-job-pages/${sourceVersionId}/${rawHash}.html`;
    const visibleKey = `accounts/${second.userId}/public-job-pages/${sourceVersionId}/${visibleHash}.txt`;
    store.objects.set(rawKey, new Uint8Array([1]));
    store.objects.set(visibleKey, new Uint8Array([2]));
    const ids = [postingId, firstResult.attribution.attributionId];
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => ids.shift()! });

    await expect(gate.verify({
      userId: second.userId, leadId: second.leadId,
      candidate: { queryId: second.queryId, normalizedUrl: secondUrl, candidateFingerprint: secondFingerprint },
      extract: { normalizedUrl: secondUrl }, page: page(secondUrl), now,
    })).rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_ATTRIBUTION_CONFLICT" });
    expect(store.puts).toEqual([rawKey, visibleKey]);
    expect(store.deletes).toEqual([]);
    expect(store.objects).toEqual(new Map([[rawKey, new Uint8Array([1])], [visibleKey, new Uint8Array([2])]]));
    await expect(Promise.all([
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, second.userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, second.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, second.leadId)),
    ])).resolves.toEqual([[], [], []]);
  });

  it("删除补偿失败要求可重试清理；相同输入重试会正式引用同一代际对象", async () => {
    const reserved = await owner();
    const reservedResult = await createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }).verify({
      userId: reserved.userId, leadId: reserved.leadId,
      candidate: { queryId: reserved.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });
    const subjectUrl = "https://careers.acme.com/jobs/delete-failure?job=1";
    const subject = await owner(subjectUrl);
    const store = new EvidenceStore();
    store.failDelete = true;
    const ids = [crypto.randomUUID(), reservedResult.attribution.attributionId];
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => ids.shift() ?? crypto.randomUUID() });

    const input = {
      userId: subject.userId, leadId: subject.leadId,
      candidate: { queryId: subject.queryId, normalizedUrl: subjectUrl, candidateFingerprint: createHash("sha256").update(subjectUrl, "utf8").digest("hex") },
      extract: { normalizedUrl: subjectUrl }, page: page(subjectUrl), now,
    };
    await expect(gate.verify(input)).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLEANUP_REQUIRED" });

    expect(store.deletes).toHaveLength(1);
    expect(store.objects.size).toBe(2);
    await noWrites(subject.userId, subject.leadId, new EvidenceStore());
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, subject.userId))).resolves.toEqual([]);
    const failedKeys = [...store.objects.keys()].sort();
    store.failDelete = false;
    const retried = await gate.verify(input);
    expect(Object.values(retried.sourcePostingVersion.rawObjectReference as Record<string, string>).sort()).toEqual(failedKeys);
    const generation = (retried.sourcePostingVersion.rawObjectReference as { rawHtmlObjectKey: string }).rawHtmlObjectKey.split("/")[3]!;
    expect(generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(store.objects.size).toBe(2);
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, subject.userId))).resolves.toHaveLength(1);
  });

  it("拒绝复用带 provider normalizedData 的 taxonomy Version，且不会写入或归因", async () => {
    const subject = await owner();
    const local = page();
    const rawHash = createHash("sha256").update(local.rawHtml, "utf8").digest("hex");
    const visibleHash = createHash("sha256").update(local.visibleText, "utf8").digest("hex");
    const postingId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const objectKeys = {
      rawHtmlObjectKey: `accounts/${subject.userId}/public-job-pages/${versionId}/${rawHash}.html`,
      visibleTextObjectKey: `accounts/${subject.userId}/public-job-pages/${versionId}/${visibleHash}.txt`,
    };
    await database.insert(jobSourcePostings).values({
      id: postingId, userId: subject.userId, sourceType: "company_careers", sourceIdentifier: createHash("sha256").update(normalizedUrl, "utf8").digest("hex"),
      sourceId: normalizedUrl, sourceIdentity: { taxonomyPolicy: "public-job-source-taxonomy-v1", canonicalUrl: normalizedUrl, finalUrl: normalizedUrl }, isOfficial: true,
      createdAt: now, updatedAt: now,
    });
    await database.insert(jobSourcePostingVersions).values({
      id: versionId, userId: subject.userId, sourcePostingId: postingId, version: 1, contentSha256: visibleHash, rawContentSha256: rawHash,
      rawObjectReference: objectKeys, normalizedData: { provider: "anysearch", snippet: "provider-normalized-sentinel" }, retrievedAt: now, createdAt: now,
    });
    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });

    await expect(gate.verify({
      userId: subject.userId, leadId: subject.leadId,
      candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: local, now,
    })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_LEAD_CONFLICT" });
    expect(store.puts).toEqual([]);
    await expect(database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, subject.leadId))).resolves.toEqual([]);
  });

  it("另一 Lead 已提交兼容 Version 后，失败 Lead 重试会清理自己的 recovery generation", async () => {
    const reservation = await owner("https://careers.acme.com/jobs/reservation?job=1");
    const reservationUrl = "https://careers.acme.com/jobs/reservation?job=1";
    const reserved = await createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }).verify({
      userId: reservation.userId, leadId: reservation.leadId,
      candidate: { queryId: reservation.queryId, normalizedUrl: reservationUrl, candidateFingerprint: createHash("sha256").update(reservationUrl, "utf8").digest("hex") },
      extract: { normalizedUrl: reservationUrl }, page: page(reservationUrl), now,
    });
    const first = await owner();
    const second = await anotherLead(first);
    const store = new EvidenceStore();
    const rawHash = createHash("sha256").update(page().rawHtml, "utf8").digest("hex");
    const visibleHash = createHash("sha256").update(page().visibleText, "utf8").digest("hex");
    const firstGeneration = generationId(first.userId, first.leadId, "company_careers", normalizedUrl, rawHash, visibleHash);
    const secondGeneration = generationId(second.userId, second.leadId, "company_careers", normalizedUrl, rawHash, visibleHash);
    const firstKeys = [
      `accounts/${first.userId}/public-job-pages/${firstGeneration}/${rawHash}.html`,
      `accounts/${first.userId}/public-job-pages/${firstGeneration}/${visibleHash}.txt`,
    ];
    const firstGate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: (() => { const ids = [crypto.randomUUID(), reserved.attribution.attributionId]; return () => ids.shift() ?? crypto.randomUUID(); })() });
    const firstInput = {
      userId: first.userId, leadId: first.leadId,
      candidate: { queryId: first.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    };
    store.failDelete = true;
    await expect(firstGate.verify(firstInput)).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLEANUP_REQUIRED" });
    expect([...store.objects.keys()].sort()).toEqual(firstKeys.sort());

    store.failDelete = false;
    const secondGate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
    const secondResult = await secondGate.verify({
      userId: second.userId, leadId: second.leadId,
      candidate: { queryId: second.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });
    const secondRefs = Object.values(secondResult.sourcePostingVersion.rawObjectReference as Record<string, string>).sort();
    expect(firstGeneration).not.toBe(secondGeneration);
    expect(secondRefs.every((key) => key.includes(secondGeneration))).toBe(true);
    expect(store.objects.size).toBe(4);

    const unknownCleanup = new Error("unknown recovery cleanup");
    store.unknownDelete = unknownCleanup;
    await expect(firstGate.verify(firstInput)).rejects.toBe(unknownCleanup);
    await expect(createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() }).getLead({ userId: first.userId, leadId: first.leadId, now }))
      .resolves.toMatchObject({ state: "pending" });
    store.unknownDelete = null;
    store.failDelete = true;
    await expect(firstGate.verify(firstInput)).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_CLEANUP_REQUIRED" });
    store.failDelete = false;
    const retried = await firstGate.verify(firstInput);
    expect(retried.sourcePostingVersion.sourcePostingVersionId).toBe(secondResult.sourcePostingVersion.sourcePostingVersionId);
    expect(store.objects.has(firstKeys[0]!)).toBe(false);
    expect(store.objects.has(firstKeys[1]!)).toBe(false);
    expect(secondRefs.every((key) => store.objects.has(key))).toBe(true);
    await expect(Promise.all([
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, first.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, first.leadId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, second.leadId)),
    ])).resolves.toEqual([[expect.anything()], [expect.anything()], [expect.anything()]]);
    const putCount = store.puts.length;
    const replay = await firstGate.verify(firstInput);
    expect(replay).toEqual(retried);
    expect(store.puts).toHaveLength(putCount);
    expect(secondRefs.every((key) => store.objects.has(key))).toBe(true);
  });

  it("未知 put、delete 与 id 错误保持原始对象 identity，typed unavailable 才映射领域码", async () => {
    for (const ordinal of [1, 2]) {
      const subject = await owner();
      const store = new EvidenceStore();
      const failure = new Error(`unknown put ${ordinal}`);
      store.unknownAtPut = { ordinal, error: failure };
      const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
      await expect(gate.verify({
        userId: subject.userId, leadId: subject.leadId,
        candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
      })).rejects.toBe(failure);
      expect(store.deletes).toHaveLength(ordinal - 1);
      await noWrites(subject.userId, subject.leadId, new EvidenceStore());
    }
    const idSubject = await owner();
    const idFailure = new Error("unknown id");
    const idGate = createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => { throw idFailure; } });
    await expect(idGate.verify({
      userId: idSubject.userId, leadId: idSubject.leadId,
      candidate: { queryId: idSubject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    })).rejects.toBe(idFailure);

    const dbSubject = await owner();
    const dbFailure = new Error("unknown database transaction");
    const brokenDatabase = Object.assign(Object.create(database), { transaction: async () => { throw dbFailure; } }) as Database;
    const dbGate = createVerifiedJobSourceGate({ db: brokenDatabase, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() });
    await expect(dbGate.verify({
      userId: dbSubject.userId, leadId: dbSubject.leadId,
      candidate: { queryId: dbSubject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    })).rejects.toBe(dbFailure);

    const deleteSubject = await owner("https://careers.acme.com/jobs/unknown-delete?job=1");
    const deleteFailure = new Error("unknown delete");
    const deleteStore = new EvidenceStore();
    deleteStore.unknownDelete = deleteFailure;
    const existing = await owner("https://careers.acme.com/jobs/attribution-reservation?job=1");
    const existingResult = await createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }).verify({
      userId: existing.userId, leadId: existing.leadId,
      candidate: { queryId: existing.queryId, normalizedUrl: "https://careers.acme.com/jobs/attribution-reservation?job=1", candidateFingerprint: createHash("sha256").update("https://careers.acme.com/jobs/attribution-reservation?job=1", "utf8").digest("hex") },
      extract: { normalizedUrl: "https://careers.acme.com/jobs/attribution-reservation?job=1" }, page: page("https://careers.acme.com/jobs/attribution-reservation?job=1"), now,
    });
    const deleteGate = createVerifiedJobSourceGate({ db: database, contentStore: deleteStore, id: (() => { const ids = [crypto.randomUUID(), existingResult.attribution.attributionId]; return () => ids.shift() ?? crypto.randomUUID(); })() });
    const deleteUrl = "https://careers.acme.com/jobs/unknown-delete?job=1";
    await expect(deleteGate.verify({
      userId: deleteSubject.userId, leadId: deleteSubject.leadId,
      candidate: { queryId: deleteSubject.queryId, normalizedUrl: deleteUrl, candidateFingerprint: createHash("sha256").update(deleteUrl, "utf8").digest("hex") }, extract: { normalizedUrl: deleteUrl }, page: page(deleteUrl), now,
    })).rejects.toBe(deleteFailure);
  });

  it("回滚事务只清理自己的 sourceVersion generation，不会删除随后提交版本的证据", async () => {
    const reservation = await owner();
    const reserved = await createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }).verify({
      userId: reservation.userId, leadId: reservation.leadId,
      candidate: { queryId: reservation.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });
    const first = await owner();
    const second = await anotherLead(first);
    const store = new EvidenceStore();
    const cleanupStarted = deferred();
    const allowCleanup = deferred();
    let held = false;
    store.onDelete = async () => {
      if (!held) {
        held = true;
        cleanupStarted.resolve();
        await allowCleanup.promise;
      }
    };
    const firstPostingId = crypto.randomUUID();
    const secondPostingId = crypto.randomUUID();
    const rawHash = createHash("sha256").update(page().rawHtml, "utf8").digest("hex");
    const visibleHash = createHash("sha256").update(page().visibleText, "utf8").digest("hex");
    const firstVersionId = generationId(first.userId, first.leadId, "company_careers", normalizedUrl, rawHash, visibleHash);
    const secondVersionId = generationId(second.userId, second.leadId, "company_careers", normalizedUrl, rawHash, visibleHash);
    const firstGate = createVerifiedJobSourceGate({
      db: database, contentStore: store,
      id: (() => { const ids = [firstPostingId, reserved.attribution.attributionId]; return () => ids.shift()!; })(),
    });
    const secondGate = createVerifiedJobSourceGate({
      db: database, contentStore: store,
      id: (() => { const ids = [secondPostingId, crypto.randomUUID()]; return () => ids.shift()!; })(),
    });
    const firstAttempt = firstGate.verify({
      userId: first.userId, leadId: first.leadId,
      candidate: { queryId: first.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });
    await cleanupStarted.promise;
    const secondAttempt = secondGate.verify({
      userId: second.userId, leadId: second.leadId,
      candidate: { queryId: second.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });
    allowCleanup.resolve();
    await expect(firstAttempt).rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_ATTRIBUTION_CONFLICT" });
    const secondResult = await secondAttempt;

    const refs = secondResult.sourcePostingVersion.rawObjectReference as { rawHtmlObjectKey: string; visibleTextObjectKey: string };
    expect(refs.rawHtmlObjectKey).not.toContain(firstVersionId);
    expect(refs.rawHtmlObjectKey).toContain(secondVersionId);
    expect(store.deletes).toEqual(expect.arrayContaining(store.puts.filter((key) => key.includes(firstVersionId))));
    expect(store.deletes).not.toEqual(expect.arrayContaining([refs.rawHtmlObjectKey, refs.visibleTextObjectKey]));
    expect(store.objects.get(refs.rawHtmlObjectKey)).toEqual(new TextEncoder().encode(page().rawHtml));
    expect(store.objects.get(refs.visibleTextObjectKey)).toEqual(new TextEncoder().encode(page().visibleText));
    expect(createHash("sha256").update(store.objects.get(refs.rawHtmlObjectKey)!).digest("hex")).toBe(secondResult.sourcePostingVersion.rawContentSha256);
    expect(createHash("sha256").update(store.objects.get(refs.visibleTextObjectKey)!).digest("hex")).toBe(secondResult.sourcePostingVersion.contentSha256);
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
      { ...valid, snippet: "provider-snippet-sentinel" },
      { ...valid, rawUrl: "https://provider.example/provider-raw-url-sentinel" },
      { ...valid, provider: { content: "provider-extract-sentinel" } },
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
      database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.userId, subject.userId)),
      database.select().from(auditEvents).where(eq(auditEvents.userId, subject.userId)),
    ])).resolves.toEqual([
      expect.objectContaining({ state: "pending" }), [], [], [], [], [],
    ]);
    const allPersisted = JSON.stringify(await Promise.all([
      database.select().from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.userId, subject.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.userId, subject.userId)),
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, subject.userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, subject.userId)),
      database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.userId, subject.userId)),
      database.select().from(auditEvents).where(eq(auditEvents.userId, subject.userId)),
      [...store.objects.entries()].map(([key, value]) => [key, new TextDecoder().decode(value)]),
    ]));
    for (const sentinel of ["provider-content-sentinel", "provider-title-sentinel", "provider-snippet-sentinel", "provider-raw-url-sentinel", "provider-extract-sentinel"]) {
      expect(allPersisted).not.toContain(sentinel);
    }
  });

  it("owner、过期与终态 Lead 的冲突不产生半写入；已验证 Lead 的本地事实必须完全一致", async () => {
    const otherOwner = await owner();
    const otherStore = new EvidenceStore();
    const otherGate = createVerifiedJobSourceGate({ db: database, contentStore: otherStore, id: () => crypto.randomUUID() });
    await expect(otherGate.verify({
      userId: crypto.randomUUID(), leadId: otherOwner.leadId,
      candidate: { queryId: otherOwner.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_LEAD_NOT_FOUND" });
    await noWrites(otherOwner.userId, otherOwner.leadId, otherStore);

    const expired = await owner();
    const [{ expiresAt }] = await database.select({ expiresAt: jobDiscoveryLeads.expiresAt }).from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.id, expired.leadId));
    const expiredStore = new EvidenceStore();
    const expiredGate = createVerifiedJobSourceGate({ db: database, contentStore: expiredStore, id: () => crypto.randomUUID() });
    await expect(expiredGate.verify({
      userId: expired.userId, leadId: expired.leadId,
      candidate: { queryId: expired.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now: expiresAt,
    })).rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_EXPIRED" });
    await noWrites(expired.userId, expired.leadId, new EvidenceStore());
    expect(expiredStore.deletes).toEqual(expiredStore.puts);

    const rejected = await owner();
    const rejectedStore = new EvidenceStore();
    const rejectedGate = createVerifiedJobSourceGate({ db: database, contentStore: rejectedStore, id: () => crypto.randomUUID() });
    await rejectedGate.reject({ userId: rejected.userId, leadId: rejected.leadId, code: "JOB_PAGE_LISTING", now });
    await expect(rejectedGate.verify({
      userId: rejected.userId, leadId: rejected.leadId,
      candidate: { queryId: rejected.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    })).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_LEAD_CONFLICT" });
    await noWrites(rejected.userId, rejected.leadId, rejectedStore);

    const verified = await owner();
    const verifiedStore = new EvidenceStore();
    const verifiedGate = createVerifiedJobSourceGate({ db: database, contentStore: verifiedStore, id: () => crypto.randomUUID() });
    const input = {
      userId: verified.userId, leadId: verified.leadId,
      candidate: { queryId: verified.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    };
    await verifiedGate.verify(input);
    const putCount = verifiedStore.puts.length;
    for (const changed of [
      { ...input, page: { ...page(), finalUrl: "https://careers.acme.com/jobs/other?job=123" } },
      { ...input, page: { ...page(), sourceKind: "aggregator" as const } },
      { ...input, page: { ...page(), visibleText: "# Changed local evidence" } },
      { ...input, candidate: { ...input.candidate, normalizedUrl: "https://careers.acme.com/jobs/other?job=123", candidateFingerprint: createHash("sha256").update("https://careers.acme.com/jobs/other?job=123", "utf8").digest("hex") }, extract: { normalizedUrl: "https://careers.acme.com/jobs/other?job=123" }, page: page("https://careers.acme.com/jobs/other?job=123") },
    ]) {
      await expect(verifiedGate.verify(changed)).rejects.toMatchObject({ code: "VERIFIED_JOB_SOURCE_LEAD_CONFLICT" });
    }
    expect(verifiedStore.puts).toHaveLength(putCount);
    await expect(Promise.all([
      createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() }).getLead({ userId: verified.userId, leadId: verified.leadId, now }),
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, verified.userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, verified.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, verified.leadId)),
    ])).resolves.toEqual([expect.objectContaining({ state: "verified" }), [expect.anything()], [expect.anything()], [expect.anything()]]);
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

  it("canonical 相同的同源别名不因观察到的 final 身份冲突", async () => {
    const aliasUrl = "https://careers.acme.com/jobs/123?job=alternate";
    const first = await owner();
    const second = await anotherLead(first, aliasUrl);
    const store = new EvidenceStore();
    const gate = createVerifiedJobSourceGate({ db: database, contentStore: store, id: () => crypto.randomUUID() });
    const firstResult = await gate.verify({
      userId: first.userId, leadId: first.leadId,
      candidate: { queryId: first.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });

    const aliasResult = await gate.verify({
      userId: second.userId, leadId: second.leadId,
      candidate: { queryId: second.queryId, normalizedUrl: aliasUrl, candidateFingerprint: createHash("sha256").update(aliasUrl, "utf8").digest("hex") },
      extract: { normalizedUrl: aliasUrl }, page: { ...page(aliasUrl), canonicalUrl: normalizedUrl }, now,
    });

    expect(aliasResult.sourcePosting.postingId).toBe(firstResult.sourcePosting.postingId);
    expect(aliasResult.sourcePostingVersion.sourcePostingVersionId).toBe(firstResult.sourcePostingVersion.sourcePostingVersionId);
    expect(JSON.stringify(aliasResult.sourcePosting.sourceIdentity).includes(aliasUrl)).toBe(false);
    await expect(Promise.all([
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, first.userId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, first.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.userId, first.userId)),
    ])).resolves.toEqual([
      [expect.objectContaining({ id: firstResult.sourcePosting.postingId })],
      [expect.objectContaining({ id: firstResult.sourcePostingVersion.sourcePostingVersionId, version: 1 })],
      expect.arrayContaining([
        expect.objectContaining({ leadId: first.leadId }),
        expect.objectContaining({ leadId: second.leadId }),
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

  it("同 canonical 的 url_import 预置来源不会被公开门禁复用", async () => {
    const subject = await owner();
    await database.insert(jobSourcePostings).values({
      id: crypto.randomUUID(), userId: subject.userId, sourceType: "url_import", sourceIdentifier: createHash("sha256").update(normalizedUrl, "utf8").digest("hex"),
      sourceId: normalizedUrl, sourceIdentity: { canonicalUrl: normalizedUrl, inputType: "url" }, isOfficial: true, createdAt: now, updatedAt: now,
    });
    const result = await createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }).verify({
      userId: subject.userId, leadId: subject.leadId,
      candidate: { queryId: subject.queryId, normalizedUrl, candidateFingerprint }, extract: { normalizedUrl }, page: page(), now,
    });
    expect(result.sourcePosting.sourceType).toBe("company_careers");
    await expect(database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, subject.userId))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceType: "url_import" }), expect.objectContaining({ id: result.sourcePosting.postingId, sourceType: "company_careers" }),
    ]));
  });

  it("采用固定 taxonomy，只由本地 canonical host 和 fetched sourceKind 派生真实来源身份", async () => {
    const cases: Array<{
      host: string; queryKind: "general" | "target_company" | "site_constrained"; sourceKind: "official" | "aggregator";
      sourceType: "company_careers" | "recruitment_platform" | "wechat_recruitment_h5" | "public_web"; official: boolean;
    }> = [
      ...["zhipin.com", "jobs.zhipin.com", "liepin.com", "campus.liepin.com", "zhaopin.com", "campus.zhaopin.com"].map((host) => ({ host, queryKind: "general" as const, sourceKind: "aggregator" as const, sourceType: "recruitment_platform" as const, official: false })),
      ...["mp.weixin.qq.com", "jobs.mp.weixin.qq.com"].map((host) => ({ host, queryKind: "general" as const, sourceKind: "aggregator" as const, sourceType: "wechat_recruitment_h5" as const, official: false })),
      ...["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "apply.workable.com", "jobs.smartrecruiters.com"].map((host) => ({ host, queryKind: "general" as const, sourceKind: "official" as const, sourceType: "company_careers" as const, official: true })),
      { host: "evil.jobs.lever.co", queryKind: "general", sourceKind: "official", sourceType: "public_web", official: true },
      { host: "careers.unknown-careers.com", queryKind: "target_company", sourceKind: "official", sourceType: "company_careers", official: true },
      { host: "public.unknown-careers.net", queryKind: "general", sourceKind: "aggregator", sourceType: "public_web", official: false },
      { host: "constrained.unknown-careers.org", queryKind: "site_constrained", sourceKind: "aggregator", sourceType: "public_web", official: false },
    ];
    for (const item of cases) {
      const url = `https://${item.host}/jobs/123?job=123`;
      const subject = await owner(url, item.queryKind);
      const result = await createVerifiedJobSourceGate({ db: database, contentStore: new EvidenceStore(), id: () => crypto.randomUUID() }).verify({
        userId: subject.userId, leadId: subject.leadId,
        candidate: { queryId: subject.queryId, normalizedUrl: url, candidateFingerprint: createHash("sha256").update(url, "utf8").digest("hex") },
        extract: { normalizedUrl: url }, page: { ...page(url), sourceKind: item.sourceKind }, now,
      });
      expect(result.sourcePosting).toMatchObject({ sourceType: item.sourceType, sourceId: url, isOfficial: item.official });
      expect(result.sourcePosting.sourceIdentity).toEqual({ taxonomyPolicy: "public-job-source-taxonomy-v1", canonicalUrl: url, finalUrl: url, observedFinalUrls: { [url]: url } });
    }
  });
});
