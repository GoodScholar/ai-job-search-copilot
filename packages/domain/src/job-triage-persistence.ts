import { and, desc, eq, lte } from "drizzle-orm";
import {
  jobOpportunities, jobOpportunitySources, jobProfiles, jobSourcePostingVersions, jobTargetRevisions, jobTargets,
  jobTriageVersions, profileFactRevisions, profileFacts, type Database,
} from "@job-copilot/database";
import { JobNormalizerOutputSchema } from "@job-copilot/contracts/job-imports";
import { JobTargetConstraintsSchema } from "@job-copilot/contracts/job-targets";
import { JobTriageVersionSchema, type CreateJobTriageVersionCommand, type JobTriageVersion } from "@job-copilot/contracts/job-triage";
import { ProfileFactSchema } from "@job-copilot/contracts/profile-review";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { COARSE_RULE_VERSION, QUALIFICATION_RULE_VERSION, evaluateJobTriage } from "./job-triage";
import type { AuditTrail } from "./audit-trail";

export class JobTriageError extends Error {
  constructor(public readonly code: "JOB_TRIAGE_OPPORTUNITY_NOT_FOUND" | "JOB_TRIAGE_TARGET_NOT_FOUND" | "JOB_TRIAGE_TARGET_INACTIVE" | "JOB_TRIAGE_PROFILE_EMPTY") {
    super(code);
  }
}

type TriageRow = typeof jobTriageVersions.$inferSelect;

function projection(row: TriageRow): JobTriageVersion {
  return JobTriageVersionSchema.parse({
    triageVersionId: row.id, opportunityId: row.opportunityId, targetId: row.targetId,
    overallVerdict: row.overallVerdict, gateResults: row.gateResults, pendingItems: row.pendingItems,
    deadlineStatus: row.deadlineStatus, confidenceBasisPoints: row.confidenceBasisPoints,
    dimensionScores: row.dimensionScores, overallScore: row.overallScore, threshold: row.threshold, sequence: row.sequence,
    createdAt: row.createdAt.toISOString(),
  });
}

async function currentFacts(db: Pick<Database, "select">, userId: string, profileId: string, profileVersion?: number) {
  const rows = await db.select({
    factId: profileFacts.id, revisionId: profileFactRevisions.id, factType: profileFactRevisions.factType,
    factValue: profileFactRevisions.factValue, state: profileFactRevisions.state, source: profileFactRevisions.source,
    candidateFactId: profileFactRevisions.candidateFactId, createdAt: profileFactRevisions.createdAt, revisionNumber: profileFactRevisions.revisionNumber,
  }).from(profileFacts).innerJoin(profileFactRevisions, and(
    eq(profileFactRevisions.userId, profileFacts.userId), eq(profileFactRevisions.profileFactId, profileFacts.id),
  )).where(and(eq(profileFacts.userId, userId), eq(profileFacts.profileId, profileId), ...(profileVersion === undefined ? [] : [lte(profileFactRevisions.profileVersion, profileVersion)])))
    .orderBy(desc(profileFactRevisions.profileVersion), desc(profileFactRevisions.revisionNumber));
  const observed = new Set<string>();
  return rows.flatMap((row) => {
    if (observed.has(row.factId)) return [];
    observed.add(row.factId);
    if (row.state !== "active") return [];
    return [ProfileFactSchema.parse({
      factId: row.factId, revisionId: row.revisionId, factType: row.factType, factValue: row.factValue,
      source: row.source, candidateFactId: row.candidateFactId, createdAt: row.createdAt.toISOString(),
    })];
  });
}

type NormalizedJob = ReturnType<typeof JobNormalizerOutputSchema.parse>;

