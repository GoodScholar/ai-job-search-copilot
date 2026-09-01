import { and, desc, eq, gt, lte } from "drizzle-orm";
import {
  agentRuns, jobMatchVersions, jobOpportunities, jobSourcePostingVersions, jobTriageVersions, profileFactRevisions, profileFacts,
  recommendationExclusions, recommendationListItems, recommendationLists, type Database,
} from "@job-copilot/database";
import {
  DEEP_MATCH_OUTPUT_SCHEMA_VERSION, DeepMatchAssessmentSchema, FakeDeepMatchAdapter, validateDeepMatchEvidenceClosure, type DeepMatchAdapter, type DeepMatchAdapterCall, type DeepMatchCandidate,
} from "@job-copilot/contracts/deep-match";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export const DEEP_MATCH_RULE_VERSION = "deep-match-rules-v1";
export const DEEP_MATCH_PROMPT_VERSION = "deep-match-prompt-v1";
export class DeepMatchClaimLostError extends Error { constructor() { super("DEEP_MATCH_CLAIM_LOST"); } }

export type SelectedDeepMatchCandidate = DeepMatchCandidate & {
  triageVersionId: string; profileId: string; profileVersion: number; targetVersion: number; overallScore: number;
};

function displayBand(score: number): "highly_matched" | "worth_trying" | "consider_carefully" {
  if (score >= 80) return "highly_matched";
  if (score >= 60) return "worth_trying";
  return "consider_carefully";
}

function shanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function createDeepMatchQueries(deps: { db: Database }) {
  return {
    async selectCandidates(input: { userId: string; targetId: string; opportunityId?: string }): Promise<SelectedDeepMatchCandidate[]> {
      const triageRows = await deps.db.select({ triage: jobTriageVersions, opportunity: jobOpportunities, sourceVersion: jobSourcePostingVersions })
        .from(jobTriageVersions).innerJoin(jobOpportunities, and(eq(jobOpportunities.userId, jobTriageVersions.userId), eq(jobOpportunities.id, jobTriageVersions.opportunityId)))
        .innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, jobTriageVersions.userId), eq(jobSourcePostingVersions.id, jobTriageVersions.sourcePostingVersionId)))
        .where(and(eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.targetId, input.targetId)))
        .orderBy(desc(jobTriageVersions.sequence));
      const latest = new Map<string, typeof triageRows[number]>();
      for (const row of triageRows) if (!latest.has(row.triage.opportunityId)) latest.set(row.triage.opportunityId, row);
      const eligible = [...latest.values()].filter(({ triage, opportunity }) => (input.opportunityId === undefined || opportunity.id === input.opportunityId) && triage.sourcePostingVersionId === opportunity.sourcePostingVersionId && triage.overallVerdict === "pass" && triage.deadlineStatus !== "expired" && triage.overallScore !== null && triage.threshold !== null && triage.overallScore >= triage.threshold && opportunity.availability === "open")
        .sort((left, right) => right.triage.overallScore! - left.triage.overallScore! || left.triage.opportunityId.localeCompare(right.triage.opportunityId)).slice(0, 10);
      return (await Promise.all(eligible.map(async ({ triage, opportunity, sourceVersion }) => {
        const revisions = await deps.db.select({ factId: profileFacts.id, revisionId: profileFactRevisions.id, factValue: profileFactRevisions.factValue, state: profileFactRevisions.state, profileVersion: profileFactRevisions.profileVersion, revisionNumber: profileFactRevisions.revisionNumber })
          .from(profileFacts).innerJoin(profileFactRevisions, and(eq(profileFactRevisions.userId, profileFacts.userId), eq(profileFactRevisions.profileFactId, profileFacts.id)))
          .where(and(eq(profileFacts.userId, input.userId), eq(profileFacts.profileId, triage.profileId), lte(profileFactRevisions.profileVersion, triage.profileVersion)));
        const snapshot = new Map<string, typeof revisions[number]>();
        for (const revision of revisions) {
          const previous = snapshot.get(revision.factId);
          if (!previous || revision.profileVersion > previous.profileVersion || (revision.profileVersion === previous.profileVersion && revision.revisionNumber > previous.revisionNumber)) snapshot.set(revision.factId, revision);
        }
        const profileEvidence = [...snapshot.values()].filter((revision) => revision.state === "active").map((revision) => ({ id: `profile:${revision.revisionId}`, profileFactRevisionId: revision.revisionId, value: JSON.stringify(revision.factValue).slice(0, 256) })).slice(0, 20);
        if (!profileEvidence.length) return null;
        const versionEvidence = JSON.stringify({ title: opportunity.title, company: opportunity.company, normalized: sourceVersion.normalizedData }).slice(0, 512);
        return {
          opportunityId: opportunity.id, sourcePostingVersionId: triage.sourcePostingVersionId, triageVersionId: triage.id, profileId: triage.profileId, profileVersion: triage.profileVersion, targetVersion: triage.targetVersion, overallScore: triage.overallScore!,
          jobEvidence: [{ id: `job:${triage.sourcePostingVersionId}`, value: versionEvidence || "岗位信息" }], profileEvidence,
        } satisfies SelectedDeepMatchCandidate;
      }))).flatMap((candidate): SelectedDeepMatchCandidate[] => candidate ? [candidate] : []);
    },
    async getLatestList(input: { userId: string; targetId: string }) {
      const [list] = await deps.db.select().from(recommendationLists).where(and(eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId))).orderBy(desc(recommendationLists.createdAt), desc(recommendationLists.sequence)).limit(1);
      if (!list) return null;
      const items = await deps.db.select({ item: recommendationListItems, match: jobMatchVersions, opportunity: jobOpportunities, sourceVersion: jobSourcePostingVersions }).from(recommendationListItems)
        .innerJoin(jobMatchVersions, and(eq(jobMatchVersions.userId, recommendationListItems.userId), eq(jobMatchVersions.id, recommendationListItems.matchVersionId)))
        .innerJoin(jobOpportunities, and(eq(jobOpportunities.userId, jobMatchVersions.userId), eq(jobOpportunities.id, jobMatchVersions.opportunityId)))
        .innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, jobMatchVersions.userId), eq(jobSourcePostingVersions.id, jobMatchVersions.sourcePostingVersionId)))
        .where(and(eq(recommendationListItems.userId, input.userId), eq(recommendationListItems.recommendationListId, list.id))).orderBy(recommendationListItems.ordinal);
      const exclusions = await deps.db.select({ opportunityId: recommendationExclusions.opportunityId, reasonCode: recommendationExclusions.reasonCode }).from(recommendationExclusions)
        .where(and(eq(recommendationExclusions.userId, input.userId), eq(recommendationExclusions.recommendationListId, list.id)));
      return { recommendationListId: list.id, targetId: list.targetId, localDate: list.localDate, sequence: list.sequence, createdAt: list.createdAt.toISOString(), exclusions,
        items: await Promise.all(items.map(async ({ item, match, opportunity, sourceVersion }) => {
          const assessment = DeepMatchAssessmentSchema.parse(match.assessment);
          const citedProfileEvidence = new Set(assessment.dimensions.flatMap((dimension) => dimension.profileEvidenceIds));
          const profileRevisions = await deps.db.select({ id: profileFactRevisions.id, value: profileFactRevisions.factValue }).from(profileFacts)
            .innerJoin(profileFactRevisions, and(eq(profileFactRevisions.userId, profileFacts.userId), eq(profileFactRevisions.profileFactId, profileFacts.id)))
            .where(and(eq(profileFacts.userId, input.userId), eq(profileFacts.profileId, match.profileId), eq(profileFactRevisions.profileVersion, match.profileVersion), eq(profileFactRevisions.state, "active")));
          const jobValue = JSON.stringify({ title: opportunity.title, company: opportunity.company, normalized: sourceVersion.normalizedData }).slice(0, 512) || "岗位信息";
          return { matchVersionId: match.id, opportunityId: opportunity.id, company: opportunity.company, title: opportunity.title, location: opportunity.location, displayBand: match.displayBand, highlighted: item.highlighted, ordinal: item.ordinal,
            jobEvidence: [{ id: `job:${match.sourcePostingVersionId}`, value: jobValue }],
            profileEvidence: profileRevisions.filter((revision) => citedProfileEvidence.has(`profile:${revision.id}`)).map((revision) => ({ id: `profile:${revision.id}`, value: JSON.stringify(revision.value).slice(0, 256) })),
            assessment: match.assessment,
          };
        })) };
    },
    async getListHistory(input: { userId: string; targetId: string }) {
      const lists = await deps.db.select().from(recommendationLists).where(and(eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId))).orderBy(desc(recommendationLists.createdAt), desc(recommendationLists.sequence)).limit(20);
      return lists.map((list) => ({ recommendationListId: list.id, targetId: list.targetId, localDate: list.localDate, sequence: list.sequence, createdAt: list.createdAt.toISOString() }));
    },
  };
}

