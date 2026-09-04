import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  agentInboxItems,
  candidateFactDecisions,
  candidateFacts,
  careerFactConflicts,
  jobProfiles,
  profileFactRevisions,
  profileFacts,
  type Database,
} from "@job-copilot/database";
import {
  ProfileFactSchema,
  ProfileFactInputSchema,
  ProfileSnapshotSchema,
  type CandidateFactDecisionCommand,
  type CreateProfileFactCommand,
  type ProfileFact,
  type ProfileSnapshot,
  type RemoveProfileFactCommand,
  type ReviseProfileFactCommand,
} from "@job-copilot/contracts/profile-review";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export class ProfileReviewError extends Error {
  constructor(public readonly code:
    | "PROFILE_VERSION_CONFLICT"
    | "CANDIDATE_FACT_NOT_FOUND"
    | "CANDIDATE_FACT_ALREADY_DECIDED"
    | "CANDIDATE_FACT_CONFLICT_PENDING"
    | "PROFILE_FACT_NOT_FOUND"
    | "PROFILE_FACT_VALUE_INVALID"
  ) {
    super(code);
  }
}

type Dependencies = {
  db: Database;
  auditTrail: AuditTrail;
  id: () => string;
  clock: () => Date;
};

type ProfileDatabase = Pick<Database, "insert" | "select" | "update">;