async function evaluateAndPersistJobTriageInTransaction(input: {
  transaction: any; auditTrail: AuditTrail; id: () => string; clock: () => Date; userId: string; requestId: string;
  opportunityId: string; sourcePostingVersionId: string; profileId: string; profileVersion: number;
  targetId: string; targetVersion: number; targetConstraints: unknown;
  job: Pick<NormalizedJob, "company" | "title" | "location" | "deadline" | "deadlineProvenance" | "qualifications">;
}) {
  const facts = await currentFacts(input.transaction, input.userId, input.profileId, input.profileVersion);
  if (!facts.length) throw new JobTriageError("JOB_TRIAGE_PROFILE_EMPTY");
  const existing = await findVersion(input.transaction, { userId: input.userId, opportunityId: input.opportunityId, sourcePostingVersionId: input.sourcePostingVersionId, profileId: input.profileId, profileVersion: input.profileVersion, targetId: input.targetId, targetVersion: input.targetVersion });
  if (existing) return { ...projection(existing), reused: true };
  const triage = evaluateJobTriage({ sourcePostingVersionId: input.sourcePostingVersionId, now: input.clock(), target: { targetId: input.targetId, version: input.targetVersion, constraints: JobTargetConstraintsSchema.parse(input.targetConstraints) }, job: input.job, facts });
  const previous = await input.transaction.select({ sequence: jobTriageVersions.sequence }).from(jobTriageVersions).where(and(eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.opportunityId, input.opportunityId))).orderBy(desc(jobTriageVersions.sequence)).limit(1);
  const [created] = await input.transaction.insert(jobTriageVersions).values({ id: input.id(), userId: input.userId, opportunityId: input.opportunityId, sourcePostingVersionId: input.sourcePostingVersionId, profileId: input.profileId, profileVersion: input.profileVersion, targetId: input.targetId, targetVersion: input.targetVersion, qualificationRuleVersion: QUALIFICATION_RULE_VERSION, coarseRuleVersion: COARSE_RULE_VERSION, overallVerdict: triage.overallVerdict, gateResults: triage.gateResults, pendingItems: triage.pendingItems, deadlineStatus: triage.deadlineStatus, confidenceBasisPoints: triage.confidenceBasisPoints, dimensionScores: triage.dimensionScores, overallScore: triage.overallScore, threshold: triage.threshold, sequence: (previous[0]?.sequence ?? 0) + 1, createdAt: input.clock() }).returning();
  if (!created) throw new Error("JOB_TRIAGE_PERSIST_FAILED");
  await input.auditTrail.bind(input.transaction).append({ userId: input.userId, actorUserId: input.userId, eventType: "job.triage_created", occurredAt: input.clock(), requestId: input.requestId, outcome: "success", reasonCode: "JOB_TRIAGE_CREATED", resourceType: "job_triage_version", resourceId: created.id, metadata: { triageVersionId: created.id, opportunityId: input.opportunityId, sourcePostingVersionId: input.sourcePostingVersionId, profileId: input.profileId, profileVersion: input.profileVersion, targetId: input.targetId, targetVersion: input.targetVersion, qualificationRuleVersion: QUALIFICATION_RULE_VERSION, coarseRuleVersion: COARSE_RULE_VERSION, overallVerdict: triage.overallVerdict, deadlineStatus: triage.deadlineStatus } });
  return { ...projection(created), reused: false };
}

/** Transaction-bound seam for a recommendation root's immutable profile, target and posting tuple. */
export async function createFrozenJobTriageInTransaction(input: { transaction: any; auditTrail: AuditTrail; id: () => string; clock: () => Date; userId: string; requestId: string; opportunityId: string; sourcePostingVersionId: string; profileId: string; profileVersion: number; targetId: string; targetVersion: number; targetConstraints: unknown }) {
  const [opportunity] = await input.transaction.select({
    availability: jobOpportunities.availability, normalizedData: jobSourcePostingVersions.normalizedData, sourceAvailability: jobSourcePostingVersions.availability,
  }).from(jobOpportunities).innerJoin(jobOpportunitySources, and(eq(jobOpportunitySources.userId, jobOpportunities.userId), eq(jobOpportunitySources.opportunityId, jobOpportunities.id), eq(jobOpportunitySources.sourcePostingVersionId, input.sourcePostingVersionId))).innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, jobOpportunities.userId), eq(jobSourcePostingVersions.id, input.sourcePostingVersionId)))
    .where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.opportunityId))).limit(1);
  if (!opportunity || opportunity.availability !== "open" || opportunity.sourceAvailability !== "open") throw new JobTriageError("JOB_TRIAGE_OPPORTUNITY_NOT_FOUND");
  const normalized = JobNormalizerOutputSchema.parse(opportunity.normalizedData);
  return evaluateAndPersistJobTriageInTransaction({ ...input, job: normalized });
}

