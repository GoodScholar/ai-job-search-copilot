import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditEvents,
  candidateFacts,
  candidateFactDecisions,
  candidateFactEvidence,
  careerDocuments,
  careerImports,
  careerFactConflicts,
  createDatabase,
  jobProfiles,
  jobAccounts,
  migrateDatabase,
  profileFactRevisions,
  type Database,
} from "@job-copilot/database";
import { and, eq, sql } from "drizzle-orm";
import { createAuditTrail, type AuditTrail } from "./audit-trail";
import { createCareerImportQueries } from "./career-imports";
import { createProfileReviewCommands, createTrustedProfileQueries } from "./profile-review";
import { createCareerFactConflictReviewCommands } from "./career-fact-conflict-review";

const userId = "3e153c8c-d85d-4ec3-8f01-7c08e0b94c36";
const otherUserId = "d2ac09b9-ce59-4ece-9afd-8280be768fb4";
const now = new Date("2026-08-27T12:00:00.000Z");

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitUntilAConnectionIsWaitingForAccountAdvisoryLock(database: Database) {
  await expect.poll(async () => {
    const [row] = await database.execute<{ waiting: boolean }>(sql`
      select exists(
        select 1 from pg_stat_activity
        where wait_event_type = 'Lock'
          and wait_event = 'advisory'
          and query like '%pg_advisory_xact_lock%'
      ) as waiting
    `);
    return row?.waiting ?? false;
  }, { timeout: 2_000, interval: 10 }).toBe(true);
}