async function currentSnapshot(db: ProfileDatabase, userId: string): Promise<ProfileSnapshot> {
  const [profile] = await db.select({ id: jobProfiles.id, version: jobProfiles.version })
    .from(jobProfiles).where(eq(jobProfiles.userId, userId));
  if (!profile) return { profileId: null, version: 0, facts: [] };

  const rows = await db.select({
    factId: profileFacts.id,
    revisionId: profileFactRevisions.id,
    factType: profileFactRevisions.factType,
    factValue: profileFactRevisions.factValue,
    state: profileFactRevisions.state,
    source: profileFactRevisions.source,
    candidateFactId: profileFactRevisions.candidateFactId,
    createdAt: profileFactRevisions.createdAt,
    revisionNumber: profileFactRevisions.revisionNumber,
  }).from(profileFacts).innerJoin(profileFactRevisions, and(
    eq(profileFactRevisions.profileFactId, profileFacts.id),
    eq(profileFactRevisions.userId, profileFacts.userId),
  )).where(and(eq(profileFacts.userId, userId), eq(profileFacts.profileId, profile.id)))
    .orderBy(asc(profileFacts.createdAt), desc(profileFactRevisions.revisionNumber));

  const current = new Map<string, ProfileFact>();
  const observedFacts = new Set<string>();
  for (const row of rows) {
    if (observedFacts.has(row.factId)) continue;
    observedFacts.add(row.factId);
    if (row.state !== "active") continue;
    current.set(row.factId, ProfileFactSchema.parse({
      factId: row.factId,
      revisionId: row.revisionId,
      factType: row.factType,
      factValue: row.factValue,
      source: row.source,
      candidateFactId: row.candidateFactId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  return ProfileSnapshotSchema.parse({ profileId: profile.id, version: profile.version, facts: [...current.values()] });
}

async function advanceProfile(input: {
  db: ProfileDatabase;
  userId: string;
  expectedVersion: number;
  id: () => string;
  now: Date;
}): Promise<{ id: string; version: number }> {
  await input.db.insert(jobProfiles).values({
    id: input.id(), userId: input.userId, version: 0, createdAt: input.now, updatedAt: input.now,
  }).onConflictDoNothing();
  const [profile] = await input.db.update(jobProfiles).set({
    version: sql`${jobProfiles.version} + 1`, updatedAt: input.now,
  }).where(and(eq(jobProfiles.userId, input.userId), eq(jobProfiles.version, input.expectedVersion)))
    .returning({ id: jobProfiles.id, version: jobProfiles.version });
  if (!profile) throw new ProfileReviewError("PROFILE_VERSION_CONFLICT");
  return profile;
}

export function createTrustedProfileQueries(deps: { db: Database }): {
  getCurrent(input: { userId: string }): Promise<ProfileSnapshot>;
} {
  return { getCurrent: ({ userId }) => currentSnapshot(deps.db, userId) };
}

export function createProfileReviewCommands(deps: Dependencies): {
  decideCandidateFact(input: {
    userId: string;
    requestId: string;
    candidateFactId: string;
    command: CandidateFactDecisionCommand;
  }): Promise<ProfileSnapshot>;
  createFact(input: { userId: string; requestId: string; command: CreateProfileFactCommand }): Promise<ProfileSnapshot>;
  reviseFact(input: { userId: string; requestId: string; profileFactId: string; command: ReviseProfileFactCommand }): Promise<ProfileSnapshot>;
  removeFact(input: { userId: string; requestId: string; profileFactId: string; command: RemoveProfileFactCommand }): Promise<ProfileSnapshot>;
} {
  return {
    async decideCandidateFact(input): Promise<ProfileSnapshot> {
      await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [pendingConflict] = await transaction.select({ id: careerFactConflicts.id })
          .from(careerFactConflicts)
          .where(and(
            eq(careerFactConflicts.userId, input.userId),
            eq(careerFactConflicts.status, "pending"),
            or(
              eq(careerFactConflicts.existingCandidateFactId, input.candidateFactId),
              eq(careerFactConflicts.incomingCandidateFactId, input.candidateFactId),
            ),
          ))
          .limit(1);
        if (pendingConflict) throw new ProfileReviewError("CANDIDATE_FACT_CONFLICT_PENDING");
        const profile = await advanceProfile({
          db: transaction, userId: input.userId, expectedVersion: input.command.expectedVersion,
          id: deps.id, now: deps.clock(),
        });
        const [candidate] = await transaction.select({
          id: candidateFacts.id, factType: candidateFacts.factType, factValue: candidateFacts.factValue,
        }).from(candidateFacts).where(and(
          eq(candidateFacts.userId, input.userId), eq(candidateFacts.id, input.candidateFactId),
        ));
        if (!candidate) throw new ProfileReviewError("CANDIDATE_FACT_NOT_FOUND");
        const [existing] = await transaction.select({ id: candidateFactDecisions.id }).from(candidateFactDecisions)
          .where(and(
            eq(candidateFactDecisions.userId, input.userId),
            eq(candidateFactDecisions.candidateFactId, candidate.id),
          ));
        if (existing) throw new ProfileReviewError("CANDIDATE_FACT_ALREADY_DECIDED");

        if (input.command.decision === "rejected") {
          await transaction.insert(candidateFactDecisions).values({
            id: deps.id(), userId: input.userId, profileId: profile.id, candidateFactId: candidate.id,
            decision: "rejected", profileFactRevisionId: null, profileVersion: profile.version, createdAt: deps.clock(),
          });
          await deps.auditTrail.bind(transaction).append({
            userId: input.userId, actorUserId: input.userId, eventType: "profile.candidate_fact_decided",
            occurredAt: deps.clock(), requestId: input.requestId, outcome: "success", reasonCode: "PROFILE_FACT_REJECTED",
            resourceType: "candidate_fact", resourceId: candidate.id,
            metadata: { profileId: profile.id, candidateFactId: candidate.id,
              factType: candidate.factType as "experience" | "education" | "skill" | "project" | "language" | "achievement" | "certification",
              decision: "rejected", profileVersion: profile.version },
          });
          await transaction.update(agentInboxItems).set({ status: "resolved", resolvedAt: deps.clock() }).where(and(
            eq(agentInboxItems.userId, input.userId),
            eq(agentInboxItems.candidateFactId, candidate.id),
            inArray(agentInboxItems.status, ["unread", "read"]),
          ));
          return;
        }

        const factValue = input.command.decision === "corrected" ? input.command.factValue : candidate.factValue;
        if (!ProfileFactInputSchema.safeParse({ factType: candidate.factType, factValue }).success) {
          throw new ProfileReviewError("PROFILE_FACT_VALUE_INVALID");
        }

        const profileFactId = deps.id();
        const revisionId = deps.id();
        await transaction.insert(profileFacts).values({
          id: profileFactId, userId: input.userId, profileId: profile.id, factType: candidate.factType, createdAt: deps.clock(),
        });
        await transaction.insert(profileFactRevisions).values({
          id: revisionId, userId: input.userId, profileFactId, revisionNumber: 1,
          factType: candidate.factType, factValue, state: "active",
          source: input.command.decision === "corrected" ? "user_confirmed" : "candidate_fact",
          candidateFactId: candidate.id,
          reason: input.command.decision === "corrected" ? input.command.reason : null,
          profileVersion: profile.version,
          createdAt: deps.clock(),
        });
        await transaction.insert(candidateFactDecisions).values({
          id: deps.id(), userId: input.userId, profileId: profile.id, candidateFactId: candidate.id,
          decision: input.command.decision, profileFactRevisionId: revisionId, profileVersion: profile.version, createdAt: deps.clock(),
        });
        await deps.auditTrail.bind(transaction).append({
          userId: input.userId, actorUserId: input.userId, eventType: "profile.candidate_fact_decided",
          occurredAt: deps.clock(), requestId: input.requestId, outcome: "success",
          reasonCode: input.command.decision === "corrected" ? "PROFILE_FACT_CORRECTED" : "PROFILE_FACT_CONFIRMED",
          resourceType: "candidate_fact", resourceId: candidate.id,
          metadata: {
            profileId: profile.id, candidateFactId: candidate.id, profileFactId, revisionId,
            factType: candidate.factType as "experience" | "education" | "skill" | "project" | "language" | "achievement" | "certification",
            decision: input.command.decision, profileVersion: profile.version,
          },
        });
        await transaction.update(agentInboxItems).set({ status: "resolved", resolvedAt: deps.clock() }).where(and(
          eq(agentInboxItems.userId, input.userId),
          eq(agentInboxItems.candidateFactId, candidate.id),
          inArray(agentInboxItems.status, ["unread", "read"]),
        ));
      });
      return currentSnapshot(deps.db, input.userId);
    },
    async createFact(input): Promise<ProfileSnapshot> {
      await deps.db.transaction(async (transaction) => {
        const profile = await advanceProfile({ db: transaction, userId: input.userId, expectedVersion: input.command.expectedVersion, id: deps.id, now: deps.clock() });
        const profileFactId = deps.id();
        const revisionId = deps.id();
        await transaction.insert(profileFacts).values({ id: profileFactId, userId: input.userId, profileId: profile.id, factType: input.command.factType, createdAt: deps.clock() });
        await transaction.insert(profileFactRevisions).values({
          id: revisionId, userId: input.userId, profileFactId, revisionNumber: 1, factType: input.command.factType,
          factValue: input.command.factValue, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, createdAt: deps.clock(),
          profileVersion: profile.version,
        });
        await deps.auditTrail.bind(transaction).append({
          userId: input.userId, actorUserId: input.userId, eventType: "profile.fact_maintained", occurredAt: deps.clock(),
          requestId: input.requestId, outcome: "success", reasonCode: "PROFILE_FACT_CREATED", resourceType: "profile_fact", resourceId: profileFactId,
          metadata: { profileId: profile.id, profileFactId, revisionId, factType: input.command.factType, action: "created", profileVersion: profile.version },
        });
      });
      return currentSnapshot(deps.db, input.userId);
    },
    async reviseFact(input): Promise<ProfileSnapshot> {
      await deps.db.transaction(async (transaction) => {
        const profile = await advanceProfile({ db: transaction, userId: input.userId, expectedVersion: input.command.expectedVersion, id: deps.id, now: deps.clock() });
        const [current] = await transaction.select({
          factType: profileFactRevisions.factType, candidateFactId: profileFactRevisions.candidateFactId, revisionNumber: profileFactRevisions.revisionNumber,
        }).from(profileFacts).innerJoin(profileFactRevisions, and(eq(profileFactRevisions.profileFactId, profileFacts.id), eq(profileFactRevisions.userId, profileFacts.userId)))
          .where(and(eq(profileFacts.userId, input.userId), eq(profileFacts.profileId, profile.id), eq(profileFacts.id, input.profileFactId)))
          .orderBy(desc(profileFactRevisions.revisionNumber));
        if (!current) throw new ProfileReviewError("PROFILE_FACT_NOT_FOUND");
        if (!ProfileFactInputSchema.safeParse({ factType: current.factType, factValue: input.command.factValue }).success) throw new ProfileReviewError("PROFILE_FACT_VALUE_INVALID");
        const revisionId = deps.id();
        await transaction.insert(profileFactRevisions).values({
          id: revisionId, userId: input.userId, profileFactId: input.profileFactId, revisionNumber: current.revisionNumber + 1,
          factType: current.factType, factValue: input.command.factValue, state: "active", source: "user_confirmed",
          candidateFactId: current.candidateFactId, reason: input.command.reason, profileVersion: profile.version, createdAt: deps.clock(),
        });
        await deps.auditTrail.bind(transaction).append({
          userId: input.userId, actorUserId: input.userId, eventType: "profile.fact_maintained", occurredAt: deps.clock(),
          requestId: input.requestId, outcome: "success", reasonCode: "PROFILE_FACT_REVISED", resourceType: "profile_fact", resourceId: input.profileFactId,
          metadata: { profileId: profile.id, profileFactId: input.profileFactId, revisionId, factType: current.factType as never, action: "revised", profileVersion: profile.version },
        });
      });
      return currentSnapshot(deps.db, input.userId);
    },
    async removeFact(input): Promise<ProfileSnapshot> {
      await deps.db.transaction(async (transaction) => {
        const profile = await advanceProfile({ db: transaction, userId: input.userId, expectedVersion: input.command.expectedVersion, id: deps.id, now: deps.clock() });
        const [current] = await transaction.select({
          factType: profileFactRevisions.factType, factValue: profileFactRevisions.factValue, candidateFactId: profileFactRevisions.candidateFactId,
          revisionNumber: profileFactRevisions.revisionNumber,
        }).from(profileFacts).innerJoin(profileFactRevisions, and(eq(profileFactRevisions.profileFactId, profileFacts.id), eq(profileFactRevisions.userId, profileFacts.userId)))
          .where(and(eq(profileFacts.userId, input.userId), eq(profileFacts.profileId, profile.id), eq(profileFacts.id, input.profileFactId)))
          .orderBy(desc(profileFactRevisions.revisionNumber));
        if (!current) throw new ProfileReviewError("PROFILE_FACT_NOT_FOUND");
        const revisionId = deps.id();
        await transaction.insert(profileFactRevisions).values({
          id: revisionId, userId: input.userId, profileFactId: input.profileFactId, revisionNumber: current.revisionNumber + 1,
          factType: current.factType, factValue: current.factValue, state: "removed", source: "user_confirmed",
          candidateFactId: current.candidateFactId, reason: input.command.reason, profileVersion: profile.version, createdAt: deps.clock(),
        });
        await deps.auditTrail.bind(transaction).append({
          userId: input.userId, actorUserId: input.userId, eventType: "profile.fact_maintained", occurredAt: deps.clock(),
          requestId: input.requestId, outcome: "success", reasonCode: "PROFILE_FACT_REMOVED", resourceType: "profile_fact", resourceId: input.profileFactId,
          metadata: { profileId: profile.id, profileFactId: input.profileFactId, revisionId, factType: current.factType as never, action: "removed", profileVersion: profile.version },
        });
      });
      return currentSnapshot(deps.db, input.userId);
    },
  };
}

export type ProfileReviewCommands = ReturnType<typeof createProfileReviewCommands>;
export type TrustedProfileQueries = ReturnType<typeof createTrustedProfileQueries>;