async function findVersion(db: Pick<Database, "select">, input: {
  userId: string; opportunityId: string; sourcePostingVersionId: string; profileId: string; profileVersion: number; targetId: string; targetVersion: number;
}) {
  const [row] = await db.select().from(jobTriageVersions).where(and(
    eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.opportunityId, input.opportunityId),
    eq(jobTriageVersions.sourcePostingVersionId, input.sourcePostingVersionId), eq(jobTriageVersions.profileId, input.profileId),
    eq(jobTriageVersions.profileVersion, input.profileVersion), eq(jobTriageVersions.targetId, input.targetId),
    eq(jobTriageVersions.targetVersion, input.targetVersion), eq(jobTriageVersions.qualificationRuleVersion, QUALIFICATION_RULE_VERSION),
    eq(jobTriageVersions.coarseRuleVersion, COARSE_RULE_VERSION),
  ));
  return row;
}

export function createJobTriageCommands(deps: { db: Database; auditTrail: AuditTrail; id: () => string; clock: () => Date }): {
  create(input: { userId: string; requestId: string; opportunityId: string; command: CreateJobTriageVersionCommand }): Promise<JobTriageVersion & { reused: boolean }>;
} {
  return {
    async create(input) {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [opportunity] = await transaction.select({
          id: jobOpportunities.id, sourcePostingVersionId: jobOpportunities.sourcePostingVersionId, company: jobOpportunities.company,
          title: jobOpportunities.title, location: jobOpportunities.location, deadline: jobOpportunities.deadline,
          availability: jobOpportunities.availability, normalizedData: jobOpportunities.normalizedData,
          sourceAvailability: jobSourcePostingVersions.availability,
        }).from(jobOpportunities).innerJoin(jobSourcePostingVersions, and(
          eq(jobSourcePostingVersions.userId, jobOpportunities.userId), eq(jobSourcePostingVersions.id, jobOpportunities.sourcePostingVersionId),
        )).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.opportunityId)));
        if (!opportunity || opportunity.availability !== "open" || opportunity.sourceAvailability !== "open") throw new JobTriageError("JOB_TRIAGE_OPPORTUNITY_NOT_FOUND");

        const [target] = await transaction.select({ id: jobTargets.id, version: jobTargets.version, state: jobTargets.state, constraints: jobTargetRevisions.constraints })
          .from(jobTargets).innerJoin(jobTargetRevisions, and(
            eq(jobTargetRevisions.userId, jobTargets.userId), eq(jobTargetRevisions.targetId, jobTargets.id), eq(jobTargetRevisions.version, jobTargets.version),
          )).where(and(eq(jobTargets.userId, input.userId), eq(jobTargets.id, input.command.targetId)));
        if (!target) throw new JobTriageError("JOB_TRIAGE_TARGET_NOT_FOUND");
        if (target.state !== "active") throw new JobTriageError("JOB_TRIAGE_TARGET_INACTIVE");

        const [profile] = await transaction.select().from(jobProfiles).where(eq(jobProfiles.userId, input.userId));
        if (!profile) throw new JobTriageError("JOB_TRIAGE_PROFILE_EMPTY");
        const normalized = JobNormalizerOutputSchema.parse(opportunity.normalizedData);
        return evaluateAndPersistJobTriageInTransaction({
          transaction, auditTrail: deps.auditTrail, id: deps.id, clock: deps.clock, userId: input.userId, requestId: input.requestId,
          opportunityId: opportunity.id, sourcePostingVersionId: opportunity.sourcePostingVersionId, profileId: profile.id, profileVersion: profile.version,
          targetId: target.id, targetVersion: target.version, targetConstraints: target.constraints,
          job: { ...normalized, company: opportunity.company, title: opportunity.title, location: opportunity.location, deadline: opportunity.deadline?.toISOString() ?? normalized.deadline },
        });
      });
    },
  };
}

export function createJobTriageQueries(deps: { db: Database }): {
  getLatest(input: { userId: string; opportunityId: string; targetId: string }): Promise<JobTriageVersion | null>;
  get(input: { userId: string; opportunityId: string; triageVersionId: string }): Promise<JobTriageVersion | null>;
} {
  return {
    async getLatest(input) {
      const [row] = await deps.db.select().from(jobTriageVersions).where(and(eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.opportunityId, input.opportunityId), eq(jobTriageVersions.targetId, input.targetId)))
        .orderBy(desc(jobTriageVersions.sequence)).limit(1);
      return row ? projection(row) : null;
    },
    async get(input) {
      const [row] = await deps.db.select().from(jobTriageVersions).where(and(eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.opportunityId, input.opportunityId), eq(jobTriageVersions.id, input.triageVersionId)));
      return row ? projection(row) : null;
    },
  };
}

export type JobTriageCommands = ReturnType<typeof createJobTriageCommands>;
export type JobTriageQueries = ReturnType<typeof createJobTriageQueries>;