describe("profile review", () => {
  let database: Database;
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
    await database.insert(jobAccounts).values([{ id: userId }, { id: otherUserId }]);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  async function seedCandidateFact(input: { owner?: string; factType?: "skill" | "language"; factValue?: object } = {}) {
    const owner = input.owner ?? userId;
    const documentId = crypto.randomUUID();
    const importId = crypto.randomUUID();
    const factId = crypto.randomUUID();
    const checksum = createHash("sha256").update(documentId).digest("hex");
    await database.insert(careerDocuments).values({
      id: documentId, userId: owner, checksumSha256: checksum,
      objectKey: `accounts/${owner}/career-documents/${documentId}/processing.md`,
      originalFilename: "resume.md", mediaType: "text/markdown", byteSize: 20,
      privacyScanVersion: "career-privacy-v1", createdAt: now, updatedAt: now,
    });
    await database.insert(careerImports).values({
      id: importId, userId: owner, careerDocumentId: documentId, status: "completed",
      parserAdapter: "fake", parserVersion: "fake-career-parser-v1", promptVersion: "career-import-prompt-v1",
      outputSchemaVersion: "career-facts-v1", originatingRequestId: crypto.randomUUID(), queuedAt: now,
      completedAt: now, createdAt: now, updatedAt: now,
    });
    await database.insert(candidateFacts).values({
      id: factId, userId: owner, careerImportId: importId, careerDocumentId: documentId,
      factKey: createHash("sha256").update(factId).digest("hex"),
      factType: input.factType ?? "skill", factValue: input.factValue ?? { name: "TypeScript" },
      confidenceBasisPoints: 10_000, confirmationStatus: "pending", createdAt: now,
    });
    await database.insert(candidateFactEvidence).values({
      id: crypto.randomUUID(), userId: owner, candidateFactId: factId, careerDocumentId: documentId,
      locatorType: "markdown_lines", startLine: 1, endLine: 1, excerpt: "- quoted evidence",
      excerptSha256: createHash("sha256").update("- quoted evidence").digest("hex"), createdAt: now,
    });
    return factId;
  }

  function commands() {
    return createProfileReviewCommands({
      db: database,
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      id: () => crypto.randomUUID(),
      clock: () => now,
    });
  }

  it("confirms an owned candidate fact as the only trusted profile fact", async () => {
    const candidateFactId = await seedCandidateFact();

    const snapshot = await commands().decideCandidateFact({
      userId,
      requestId: crypto.randomUUID(),
      candidateFactId,
      command: { expectedVersion: 0, decision: "confirmed" },
    });

    expect(snapshot).toMatchObject({
      version: 1,
      facts: [{ factType: "skill", factValue: { name: "TypeScript" }, source: "candidate_fact", candidateFactId }],
    });
    await expect(createTrustedProfileQueries({ db: database }).getCurrent({ userId }))
      .resolves.toMatchObject({ version: 1, facts: [{ candidateFactId }] });
  });

  it("拒绝通过单事实审核解决仍待处理的职业事实冲突", async () => {
    const existingFactId = await seedCandidateFact({ factValue: { name: `existing-${crypto.randomUUID()}` } });
    const incomingFactId = await seedCandidateFact({ factValue: { name: `incoming-${crypto.randomUUID()}` } });
    await database.insert(careerFactConflicts).values({
      id: crypto.randomUUID(), userId, existingCandidateFactId: existingFactId, incomingCandidateFactId: incomingFactId,
      kind: "role", status: "pending", createdAt: now,
    });
    const before = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    await expect(commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId: incomingFactId,
      command: { expectedVersion: before.version, decision: "confirmed" },
    })).rejects.toMatchObject({ code: "CANDIDATE_FACT_CONFLICT_PENDING" });
    await expect(createTrustedProfileQueries({ db: database }).getCurrent({ userId })).resolves.toMatchObject({ version: before.version });
    await expect(database.select({ id: candidateFactDecisions.id }).from(candidateFactDecisions)
      .where(eq(candidateFactDecisions.candidateFactId, incomingFactId))).resolves.toEqual([]);
  });

  it("在账户锁释放后才让单事实审核看到并发写入的待处理冲突", async () => {
    const existingFactId = await seedCandidateFact({ factValue: { name: `lock-existing-${crypto.randomUUID()}` } });
    const incomingFactId = await seedCandidateFact({ factValue: { name: `lock-incoming-${crypto.randomUUID()}` } });
    const before = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const locked = deferred();
    const release = deferred();
    const holder = database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      await transaction.insert(careerFactConflicts).values({ id: crypto.randomUUID(), userId, existingCandidateFactId: existingFactId, incomingCandidateFactId: incomingFactId, kind: "role", status: "pending", createdAt: now });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    let settled = false;
    const competingDatabase = createDatabase(container.getConnectionUri());
    const deciding = createProfileReviewCommands({ db: competingDatabase, auditTrail: createAuditTrail({ db: competingDatabase, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .decideCandidateFact({ userId, requestId: crypto.randomUUID(), candidateFactId: incomingFactId, command: { expectedVersion: before.version, decision: "confirmed" } })
      .finally(() => { settled = true; });
    await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(database);
    expect(settled).toBe(false);
    release.resolve();
    await holder;
    await expect(deciding).rejects.toMatchObject({ code: "CANDIDATE_FACT_CONFLICT_PENDING" });
    await competingDatabase.$client.end();
  });

  it("在账户锁释放后才让冲突解决看到并发创建的冲突", async () => {
    const existingFactId = await seedCandidateFact({ factValue: { name: `resolve-lock-existing-${crypto.randomUUID()}` } });
    const incomingFactId = await seedCandidateFact({ factValue: { name: `resolve-lock-incoming-${crypto.randomUUID()}` } });
    const conflictId = crypto.randomUUID();
    const before = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const locked = deferred();
    const release = deferred();
    const holder = database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      await transaction.insert(careerFactConflicts).values({ id: conflictId, userId, existingCandidateFactId: existingFactId, incomingCandidateFactId: incomingFactId, kind: "role", status: "pending", createdAt: now });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    let settled = false;
    const competingDatabase = createDatabase(container.getConnectionUri());
    const resolving = createCareerFactConflictReviewCommands({ db: competingDatabase, auditTrail: createAuditTrail({ db: competingDatabase, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .resolve({ userId, requestId: crypto.randomUUID(), conflictId, command: { expectedVersion: before.version, resolution: "use_existing" } })
      .finally(() => { settled = true; });
    await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(database);
    expect(settled).toBe(false);
    release.resolve();
    await holder;
    await expect(resolving).resolves.toMatchObject({ conflict: { status: "resolved" } });
    await competingDatabase.$client.end();
  });

  it("resolves a pending conflict in one profile version with the selected incoming fact", async () => {
    const existingFactId = await seedCandidateFact({ factType: "skill", factValue: { name: "TypeScript" } });
    const incomingFactId = await seedCandidateFact({ factType: "skill", factValue: { name: "Rust" } });
    const conflictId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: conflictId, userId, existingCandidateFactId: existingFactId, incomingCandidateFactId: incomingFactId, kind: "role", status: "pending", createdAt: now });
    const current = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const result = await createCareerFactConflictReviewCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).resolve({
      userId, requestId: crypto.randomUUID(), conflictId, command: { expectedVersion: current.version, resolution: "use_incoming" },
    });
    expect(result.profile.version).toBe(current.version + 1);
    const decisions = await database.select({ candidateFactId: candidateFactDecisions.candidateFactId, decision: candidateFactDecisions.decision }).from(candidateFactDecisions)
      .where(sql`${candidateFactDecisions.candidateFactId} in (${existingFactId}, ${incomingFactId})`);
    expect(decisions).toEqual(expect.arrayContaining([{ candidateFactId: existingFactId, decision: "rejected" }, { candidateFactId: incomingFactId, decision: "confirmed" }]));
  });

  it.each([
    ["use_existing", "confirmed", "rejected"],
    ["keep_both", "confirmed", "confirmed"],
  ] as const)("applies %s without more than one profile version", async (resolution, existingDecision, incomingDecision) => {
    const existingFactId = await seedCandidateFact({ factType: "skill", factValue: { name: `Existing-${crypto.randomUUID()}` } });
    const incomingFactId = await seedCandidateFact({ factType: "skill", factValue: { name: `Incoming-${crypto.randomUUID()}` } });
    const conflictId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: conflictId, userId, existingCandidateFactId: existingFactId, incomingCandidateFactId: incomingFactId, kind: "role", status: "pending", createdAt: now });
    const before = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const resolved = await createCareerFactConflictReviewCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).resolve({ userId, requestId: crypto.randomUUID(), conflictId, command: { expectedVersion: before.version, resolution } });
    expect(resolved.profile.version).toBe(before.version + 1);
    const decisions = await database.select({ candidateFactId: candidateFactDecisions.candidateFactId, decision: candidateFactDecisions.decision }).from(candidateFactDecisions).where(sql`${candidateFactDecisions.candidateFactId} in (${existingFactId}, ${incomingFactId})`);
    expect(decisions).toEqual(expect.arrayContaining([{ candidateFactId: existingFactId, decision: existingDecision }, { candidateFactId: incomingFactId, decision: incomingDecision }]));
  });

  it("rejects a stale version without resolving the conflict or writing decisions", async () => {
    const existingFactId = await seedCandidateFact({ factType: "skill", factValue: { name: `Existing-${crypto.randomUUID()}` } });
    const incomingFactId = await seedCandidateFact({ factType: "skill", factValue: { name: `Incoming-${crypto.randomUUID()}` } });
    const conflictId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: conflictId, userId, existingCandidateFactId: existingFactId, incomingCandidateFactId: incomingFactId, kind: "role", status: "pending", createdAt: now });
    await expect(createCareerFactConflictReviewCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).resolve({
      userId, requestId: crypto.randomUUID(), conflictId, command: { expectedVersion: 0, resolution: "use_existing" },
    })).rejects.toMatchObject({ code: "PROFILE_VERSION_CONFLICT" });
    const [conflict] = await database.select({ status: careerFactConflicts.status }).from(careerFactConflicts).where(eq(careerFactConflicts.id, conflictId));
    const decisions = await database.select({ id: candidateFactDecisions.id }).from(candidateFactDecisions).where(sql`${candidateFactDecisions.candidateFactId} in (${existingFactId}, ${incomingFactId})`);
    expect(conflict.status).toBe("pending");
    expect(decisions).toEqual([]);
  });

  it("将不存在、跨账户和已解决的冲突统一隐藏为稳定错误，且不推进画像", async () => {
    const before = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const commands = createCareerFactConflictReviewCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(commands.resolve({ userId, requestId: crypto.randomUUID(), conflictId: crypto.randomUUID(), command: { expectedVersion: before.version, resolution: "keep_both" } }))
      .rejects.toMatchObject({ code: "CAREER_FACT_CONFLICT_NOT_FOUND" });

    const otherExisting = await seedCandidateFact({ owner: otherUserId });
    const otherIncoming = await seedCandidateFact({ owner: otherUserId, factValue: { name: "Other" } });
    const otherConflictId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: otherConflictId, userId: otherUserId, existingCandidateFactId: otherExisting, incomingCandidateFactId: otherIncoming, kind: "role", status: "pending", createdAt: now });
    await expect(commands.resolve({ userId, requestId: crypto.randomUUID(), conflictId: otherConflictId, command: { expectedVersion: before.version, resolution: "keep_both" } }))
      .rejects.toMatchObject({ code: "CAREER_FACT_CONFLICT_NOT_FOUND" });

    const existing = await seedCandidateFact({ factValue: { name: `resolved-${crypto.randomUUID()}` } });
    const incoming = await seedCandidateFact({ factValue: { name: `resolved-incoming-${crypto.randomUUID()}` } });
    const resolvedId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: resolvedId, userId, existingCandidateFactId: existing, incomingCandidateFactId: incoming, kind: "role", status: "resolved", resolution: "keep_both", profileVersion: before.version || 1, resolvedAt: now, createdAt: now });
    await expect(commands.resolve({ userId, requestId: crypto.randomUUID(), conflictId: resolvedId, command: { expectedVersion: before.version, resolution: "keep_both" } }))
      .rejects.toMatchObject({ code: "CAREER_FACT_CONFLICT_ALREADY_RESOLVED" });
    await expect(createTrustedProfileQueries({ db: database }).getCurrent({ userId })).resolves.toMatchObject({ version: before.version });
  });

  it("兼容的既有决定会复用，不兼容的决定与审计故障都会完整回滚", async () => {
    const existing = await seedCandidateFact({ factValue: { name: `existing-${crypto.randomUUID()}` } });
    const incoming = await seedCandidateFact({ factValue: { name: `incoming-${crypto.randomUUID()}` } });
    let snapshot = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    await commands().decideCandidateFact({ userId, requestId: crypto.randomUUID(), candidateFactId: existing, command: { expectedVersion: snapshot.version, decision: "confirmed" } });
    snapshot = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const compatibleId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: compatibleId, userId, existingCandidateFactId: existing, incomingCandidateFactId: incoming, kind: "role", status: "pending", createdAt: now });
    await createCareerFactConflictReviewCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .resolve({ userId, requestId: crypto.randomUUID(), conflictId: compatibleId, command: { expectedVersion: snapshot.version, resolution: "use_existing" } });
    const existingDecisions = await database.select({ candidateFactId: candidateFactDecisions.candidateFactId }).from(candidateFactDecisions).where(eq(candidateFactDecisions.candidateFactId, existing));
    expect(existingDecisions).toHaveLength(1);

    const replacementIncoming = await seedCandidateFact({ factValue: { name: `replacement-${crypto.randomUUID()}` } });
    const replacementId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: replacementId, userId, existingCandidateFactId: existing, incomingCandidateFactId: replacementIncoming, kind: "role", status: "pending", createdAt: now });
    const beforeReplacement = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const replacement = await createCareerFactConflictReviewCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .resolve({ userId, requestId: crypto.randomUUID(), conflictId: replacementId, command: { expectedVersion: beforeReplacement.version, resolution: "use_incoming" } });
    expect(replacement.profile.version).toBe(beforeReplacement.version + 1);
    expect(replacement.profile.facts).toEqual(expect.arrayContaining([expect.objectContaining({ candidateFactId: replacementIncoming })]));
    expect(replacement.profile.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ candidateFactId: existing })]));
    await expect(database.select({ candidateFactId: candidateFactDecisions.candidateFactId }).from(candidateFactDecisions).where(eq(candidateFactDecisions.candidateFactId, existing))).resolves.toHaveLength(1);

    const correctedExisting = await seedCandidateFact({ factValue: { name: `corrected-${crypto.randomUUID()}` } });
    let correctedSnapshot = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    await commands().decideCandidateFact({ userId, requestId: crypto.randomUUID(), candidateFactId: correctedExisting, command: { expectedVersion: correctedSnapshot.version, decision: "corrected", factValue: { name: "人工纠正" }, reason: "人工核验" } });
    correctedSnapshot = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const incompatibleIncoming = await seedCandidateFact({ factValue: { name: `incompatible-${crypto.randomUUID()}` } });
    const incompatibleId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: incompatibleId, userId, existingCandidateFactId: correctedExisting, incomingCandidateFactId: incompatibleIncoming, kind: "role", status: "pending", createdAt: now });
    await expect(createCareerFactConflictReviewCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .resolve({ userId, requestId: crypto.randomUUID(), conflictId: incompatibleId, command: { expectedVersion: correctedSnapshot.version, resolution: "use_existing" } })).rejects.toMatchObject({ code: "CAREER_FACT_CONFLICT_DECISION_INCOMPATIBLE" });
    await expect(createTrustedProfileQueries({ db: database }).getCurrent({ userId })).resolves.toMatchObject({ version: correctedSnapshot.version });
    await expect(database.select({ status: careerFactConflicts.status }).from(careerFactConflicts).where(eq(careerFactConflicts.id, incompatibleId))).resolves.toEqual([{ status: "pending" }]);

    const auditExisting = await seedCandidateFact({ factValue: { name: `audit-${crypto.randomUUID()}` } });
    const auditIncoming = await seedCandidateFact({ factValue: { name: `audit-incoming-${crypto.randomUUID()}` } });
    const auditConflictId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values({ id: auditConflictId, userId, existingCandidateFactId: auditExisting, incomingCandidateFactId: auditIncoming, kind: "role", status: "pending", createdAt: now });
    const beforeAudit = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const failingAudit: AuditTrail = {
      append: async () => { throw new Error("audit unavailable"); },
      bind: () => failingAudit,
      query: async () => [],
    };
    await expect(createCareerFactConflictReviewCommands({ db: database, auditTrail: failingAudit, id: () => crypto.randomUUID(), clock: () => now })
      .resolve({ userId, requestId: crypto.randomUUID(), conflictId: auditConflictId, command: { expectedVersion: beforeAudit.version, resolution: "keep_both" } })).rejects.toThrow("audit unavailable");
    await expect(createTrustedProfileQueries({ db: database }).getCurrent({ userId })).resolves.toMatchObject({ version: beforeAudit.version });
    await expect(database.select({ status: careerFactConflicts.status }).from(careerFactConflicts).where(eq(careerFactConflicts.id, auditConflictId))).resolves.toEqual([{ status: "pending" }]);
    await expect(database.select({ id: candidateFactDecisions.id }).from(candidateFactDecisions).where(sql`${candidateFactDecisions.candidateFactId} in (${auditExisting}, ${auditIncoming})`)).resolves.toEqual([]);
  });

  it("让同一既有候选事实依次解决两个冲突，且不重复决定并保留最终可信画像", async () => {
    const existing = await seedCandidateFact({ factValue: { name: `shared-existing-${crypto.randomUUID()}` } });
    const firstIncoming = await seedCandidateFact({ factValue: { name: `first-incoming-${crypto.randomUUID()}` } });
    const secondIncoming = await seedCandidateFact({ factValue: { name: `second-incoming-${crypto.randomUUID()}` } });
    const firstConflictId = crypto.randomUUID();
    const secondConflictId = crypto.randomUUID();
    await database.insert(careerFactConflicts).values([
      { id: firstConflictId, userId, existingCandidateFactId: existing, incomingCandidateFactId: firstIncoming, kind: "role", status: "pending", createdAt: now },
      { id: secondConflictId, userId, existingCandidateFactId: existing, incomingCandidateFactId: secondIncoming, kind: "role", status: "pending", createdAt: now },
    ]);
    const resolver = createCareerFactConflictReviewCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const before = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });

    const afterFirst = await resolver.resolve({
      userId, requestId: crypto.randomUUID(), conflictId: firstConflictId,
      command: { expectedVersion: before.version, resolution: "use_existing" },
    });
    const afterSecond = await resolver.resolve({
      userId, requestId: crypto.randomUUID(), conflictId: secondConflictId,
      command: { expectedVersion: afterFirst.profile.version, resolution: "use_incoming" },
    });

    expect(afterFirst.profile.version).toBe(before.version + 1);
    expect(afterSecond.profile.version).toBe(afterFirst.profile.version + 1);
    expect(afterSecond.profile.facts).toEqual(expect.arrayContaining([expect.objectContaining({ candidateFactId: secondIncoming })]));
    expect(afterSecond.profile.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ candidateFactId: existing })]));
    await expect(database.select({ candidateFactId: candidateFactDecisions.candidateFactId, decision: candidateFactDecisions.decision })
      .from(candidateFactDecisions).where(sql`${candidateFactDecisions.candidateFactId} in (${existing}, ${firstIncoming}, ${secondIncoming})`))
      .resolves.toEqual(expect.arrayContaining([
        { candidateFactId: existing, decision: "confirmed" },
        { candidateFactId: firstIncoming, decision: "rejected" },
        { candidateFactId: secondIncoming, decision: "confirmed" },
      ]));
    await expect(database.select({ id: candidateFactDecisions.id }).from(candidateFactDecisions)
      .where(eq(candidateFactDecisions.candidateFactId, existing))).resolves.toHaveLength(1);
    await expect(database.select({ resourceId: auditEvents.resourceId, eventType: auditEvents.eventType }).from(auditEvents)
      .where(and(eq(auditEvents.userId, userId), eq(auditEvents.eventType, "profile.career_fact_conflict_resolved"), sql`${auditEvents.resourceId} in (${firstConflictId}, ${secondConflictId})`)))
      .resolves.toEqual(expect.arrayContaining([
        { resourceId: firstConflictId, eventType: "profile.career_fact_conflict_resolved" },
        { resourceId: secondConflictId, eventType: "profile.career_fact_conflict_resolved" },
      ]));
  });

  it("corrects without changing the candidate fact and rejects without creating a trusted fact", async () => {
    const correctionCandidateId = await seedCandidateFact();
    const rejectionCandidateId = await seedCandidateFact({ factValue: { name: "Angular" } });
    const queries = createTrustedProfileQueries({ db: database });
    const beforeCorrection = await queries.getCurrent({ userId });

    const corrected = await commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId: correctionCandidateId,
      command: { expectedVersion: beforeCorrection.version, decision: "corrected", factValue: { name: "React" }, reason: "实际项目使用 React" },
    });
    expect(corrected.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ factValue: { name: "React" }, source: "user_confirmed", candidateFactId: correctionCandidateId }),
    ]));
    await expect(database.select({ factValue: candidateFacts.factValue }).from(candidateFacts).where(and(
      eq(candidateFacts.userId, userId), eq(candidateFacts.id, correctionCandidateId),
    ))).resolves.toEqual([{ factValue: { name: "TypeScript" } }]);

    const rejected = await commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId: rejectionCandidateId,
      command: { expectedVersion: corrected.version, decision: "rejected" },
    });
    expect(rejected.facts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateFactId: rejectionCandidateId }),
    ]));
    await expect(database.select({ candidateFactId: candidateFactDecisions.candidateFactId, profileVersion: candidateFactDecisions.profileVersion })
      .from(candidateFactDecisions).where(and(
        eq(candidateFactDecisions.userId, userId),
        eq(candidateFactDecisions.candidateFactId, correctionCandidateId),
      ))).resolves.toEqual([{ candidateFactId: correctionCandidateId, profileVersion: corrected.version }]);
    await expect(database.select({ candidateFactId: candidateFactDecisions.candidateFactId, profileVersion: candidateFactDecisions.profileVersion })
      .from(candidateFactDecisions).where(and(
        eq(candidateFactDecisions.userId, userId),
        eq(candidateFactDecisions.candidateFactId, rejectionCandidateId),
      ))).resolves.toEqual([{ candidateFactId: rejectionCandidateId, profileVersion: rejected.version }]);
  });

  it("maintains manual facts as immutable revisions and omits a removed fact from trusted reads", async () => {
    const beforeCreate = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    const created = await commands().createFact({
      userId, requestId: crypto.randomUUID(),
      command: { expectedVersion: beforeCreate.version, factType: "work_eligibility", factValue: { summary: "中国大陆，可合法工作" } },
    });
    const workEligibility = created.facts.find((fact) => fact.factType === "work_eligibility");
    expect(workEligibility).toMatchObject({ source: "user_confirmed", candidateFactId: null });

    const revised = await commands().reviseFact({
      userId, requestId: crypto.randomUUID(), profileFactId: workEligibility!.factId,
      command: { expectedVersion: created.version, factValue: { summary: "中国大陆和新加坡，可合法工作" }, reason: "补充工作资格" },
    });
    expect(revised.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ factId: workEligibility!.factId, factValue: { summary: "中国大陆和新加坡，可合法工作" } }),
    ]));

    const removed = await commands().removeFact({
      userId, requestId: crypto.randomUUID(), profileFactId: workEligibility!.factId,
      command: { expectedVersion: revised.version, reason: "不再适用" },
    });
    expect(removed.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ factId: workEligibility!.factId })]));
    await expect(database.select({
      revisionNumber: profileFactRevisions.revisionNumber,
      profileVersion: profileFactRevisions.profileVersion,
    }).from(profileFactRevisions).where(eq(profileFactRevisions.profileFactId, workEligibility!.factId))
      .orderBy(profileFactRevisions.revisionNumber)).resolves.toEqual([
      { revisionNumber: 1, profileVersion: created.version },
      { revisionNumber: 2, profileVersion: revised.version },
      { revisionNumber: 3, profileVersion: removed.version },
    ]);
  });

  it("rejects a stale expected version without appending a fact revision", async () => {
    const firstCandidateId = await seedCandidateFact({ factValue: { name: "Node.js" } });
    const staleCandidateId = await seedCandidateFact({ factValue: { name: "Vue" } });
    const before = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    await commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId: firstCandidateId,
      command: { expectedVersion: before.version, decision: "confirmed" },
    });
    await expect(commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId: staleCandidateId,
      command: { expectedVersion: before.version, decision: "confirmed" },
    })).rejects.toMatchObject({ code: "PROFILE_VERSION_CONFLICT" });
    await expect(createTrustedProfileQueries({ db: database }).getCurrent({ userId })).resolves.not.toMatchObject({
      facts: expect.arrayContaining([expect.objectContaining({ candidateFactId: staleCandidateId })]),
    });
  });

  it("stops returning decided candidates as pending facts after a reload", async () => {
    const candidateFactId = await seedCandidateFact({ factValue: { name: "PostgreSQL" } });
    const [{ careerImportId }] = await database.select({ careerImportId: candidateFacts.careerImportId })
      .from(candidateFacts).where(and(eq(candidateFacts.userId, userId), eq(candidateFacts.id, candidateFactId)));
    const before = await createTrustedProfileQueries({ db: database }).getCurrent({ userId });
    await commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId,
      command: { expectedVersion: before.version, decision: "confirmed" },
    });

    await expect(createCareerImportQueries({ db: database }).get({ userId, importId: careerImportId! }))
      .resolves.toMatchObject({ facts: [] });
  });

  it("never turns pending, rejected or stale-conflict candidates into trusted profile facts", async () => {
    const pendingCandidateId = await seedCandidateFact({ factValue: { name: "Pending" } });
    const rejectedCandidateId = await seedCandidateFact({ factValue: { name: "Rejected" } });
    const conflictingCandidateId = await seedCandidateFact({ factValue: { name: "Conflicting" } });
    const advancingCandidateId = await seedCandidateFact({ factValue: { name: "Confirmed" } });
    const queries = createTrustedProfileQueries({ db: database });
    const before = await queries.getCurrent({ userId });

    expect(before.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ candidateFactId: pendingCandidateId })]));
    const rejected = await commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId: rejectedCandidateId,
      command: { expectedVersion: before.version, decision: "rejected" },
    });
    expect(rejected.facts).not.toEqual(expect.arrayContaining([expect.objectContaining({ candidateFactId: rejectedCandidateId })]));
    await commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId: advancingCandidateId,
      command: { expectedVersion: rejected.version, decision: "confirmed" },
    });
    await expect(commands().decideCandidateFact({
      userId, requestId: crypto.randomUUID(), candidateFactId: conflictingCandidateId,
      command: { expectedVersion: rejected.version, decision: "confirmed" },
    })).rejects.toMatchObject({ code: "PROFILE_VERSION_CONFLICT" });
    await expect(queries.getCurrent({ userId })).resolves.not.toMatchObject({
      facts: expect.arrayContaining([
        expect.objectContaining({ candidateFactId: pendingCandidateId }),
        expect.objectContaining({ candidateFactId: rejectedCandidateId }),
        expect.objectContaining({ candidateFactId: conflictingCandidateId }),
      ]),
    });
  });

  it("does not let a corrupt decision from another account hide a pending candidate", async () => {
    const candidateFactId = await seedCandidateFact({ factValue: { name: "Tenant-safe" } });
    const [{ careerImportId }] = await database.select({ careerImportId: candidateFacts.careerImportId })
      .from(candidateFacts).where(eq(candidateFacts.id, candidateFactId));
    const otherProfileId = crypto.randomUUID();
    const rollback = new Error("rollback corrupt decision fixture");

    await expect(database.transaction(async (transaction) => {
      await transaction.insert(jobProfiles).values({ id: otherProfileId, userId: otherUserId, version: 1, createdAt: now, updatedAt: now });
      await transaction.execute(sql`alter table candidate_fact_decisions drop constraint candidate_fact_decisions_owner_candidate_fk`);
      await transaction.insert(candidateFactDecisions).values({
        id: crypto.randomUUID(), userId: otherUserId, profileId: otherProfileId, candidateFactId,
        decision: "rejected", profileFactRevisionId: null, profileVersion: 1, createdAt: now,
      });

      await expect(createCareerImportQueries({ db: transaction as unknown as Database }).get({ userId, importId: careerImportId! }))
        .resolves.toMatchObject({ facts: [expect.objectContaining({ factId: candidateFactId })] });
      throw rollback;
    })).rejects.toBe(rollback);

    const constraints = await database.execute(sql`
      select conname from pg_constraint where conname = 'candidate_fact_decisions_owner_candidate_fk'
    `);
    expect(constraints).toHaveLength(1);
  });
});