export function createDeepMatchCommands(deps: { db: Database; id: () => string; clock: () => Date; adapter?: DeepMatchAdapter }) {
  const adapter = deps.adapter ?? new FakeDeepMatchAdapter();
  return {
    async createMatch(input: { userId: string; targetId: string; candidate: SelectedDeepMatchCandidate; modelCall: DeepMatchAdapterCall; fence?: { runId: string; claimToken: string } }) {
      const [rawAssessment] = await adapter.assess({ candidates: [{
        opportunityId: input.candidate.opportunityId, sourcePostingVersionId: input.candidate.sourcePostingVersionId,
        jobEvidence: input.candidate.jobEvidence, profileEvidence: input.candidate.profileEvidence,
      }] }, input.modelCall);
      if (!rawAssessment) throw new Error("DEEP_MATCH_EMPTY_OUTPUT");
      const assessment = validateDeepMatchEvidenceClosure(DeepMatchAssessmentSchema.parse(rawAssessment), {
        jobEvidenceIds: input.candidate.jobEvidence.map((item) => item.id),
        profileEvidenceIds: input.candidate.profileEvidence.map((item) => item.id),
      });
      if (assessment.opportunityId !== input.candidate.opportunityId) throw new Error("DEEP_MATCH_OPPORTUNITY_IDENTITY_INVALID");
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        if (input.fence) {
          const [run] = await transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.fence.runId), eq(agentRuns.claimToken, input.fence.claimToken), eq(agentRuns.status, "running"), eq(agentRuns.controlState, "none"), gt(agentRuns.claimExpiresAt, deps.clock()))).limit(1);
          if (!run) throw new DeepMatchClaimLostError();
        }
        const [previous] = await transaction.select({ sequence: jobMatchVersions.sequence }).from(jobMatchVersions)
          .where(and(eq(jobMatchVersions.userId, input.userId), eq(jobMatchVersions.opportunityId, input.candidate.opportunityId))).orderBy(desc(jobMatchVersions.sequence)).limit(1);
        const [created] = await transaction.insert(jobMatchVersions).values({
          id: deps.id(), userId: input.userId, opportunityId: input.candidate.opportunityId, sourcePostingVersionId: input.candidate.sourcePostingVersionId, triageVersionId: input.candidate.triageVersionId,
          profileId: input.candidate.profileId, profileVersion: input.candidate.profileVersion, targetId: input.targetId, targetVersion: input.candidate.targetVersion,
          ruleVersion: DEEP_MATCH_RULE_VERSION, promptVersion: DEEP_MATCH_PROMPT_VERSION, adapter: adapter.adapter, adapterVersion: adapter.adapterVersion, model: adapter.model, outputSchemaVersion: DEEP_MATCH_OUTPUT_SCHEMA_VERSION,
          overallScore: assessment.overallScore, displayBand: displayBand(assessment.overallScore), assessment, sequence: (previous?.sequence ?? 0) + 1, createdAt: deps.clock(),
        }).returning();
        if (!created) throw new Error("DEEP_MATCH_PERSIST_FAILED");
        return { matchVersionId: created.id, sequence: created.sequence, overallScore: created.overallScore, displayBand: created.displayBand };
      });
    },
    async createDailyList(input: { userId: string; targetId: string; matchVersionIds: readonly string[]; fence?: { runId: string; claimToken: string } }) {
      if (input.matchVersionIds.length > 10) throw new Error("DEEP_MATCH_LIST_LIMIT");
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        if (input.fence) {
          const [run] = await transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.fence.runId), eq(agentRuns.claimToken, input.fence.claimToken), eq(agentRuns.status, "running"), eq(agentRuns.controlState, "none"), gt(agentRuns.claimExpiresAt, deps.clock()))).limit(1);
          if (!run) throw new DeepMatchClaimLostError();
        }
        const localDate = shanghaiDate(deps.clock());
        const [previous] = await transaction.select({ sequence: recommendationLists.sequence }).from(recommendationLists).where(and(eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId), eq(recommendationLists.localDate, localDate))).orderBy(desc(recommendationLists.sequence)).limit(1);
        const [list] = await transaction.insert(recommendationLists).values({ id: deps.id(), userId: input.userId, targetId: input.targetId, localDate, sequence: (previous?.sequence ?? 0) + 1, createdAt: deps.clock() }).returning();
        if (!list) throw new Error("RECOMMENDATION_LIST_PERSIST_FAILED");
        const matches = input.matchVersionIds.length ? await transaction.select().from(jobMatchVersions).where(and(eq(jobMatchVersions.userId, input.userId), eq(jobMatchVersions.targetId, input.targetId))) : [];
        const byId = new Map(matches.map((match) => [match.id, match]));
        if (input.matchVersionIds.some((id) => !byId.has(id))) throw new Error("RECOMMENDATION_MATCH_NOT_FOUND");
        const acceptedMatchVersionIds = input.matchVersionIds.filter((matchVersionId) => {
          const match = byId.get(matchVersionId)!;
          return match.overallScore >= 60;
        });
        const excluded = input.matchVersionIds.filter((matchVersionId) => !acceptedMatchVersionIds.includes(matchVersionId));
        if (excluded.length) await transaction.insert(recommendationExclusions).values(excluded.map((matchVersionId) => ({
          id: deps.id(), userId: input.userId, targetId: input.targetId, opportunityId: byId.get(matchVersionId)!.opportunityId,
          recommendationListId: list.id, reasonCode: "MATCH_QUALITY_INSUFFICIENT" as const, createdAt: deps.clock(),
        })));
        const items = acceptedMatchVersionIds.map((matchVersionId, index) => ({ id: deps.id(), userId: input.userId, recommendationListId: list.id, matchVersionId, ordinal: index + 1, highlighted: index < 3, createdAt: deps.clock() }));
        if (items.length) await transaction.insert(recommendationListItems).values(items);
        return { recommendationListId: list.id, targetId: input.targetId, localDate, sequence: list.sequence, items: items.map((item) => ({ matchVersionId: item.matchVersionId, highlighted: item.highlighted, ordinal: item.ordinal })) };
      });
    },
  };
}

export type DeepMatchCommands = ReturnType<typeof createDeepMatchCommands>;
export type DeepMatchQueries = ReturnType<typeof createDeepMatchQueries>;
