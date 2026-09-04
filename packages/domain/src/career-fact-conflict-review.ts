import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { candidateFactDecisions, candidateFacts, careerFactConflicts, jobProfiles, profileFactRevisions, profileFacts, type Database } from "@job-copilot/database";
import type { ResolveCareerFactConflictCommand } from "@job-copilot/contracts/career-import";
import type { AuditTrail } from "./audit-trail";
import { createTrustedProfileQueries, resolveCandidateFactInboxItems } from "./profile-review";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export class CareerFactConflictReviewError extends Error {
  constructor(public readonly code: "CAREER_FACT_CONFLICT_NOT_FOUND" | "CAREER_FACT_CONFLICT_ALREADY_RESOLVED" | "CAREER_FACT_CONFLICT_DECISION_INCOMPATIBLE" | "PROFILE_VERSION_CONFLICT") {
    super(code);
  }
}

export function createCareerFactConflictReviewCommands(deps: { db: Database; id: () => string; clock: () => Date; auditTrail: AuditTrail }) {
  return {
    async resolve(input: { userId: string; requestId: string; conflictId: string; command: ResolveCareerFactConflictCommand }) {
      const resolved = await deps.db.transaction(async (tx) => {
        await acquireAccountAdvisoryLock(tx, input.userId);
        const [conflict] = await tx.select().from(careerFactConflicts).where(and(eq(careerFactConflicts.id, input.conflictId), eq(careerFactConflicts.userId, input.userId)));
        if (!conflict) throw new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_NOT_FOUND");
        if (conflict.status !== "pending") throw new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_ALREADY_RESOLVED");
        await tx.insert(jobProfiles).values({ id: deps.id(), userId: input.userId, version: 0, createdAt: deps.clock(), updatedAt: deps.clock() }).onConflictDoNothing();
        const [profile] = await tx.update(jobProfiles).set({ version: sql`${jobProfiles.version} + 1`, updatedAt: deps.clock() })
          .where(and(eq(jobProfiles.userId, input.userId), eq(jobProfiles.version, input.command.expectedVersion))).returning({ id: jobProfiles.id, version: jobProfiles.version });
        if (!profile) throw new CareerFactConflictReviewError("PROFILE_VERSION_CONFLICT");

        const candidates = await tx.select().from(candidateFacts).where(and(eq(candidateFacts.userId, input.userId), inArray(candidateFacts.id, [conflict.existingCandidateFactId, conflict.incomingCandidateFactId])));
        if (candidates.length !== 2) throw new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_NOT_FOUND");
        const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const existing = byId.get(conflict.existingCandidateFactId)!;
        const incoming = byId.get(conflict.incomingCandidateFactId)!;
        const decisions = await tx.select({ candidateFactId: candidateFactDecisions.candidateFactId, decision: candidateFactDecisions.decision }).from(candidateFactDecisions)
          .where(and(eq(candidateFactDecisions.userId, input.userId), inArray(candidateFactDecisions.candidateFactId, [existing.id, incoming.id])));
        const decisionByCandidate = new Map(decisions.map((decision) => [decision.candidateFactId, decision.decision]));

        const latestCandidateRevisions = async (candidateFactId: string) => {
          const revisions = await tx.select({ profileFactId: profileFacts.id, revisionId: profileFactRevisions.id, revisionNumber: profileFactRevisions.revisionNumber, factType: profileFactRevisions.factType, factValue: profileFactRevisions.factValue, state: profileFactRevisions.state })
            .from(profileFacts).innerJoin(profileFactRevisions, and(eq(profileFactRevisions.profileFactId, profileFacts.id), eq(profileFactRevisions.userId, profileFacts.userId)))
            .where(and(eq(profileFacts.userId, input.userId), eq(profileFacts.profileId, profile.id), eq(profileFactRevisions.candidateFactId, candidateFactId)))
            .orderBy(desc(profileFactRevisions.revisionNumber));
          const latest = new Map<string, typeof revisions[number]>();
          for (const revision of revisions) if (!latest.has(revision.profileFactId)) latest.set(revision.profileFactId, revision);
          return [...latest.values()];
        };
        const ensureActive = async (candidate: typeof existing): Promise<string> => {
          const active = (await latestCandidateRevisions(candidate.id)).find((revision) => revision.state === "active");
          if (active) return active.revisionId;
          const profileFactId = deps.id();
          const revisionId = deps.id();
          await tx.insert(profileFacts).values({ id: profileFactId, userId: input.userId, profileId: profile.id, factType: candidate.factType, createdAt: deps.clock() });
          await tx.insert(profileFactRevisions).values({ id: revisionId, userId: input.userId, profileFactId, revisionNumber: 1, factType: candidate.factType, factValue: candidate.factValue, state: "active", source: "candidate_fact", candidateFactId: candidate.id, reason: null, profileVersion: profile.version, createdAt: deps.clock() });
          return revisionId;
        };
        const removeActive = async (candidateFactId: string) => {
          for (const revision of await latestCandidateRevisions(candidateFactId)) {
            if (revision.state !== "active") continue;
            await tx.insert(profileFactRevisions).values({ id: deps.id(), userId: input.userId, profileFactId: revision.profileFactId, revisionNumber: revision.revisionNumber + 1, factType: revision.factType, factValue: revision.factValue, state: "removed", source: "candidate_fact", candidateFactId, reason: null, profileVersion: profile.version, createdAt: deps.clock() });
          }
        };
        const insertDecision = (candidateFactId: string, decision: "confirmed" | "rejected", profileFactRevisionId: string | null) => tx.insert(candidateFactDecisions).values({ id: deps.id(), userId: input.userId, profileId: profile.id, candidateFactId, decision, profileFactRevisionId, profileVersion: profile.version, createdAt: deps.clock() });

        const applyDesiredState = async (candidate: typeof existing, desiredActive: boolean) => {
          const decision = decisionByCandidate.get(candidate.id);
          if (decision === "corrected" || (decision === "rejected" && desiredActive)) {
            throw new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_DECISION_INCOMPATIBLE");
          }
          if (decision === "confirmed") {
            if (desiredActive) await ensureActive(candidate);
            else await removeActive(candidate.id);
            return;
          }
          if (decision === "rejected") return;
          if (desiredActive) await insertDecision(candidate.id, "confirmed", await ensureActive(candidate));
          else await insertDecision(candidate.id, "rejected", null);
        };
        await applyDesiredState(existing, input.command.resolution !== "use_incoming");
        await applyDesiredState(incoming, input.command.resolution !== "use_existing");

        const resolvedAt = deps.clock();
        await resolveCandidateFactInboxItems({
          db: tx,
          userId: input.userId,
          candidateFactIds: [existing.id, incoming.id],
          resolvedAt,
        });
        const [updated] = await tx.update(careerFactConflicts).set({ status: "resolved", resolution: input.command.resolution, profileVersion: profile.version, resolvedAt })
          .where(and(eq(careerFactConflicts.id, conflict.id), eq(careerFactConflicts.userId, input.userId), eq(careerFactConflicts.status, "pending"))).returning({ id: careerFactConflicts.id });
        if (!updated) throw new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_ALREADY_RESOLVED");
        await deps.auditTrail.bind(tx).append({
          userId: input.userId, actorUserId: input.userId, eventType: "profile.career_fact_conflict_resolved", occurredAt: deps.clock(), requestId: input.requestId,
          outcome: "success", reasonCode: "CAREER_FACT_CONFLICT_RESOLVED", resourceType: "career_fact_conflict", resourceId: conflict.id,
          metadata: { conflictId: conflict.id, existingCandidateFactId: conflict.existingCandidateFactId, incomingCandidateFactId: conflict.incomingCandidateFactId, kind: conflict.kind as "date" | "role" | "organization" | "metric", resolution: input.command.resolution, profileId: profile.id, profileVersion: profile.version },
        });
        return { conflictId: conflict.id, kind: conflict.kind as "date" | "role" | "organization" | "metric", status: "resolved" as const, resolution: input.command.resolution, profileVersion: profile.version, resolvedAt: resolvedAt.toISOString() };
      });
      return { profile: await createTrustedProfileQueries({ db: deps.db }).getCurrent({ userId: input.userId }), conflict: resolved };
    },
  };
}
