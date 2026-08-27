import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  candidateFacts,
  candidateFactDecisions,
  candidateFactEvidence,
  careerDocuments,
  careerImports,
  createDatabase,
  jobProfiles,
  jobAccounts,
  migrateDatabase,
  profileFactRevisions,
  type Database,
} from "@job-copilot/database";
import { and, eq, sql } from "drizzle-orm";
import { createAuditTrail } from "./audit-trail";
import { createCareerImportQueries } from "./career-imports";
import { createProfileReviewCommands, createTrustedProfileQueries } from "./profile-review";

const userId = "3e153c8c-d85d-4ec3-8f01-7c08e0b94c36";
const otherUserId = "d2ac09b9-ce59-4ece-9afd-8280be768fb4";
const now = new Date("2026-08-27T12:00:00.000Z");

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
