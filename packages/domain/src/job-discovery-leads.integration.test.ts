import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
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
import { JobDiscoveryLeadError, createJobDiscoveryLeadRepository } from "./job-discovery-leads";

const now = new Date("2026-08-30T12:00:00.000Z");
const fingerprint = "a".repeat(64);
const queryFingerprint = "b".repeat(64);

describe("job discovery lead repository", () => {
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

  async function owner(prefix: string) {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active" });
    await database.insert(agentRuns).values({
      id: runId, userId, targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1,
      targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "workflow-v4", ruleVersion: "rules-v1",
      adapter: "layered-public", adapterVersion: "v1", outputSchemaVersion: "result-v4", toolAllowlist: [],
      status: "queued", currentStep: "queued", createdAt: now, updatedAt: now, queuedAt: now,
    });
    const postingId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await database.insert(jobSourcePostings).values({
      id: postingId, userId, sourceType: "official", sourceIdentifier: `${prefix}-source`, sourceIdentity: {}, createdAt: now, updatedAt: now,
    });
    await database.insert(jobSourcePostingVersions).values({
      id: versionId, userId, sourcePostingId: postingId, version: 1, contentSha256: fingerprint,
      rawContentSha256: fingerprint, rawObjectReference: {}, normalizedData: {}, retrievedAt: now, createdAt: now,
    });
    return { userId, targetId, runId, versionId };
  }

  function repository() {
    return createJobDiscoveryLeadRepository({ db: database, id: () => crypto.randomUUID() });
  }

  function pendingInput(input: { userId: string; runId: string; targetId: string; queryId?: string; stableFingerprint?: string }) {
    return {
      userId: input.userId,
      runId: input.runId,
      targetId: input.targetId,
      queryId: input.queryId ?? crypto.randomUUID(),
      queryKind: "general" as const,
      queryFingerprint,
      normalizedUrl: "https://jobs.example.com/opening?id=123",
      stableFingerprint: input.stableFingerprint ?? fingerprint,
      now,
    };
  }

  it("只记录安全的待验证 Lead，并把 30 天过期作为读取投影", async () => {
    const subject = await owner("pending");
    const created = await repository().recordPending(pendingInput(subject));

    expect(created).toMatchObject({
      ownerId: subject.userId, runId: subject.runId, targetId: subject.targetId, provider: "anysearch",
      state: "pending", sourcePostingVersionId: null, rejectionCode: null,
      expiresAt: "2026-09-29T12:00:00.000Z",
    });
    await expect(repository().getLead({ userId: subject.userId, leadId: created.leadId, now: new Date("2026-09-29T12:00:00.000Z") }))
      .resolves.toMatchObject({ leadId: created.leadId, expired: true, state: "pending" });
    await expect(repository().getLead({ userId: subject.userId, leadId: created.leadId, now: new Date("2026-09-28T12:00:00.000Z") }))
      .resolves.toMatchObject({ expired: false });
    await expect(database.select().from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.id, created.leadId)))
      .resolves.toEqual([expect.objectContaining({ expiresAt: new Date("2026-09-29T12:00:00.000Z"), state: "pending" })]);
  });

  it("拒绝敏感 URL 与未知输入字段，不持久化 AnySearch 内容", async () => {
    const subject = await owner("privacy");
    const secret = "secret-token-sentinel";
    const base = pendingInput(subject);
    for (const input of [
      { ...base, normalizedUrl: `https://user:${secret}@jobs.example.com/opening?id=123` },
      { ...base, normalizedUrl: "https://jobs.example.com/opening?id=123#fragment" },
      { ...base, normalizedUrl: `https://jobs.example.com/opening?id=123&token=${secret}` },
      { ...base, rawUrl: `https://jobs.example.com/opening?id=123&session=${secret}` },
      { ...base, title: secret }, { ...base, snippet: secret }, { ...base, extract: secret }, { ...base, content: secret }, { ...base, credentials: secret },
    ]) {
      await expect(repository().recordPending(input)).rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_INVALID_INPUT" } satisfies Partial<JobDiscoveryLeadError>);
    }
    const persisted = await database.execute(sql`
      select coalesce(string_agg(row::text, ' '), '') as value from (
        select to_jsonb(lead)::text as row from job_discovery_leads as lead
        union all select to_jsonb(attribution)::text from job_discovery_attributions as attribution
        union all select to_jsonb(health)::text from job_source_health_checks as health
        union all select to_jsonb(audit)::text from audit_events as audit
      ) persisted
    `) as unknown as Array<{ value: string }>;
    expect(persisted[0]!.value).not.toContain(secret);
  });

  it("拒绝只转换未过期待验证 Lead，并使相同重试收敛", async () => {
    const subject = await owner("reject");
    const created = await repository().recordPending(pendingInput(subject));
    const first = await repository().reject({ userId: subject.userId, leadId: created.leadId, rejectionCode: "POLICY_REJECTED", now });
    const retry = await repository().reject({ userId: subject.userId, leadId: created.leadId, rejectionCode: "POLICY_REJECTED", now });

    expect(retry).toEqual(first);
    await expect(repository().reject({ userId: subject.userId, leadId: created.leadId, rejectionCode: "POLICY_REJECTED", now: new Date("2026-09-29T12:00:00.000Z") }))
      .resolves.toEqual(first);
    expect(first).toMatchObject({ state: "rejected", sourcePostingVersionId: null, rejectionCode: "POLICY_REJECTED" });
    await expect(repository().reject({ userId: subject.userId, leadId: created.leadId, rejectionCode: "UNSAFE_URL", now }))
      .rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_REJECTION_CONFLICT" } satisfies Partial<JobDiscoveryLeadError>);
    await expect(repository().verifyAndAttribute({ userId: subject.userId, leadId: created.leadId, sourcePostingVersionId: subject.versionId, now }))
      .rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_STATE_CONFLICT" } satisfies Partial<JobDiscoveryLeadError>);
  });

  it("在同一事务验证并归因，重试不会创建 Source Posting、Opportunity 或 Result", async () => {
    const subject = await owner("verify");
    const created = await repository().recordPending(pendingInput(subject));
    const before = await Promise.all([
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, subject.userId)),
      database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, subject.userId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, subject.userId)),
    ]);
    const [first, retry] = await Promise.all([
      repository().verifyAndAttribute({ userId: subject.userId, leadId: created.leadId, sourcePostingVersionId: subject.versionId, now }),
      repository().verifyAndAttribute({ userId: subject.userId, leadId: created.leadId, sourcePostingVersionId: subject.versionId, now }),
    ]);

    expect(retry).toEqual(first);
    expect(first).toMatchObject({ lead: { state: "verified", sourcePostingVersionId: subject.versionId, rejectionCode: null }, attribution: expect.objectContaining({ ownerId: subject.userId, runId: subject.runId, leadId: created.leadId, provider: "anysearch", sourcePostingVersionId: subject.versionId }) });
    await expect(database.select().from(jobDiscoveryAttributions).where(and(eq(jobDiscoveryAttributions.userId, subject.userId), eq(jobDiscoveryAttributions.leadId, created.leadId))))
      .resolves.toHaveLength(1);
    await expect(Promise.all([
      database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, subject.userId)),
      database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, subject.userId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.userId, subject.userId)),
    ])).resolves.toEqual(before);
  });

  it("不泄露其他 owner 的 Lead，且跨 owner/version 失败后不留下半写入", async () => {
    const subject = await owner("owner");
    const other = await owner("other");
    const created = await repository().recordPending(pendingInput(subject));

    await expect(repository().getLead({ userId: other.userId, leadId: created.leadId, now })).resolves.toBeNull();
    await expect(repository().reject({ userId: other.userId, leadId: created.leadId, rejectionCode: "POLICY_REJECTED", now }))
      .rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_NOT_FOUND" } satisfies Partial<JobDiscoveryLeadError>);
    await expect(repository().verifyAndAttribute({ userId: subject.userId, leadId: created.leadId, sourcePostingVersionId: other.versionId, now }))
      .rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_VERSION_NOT_FOUND" } satisfies Partial<JobDiscoveryLeadError>);
    await expect(database.select().from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.id, created.leadId)))
      .resolves.toEqual([expect.objectContaining({ state: "pending", sourcePostingVersionId: null, rejectionCode: null })]);
    await expect(database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.leadId, created.leadId))).resolves.toEqual([]);
  });

  it("过期 Lead 不转换，且重复 recordPending 只返回原记录", async () => {
    const subject = await owner("expiry");
    const input = pendingInput(subject);
    const [first, second] = await Promise.all([repository().recordPending(input), repository().recordPending(input)]);

    expect(second).toEqual(first);
    await expect(repository().reject({ userId: subject.userId, leadId: first.leadId, rejectionCode: "POLICY_REJECTED", now: new Date("2026-09-29T12:00:00.000Z") }))
      .rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_EXPIRED" } satisfies Partial<JobDiscoveryLeadError>);
    await expect(repository().verifyAndAttribute({ userId: subject.userId, leadId: first.leadId, sourcePostingVersionId: subject.versionId, now: new Date("2026-09-29T12:00:00.000Z") }))
      .rejects.toMatchObject({ code: "JOB_DISCOVERY_LEAD_EXPIRED" } satisfies Partial<JobDiscoveryLeadError>);
    await expect(database.select().from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.id, first.leadId))).resolves.toEqual([expect.objectContaining({ state: "pending" })]);
  });
});
