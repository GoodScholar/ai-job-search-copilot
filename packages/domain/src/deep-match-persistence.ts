import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import {
  deepMatchRunCandidates, agentRuns, jobMatchVersions, jobOpportunities, jobSourcePostingVersions, jobTriageVersions, profileFactRevisions, profileFacts,
  recommendationExclusions, recommendationListItems, recommendationLists, type Database,
} from "@job-copilot/database";
import {
  DEEP_MATCH_OUTPUT_SCHEMA_VERSION, DeepMatchAdapterError, DeepMatchAdapterResultSchema, DeepMatchAssessmentSchema, FakeDeepMatchAdapter, validateDeepMatchEvidenceClosure, type DeepMatchAdapter, type DeepMatchAdapterCall, type DeepMatchCandidate,
} from "@job-copilot/contracts/deep-match";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export const DEEP_MATCH_RULE_VERSION = "deep-match-rules-v1";
export const DEEP_MATCH_PROMPT_VERSION = "deep-match-prompt-v1";
export class DeepMatchClaimLostError extends Error { constructor() { super("DEEP_MATCH_CLAIM_LOST"); } }

export type SelectedDeepMatchCandidate = DeepMatchCandidate & {
  triageVersionId: string; profileId: string; profileVersion: number; targetVersion: number; overallScore: number;
  opportunitySnapshot: { company: string | null; title: string | null; location: string | null };
};
export type RecommendationExclusionReason = "TRIAGE_NOT_PASS" | "DEADLINE_EXPIRED" | "SCORE_BELOW_THRESHOLD" | "CANDIDATE_LIMIT" | "MATCH_QUALITY_INSUFFICIENT";
export type CandidateSelection = { candidates: SelectedDeepMatchCandidate[]; exclusions: Array<{ opportunityId: string; reasonCode: Exclude<RecommendationExclusionReason, "MATCH_QUALITY_INSUFFICIENT"> }> };

function profileDimensions(factType: string): DeepMatchCandidate["profileEvidence"][number]["dimensions"] {
  if (factType === "skill" || factType === "language") return ["skills"];
  if (factType === "experience" || factType === "achievement") return ["experience"];
  if (factType === "project") return ["project_depth"];
  if (factType === "education" || factType === "certification" || factType === "work_eligibility") return ["qualification_risk"];
  return [];
}

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
  const readList = async (input: { userId: string; targetId: string; recommendationListId?: string }) => {
    const [list] = await deps.db.select().from(recommendationLists).where(and(
      eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId),
      ...(input.recommendationListId ? [eq(recommendationLists.id, input.recommendationListId)] : []),
    )).orderBy(desc(recommendationLists.createdAt), desc(recommendationLists.sequence)).limit(1);
    if (!list) return null;
      const items = await deps.db.select({ item: recommendationListItems, match: jobMatchVersions, opportunity: jobOpportunities }).from(recommendationListItems)
      .innerJoin(jobMatchVersions, and(eq(jobMatchVersions.userId, recommendationListItems.userId), eq(jobMatchVersions.id, recommendationListItems.matchVersionId)))
      .innerJoin(jobOpportunities, and(eq(jobOpportunities.userId, jobMatchVersions.userId), eq(jobOpportunities.id, jobMatchVersions.opportunityId)))
      .where(and(eq(recommendationListItems.userId, input.userId), eq(recommendationListItems.recommendationListId, list.id))).orderBy(recommendationListItems.ordinal);
    const exclusions = await deps.db.select({ opportunityId: recommendationExclusions.opportunityId, reasonCode: recommendationExclusions.reasonCode }).from(recommendationExclusions)
      .where(and(eq(recommendationExclusions.userId, input.userId), eq(recommendationExclusions.recommendationListId, list.id)));
    return { recommendationListId: list.id, targetId: list.targetId, localDate: list.localDate, sequence: list.sequence, createdAt: list.createdAt.toISOString(), exclusions,
      items: items.map(({ item, match, opportunity }) => {
        const assessment = DeepMatchAssessmentSchema.parse(match.assessment);
        const citedProfileEvidence = new Set(assessment.dimensions.flatMap((dimension) => dimension.profileEvidenceIds));
        return { matchVersionId: match.id, opportunityId: opportunity.id, company: assessment.opportunitySnapshot?.company ?? opportunity.company, title: assessment.opportunitySnapshot?.title ?? opportunity.title, location: assessment.opportunitySnapshot?.location ?? opportunity.location, displayBand: match.displayBand, highlighted: item.highlighted, ordinal: item.ordinal,
          jobEvidence: (assessment.evidenceSnapshot?.jobEvidence ?? []).map(({ id, value }) => ({ id, value })),
          profileEvidence: (assessment.evidenceSnapshot?.profileEvidence ?? []).filter((evidence) => citedProfileEvidence.has(evidence.id)).map(({ id, value }) => ({ id, value })),
          assessment: match.assessment,
        };
      }) };
  };
  const selectCandidateSelection = async (input: { userId: string; targetId: string; opportunityId?: string }): Promise<CandidateSelection> => {
      const triageRows = await deps.db.select({ triage: jobTriageVersions, opportunity: jobOpportunities, sourceVersion: jobSourcePostingVersions })
        .from(jobTriageVersions).innerJoin(jobOpportunities, and(eq(jobOpportunities.userId, jobTriageVersions.userId), eq(jobOpportunities.id, jobTriageVersions.opportunityId)))
        .innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, jobTriageVersions.userId), eq(jobSourcePostingVersions.id, jobTriageVersions.sourcePostingVersionId)))
        .where(and(eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.targetId, input.targetId)))
        .orderBy(desc(jobTriageVersions.sequence));
      const latest = new Map<string, typeof triageRows[number]>();
      for (const row of triageRows) if (!latest.has(row.triage.opportunityId)) latest.set(row.triage.opportunityId, row);
      const scoped = [...latest.values()].filter(({ opportunity }) => input.opportunityId === undefined || opportunity.id === input.opportunityId);
      const exclusions: CandidateSelection["exclusions"] = [];
      const eligible = scoped.filter(({ triage, opportunity }) => {
        if (triage.sourcePostingVersionId !== opportunity.sourcePostingVersionId || triage.overallVerdict !== "pass" || opportunity.availability !== "open") { exclusions.push({ opportunityId: opportunity.id, reasonCode: "TRIAGE_NOT_PASS" }); return false; }
        if (triage.deadlineStatus === "expired") { exclusions.push({ opportunityId: opportunity.id, reasonCode: "DEADLINE_EXPIRED" }); return false; }
        if (triage.overallScore === null || triage.threshold === null || triage.overallScore < triage.threshold) { exclusions.push({ opportunityId: opportunity.id, reasonCode: "SCORE_BELOW_THRESHOLD" }); return false; }
        return true;
      }).sort((left, right) => right.triage.overallScore! - left.triage.overallScore! || left.triage.opportunityId.localeCompare(right.triage.opportunityId));
      eligible.slice(10).forEach(({ opportunity }) => exclusions.push({ opportunityId: opportunity.id, reasonCode: "CANDIDATE_LIMIT" }));
      const candidates = (await Promise.all(eligible.slice(0, 10).map(async ({ triage, opportunity, sourceVersion }) => {
        const revisions = await deps.db.select({ factId: profileFacts.id, revisionId: profileFactRevisions.id, factType: profileFactRevisions.factType, factValue: profileFactRevisions.factValue, state: profileFactRevisions.state, profileVersion: profileFactRevisions.profileVersion, revisionNumber: profileFactRevisions.revisionNumber })
          .from(profileFacts).innerJoin(profileFactRevisions, and(eq(profileFactRevisions.userId, profileFacts.userId), eq(profileFactRevisions.profileFactId, profileFacts.id)))
          .where(and(eq(profileFacts.userId, input.userId), eq(profileFacts.profileId, triage.profileId), lte(profileFactRevisions.profileVersion, triage.profileVersion)));
        const snapshot = new Map<string, typeof revisions[number]>();
        for (const revision of revisions) {
          const previous = snapshot.get(revision.factId);
          if (!previous || revision.profileVersion > previous.profileVersion || (revision.profileVersion === previous.profileVersion && revision.revisionNumber > previous.revisionNumber)) snapshot.set(revision.factId, revision);
        }
        const profileEvidence: DeepMatchCandidate["profileEvidence"] = [...snapshot.values()].filter((revision) => revision.state === "active").flatMap((revision) => {
          const dimensions = profileDimensions(revision.factType);
          return dimensions.length ? [{ id: `profile:${revision.revisionId}`, profileFactRevisionId: revision.revisionId, value: JSON.stringify(revision.factValue).slice(0, 256), dimensions }] : [];
        }).slice(0, 20);
        if (!profileEvidence.length) return null;
        const rawJobEvidence = [
          { value: JSON.stringify(sourceVersion.normalizedData).slice(0, 512), dimensions: ["skills", "qualification_risk"] },
          ...(opportunity.title ? [{ value: opportunity.title, dimensions: ["career_direction"] }] : []),
          ...(opportunity.location ? [{ value: opportunity.location, dimensions: ["location_logistics"] }] : []),
          ...(opportunity.description ? [{ value: opportunity.description.slice(0, 512), dimensions: ["experience", "project_depth"] }] : []),
        ] as Array<{ value: string; dimensions: DeepMatchCandidate["jobEvidence"][number]["dimensions"] }>;
        const jobEvidence: DeepMatchCandidate["jobEvidence"] = rawJobEvidence.filter((evidence) => evidence.value.length > 0).map((evidence, index) => ({ id: `job:${triage.sourcePostingVersionId}:${index + 1}`, ...evidence }));
        return {
          opportunityId: opportunity.id, sourcePostingVersionId: triage.sourcePostingVersionId, triageVersionId: triage.id, profileId: triage.profileId, profileVersion: triage.profileVersion, targetVersion: triage.targetVersion, overallScore: triage.overallScore!, opportunitySnapshot: { company: opportunity.company, title: opportunity.title, location: opportunity.location },
          jobEvidence: jobEvidence.length ? jobEvidence : [{ id: `job:${triage.sourcePostingVersionId}:1`, value: "岗位信息", dimensions: ["skills"] }], profileEvidence,
        } satisfies SelectedDeepMatchCandidate;
      }))).flatMap((candidate): SelectedDeepMatchCandidate[] => candidate ? [candidate] : []);
      return { candidates, exclusions };
    };
  return {
    selectCandidateSelection,
    async selectCandidates(input: { userId: string; targetId: string; opportunityId?: string }): Promise<SelectedDeepMatchCandidate[]> {
      return (await selectCandidateSelection(input)).candidates;
    },
    async getLatestList(input: { userId: string; targetId: string }) { return readList(input); },
    async getFrozenCandidates(input: { userId: string; runId: string }): Promise<SelectedDeepMatchCandidate[]> {
      const rows = await deps.db.select({ candidateSnapshot: deepMatchRunCandidates.candidateSnapshot }).from(deepMatchRunCandidates)
        .where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId))).orderBy(deepMatchRunCandidates.ordinal);
      return rows.map((row) => row.candidateSnapshot as SelectedDeepMatchCandidate);
    },
    async getListHistory(input: { userId: string; targetId: string }) {
      // Recommendation history is an immutable record, not a "recent activity" feed.  Never
      // truncate it silently: callers can render or explicitly paginate the complete result.
      const lists = await deps.db.select().from(recommendationLists).where(and(eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId))).orderBy(desc(recommendationLists.createdAt), desc(recommendationLists.sequence));
      return Promise.all(lists.map(async (list) => {
        const details = await readList({ userId: input.userId, targetId: input.targetId, recommendationListId: list.id });
        if (!details) throw new Error("RECOMMENDATION_HISTORY_VERSION_NOT_FOUND");
        return details;
      }));
    },
  };
}

export function createDeepMatchCommands(deps: { db: Database; id: () => string; clock: () => Date; adapter?: DeepMatchAdapter }) {
  const adapter = deps.adapter ?? new FakeDeepMatchAdapter();
  return {
    async freezeCandidates(input: { userId: string; runId: string; candidates: readonly SelectedDeepMatchCandidate[] }) {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        for (const [index, candidate] of input.candidates.entries()) {
          await transaction.insert(deepMatchRunCandidates).values({
            id: deps.id(), userId: input.userId, runId: input.runId, opportunityId: candidate.opportunityId,
            sourcePostingVersionId: candidate.sourcePostingVersionId, ordinal: index + 1, candidateSnapshot: candidate, createdAt: deps.clock(),
          }).onConflictDoNothing();
        }
        return transaction.select().from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId))).orderBy(deepMatchRunCandidates.ordinal);
      });
    },
    async stageAssessment(input: { userId: string; runId: string; opportunityId: string; assessment: unknown; usage: unknown; fence: { claimToken: string } }) {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [run] = await transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.claimToken, input.fence.claimToken), gt(agentRuns.claimExpiresAt, deps.clock()), eq(agentRuns.controlState, "none")));
        if (!run) throw new DeepMatchClaimLostError();
        const [row] = await transaction.update(deepMatchRunCandidates).set({ assessment: input.assessment, adapterUsage: input.usage })
          .where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId), eq(deepMatchRunCandidates.opportunityId, input.opportunityId), isNull(deepMatchRunCandidates.assessment))).returning();
        if (row) return row;
        const [existing] = await transaction.select().from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId), eq(deepMatchRunCandidates.opportunityId, input.opportunityId)));
        if (!existing?.assessment || !existing.adapterUsage) throw new Error("DEEP_MATCH_STAGE_MISSING");
        return existing;
      });
    },
    async assessAndStage(input: { userId: string; runId: string; candidate: SelectedDeepMatchCandidate; modelCall: DeepMatchAdapterCall; fence: { claimToken: string } }) {
      const [existing] = await deps.db.select({ assessment: deepMatchRunCandidates.assessment, adapterUsage: deepMatchRunCandidates.adapterUsage })
        .from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId), eq(deepMatchRunCandidates.opportunityId, input.candidate.opportunityId))).limit(1);
      if (existing?.assessment && existing.adapterUsage) {
        const parsed = DeepMatchAdapterResultSchema.parse({ assessments: [existing.assessment], usage: existing.adapterUsage });
        return { assessment: parsed.assessments[0]!, usage: parsed.usage, reused: true };
      }
      let result: ReturnType<typeof DeepMatchAdapterResultSchema.parse>;
      try {
        result = DeepMatchAdapterResultSchema.parse(await adapter.assess({ candidates: [{ opportunityId: input.candidate.opportunityId, sourcePostingVersionId: input.candidate.sourcePostingVersionId, jobEvidence: input.candidate.jobEvidence, profileEvidence: input.candidate.profileEvidence }] }, input.modelCall));
      } catch (error) {
        if (error instanceof DeepMatchAdapterError) throw error;
        throw new DeepMatchAdapterError("invalid_output");
      }
      const rawAssessment = result.assessments[0];
      if (!rawAssessment || result.assessments.length !== 1) throw new DeepMatchAdapterError("invalid_output");
      const validated = validateDeepMatchEvidenceClosure(DeepMatchAssessmentSchema.parse(rawAssessment), { jobEvidenceIds: input.candidate.jobEvidence.map((item) => item.id), profileEvidenceIds: input.candidate.profileEvidence.map((item) => item.id) });
      if (validated.opportunityId !== input.candidate.opportunityId) throw new DeepMatchAdapterError("invalid_output");
      const assessment = { ...validated, evidenceSnapshot: { jobEvidence: input.candidate.jobEvidence.map(({ id, value }) => ({ id, value })), profileEvidence: input.candidate.profileEvidence.map(({ id, value }) => ({ id, value })) }, opportunitySnapshot: input.candidate.opportunitySnapshot };
      await this.stageAssessment({ userId: input.userId, runId: input.runId, opportunityId: input.candidate.opportunityId, assessment, usage: result.usage, fence: input.fence });
      return { assessment, usage: result.usage, reused: false };
    },
    /** Publishes a fully staged matching run in one fenced transaction.  Staging is private;
     * no match version or recommendation list becomes visible before every candidate is ready. */
    async publishStagedRun(input: { userId: string; targetId: string; runId: string; fence: { claimToken: string }; selectionExclusions: readonly { opportunityId: string; reasonCode: Exclude<RecommendationExclusionReason, "MATCH_QUALITY_INSUFFICIENT"> }[]; onPublished?: (transaction: any, result: { resultCount: number }) => Promise<void> }) {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [run] = await transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(
          eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"),
          eq(agentRuns.claimToken, input.fence.claimToken), eq(agentRuns.controlState, "none"), gt(agentRuns.claimExpiresAt, deps.clock()),
        )).limit(1);
        if (!run) throw new DeepMatchClaimLostError();
        const staged = await transaction.select().from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId))).orderBy(deepMatchRunCandidates.ordinal);
        if (staged.some((row) => row.assessment === null || row.adapterUsage === null)) throw new Error("DEEP_MATCH_STAGE_INCOMPLETE");
        const completed = staged.map((row) => ({ candidate: row.candidateSnapshot as SelectedDeepMatchCandidate, assessment: DeepMatchAssessmentSchema.parse(row.assessment) }))
          .sort((left, right) => right.assessment.overallScore - left.assessment.overallScore || left.candidate.opportunityId.localeCompare(right.candidate.opportunityId));
        const matches: Array<{ id: string; opportunityId: string; overallScore: number; displayBand: ReturnType<typeof displayBand> }> = [];
        for (const entry of completed) {
          const candidate = entry.candidate;
          if (candidate.targetVersion === undefined || candidate.profileVersion === undefined || candidate.triageVersionId.length === 0 || candidate.sourcePostingVersionId.length === 0) throw new Error("DEEP_MATCH_TUPLE_INVALID");
          const [triage] = await transaction.select().from(jobTriageVersions).where(and(
            eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.id, candidate.triageVersionId), eq(jobTriageVersions.opportunityId, candidate.opportunityId),
            eq(jobTriageVersions.sourcePostingVersionId, candidate.sourcePostingVersionId), eq(jobTriageVersions.profileId, candidate.profileId),
            eq(jobTriageVersions.profileVersion, candidate.profileVersion), eq(jobTriageVersions.targetId, input.targetId), eq(jobTriageVersions.targetVersion, candidate.targetVersion),
          )).limit(1);
          if (!triage) throw new Error("DEEP_MATCH_TUPLE_INVALID");
          const [previous] = await transaction.select({ sequence: jobMatchVersions.sequence }).from(jobMatchVersions).where(and(eq(jobMatchVersions.userId, input.userId), eq(jobMatchVersions.opportunityId, candidate.opportunityId))).orderBy(desc(jobMatchVersions.sequence)).limit(1);
          const assessment = { ...entry.assessment, evidenceSnapshot: entry.assessment.evidenceSnapshot ?? { jobEvidence: candidate.jobEvidence.map(({ id, value }) => ({ id, value })), profileEvidence: candidate.profileEvidence.map(({ id, value }) => ({ id, value })) }, opportunitySnapshot: entry.assessment.opportunitySnapshot ?? candidate.opportunitySnapshot };
          const [match] = await transaction.insert(jobMatchVersions).values({
            id: deps.id(), userId: input.userId, opportunityId: candidate.opportunityId, sourcePostingVersionId: candidate.sourcePostingVersionId, triageVersionId: candidate.triageVersionId,
            profileId: candidate.profileId, profileVersion: candidate.profileVersion, targetId: input.targetId, targetVersion: candidate.targetVersion,
            ruleVersion: DEEP_MATCH_RULE_VERSION, promptVersion: DEEP_MATCH_PROMPT_VERSION, adapter: adapter.adapter, adapterVersion: adapter.adapterVersion, model: adapter.model, outputSchemaVersion: DEEP_MATCH_OUTPUT_SCHEMA_VERSION,
            overallScore: assessment.overallScore, displayBand: displayBand(assessment.overallScore), assessment, sequence: (previous?.sequence ?? 0) + 1, createdAt: deps.clock(),
          }).returning();
          if (!match) throw new Error("DEEP_MATCH_PERSIST_FAILED");
          matches.push({ id: match.id, opportunityId: match.opportunityId, overallScore: match.overallScore, displayBand: match.displayBand as ReturnType<typeof displayBand> });
        }
        const localDate = shanghaiDate(deps.clock());
        const [previousList] = await transaction.select({ sequence: recommendationLists.sequence }).from(recommendationLists).where(and(eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId), eq(recommendationLists.localDate, localDate))).orderBy(desc(recommendationLists.sequence)).limit(1);
        const [list] = await transaction.insert(recommendationLists).values({ id: deps.id(), userId: input.userId, targetId: input.targetId, localDate, sequence: (previousList?.sequence ?? 0) + 1, createdAt: deps.clock() }).returning();
        if (!list) throw new Error("RECOMMENDATION_LIST_PERSIST_FAILED");
        const accepted = matches.filter((match) => {
          const assessment = completed.find((entry) => entry.candidate.opportunityId === match.opportunityId)!.assessment;
          return assessment.overallScore >= 40 && assessment.dimensions.filter((dimension) => dimension.judgment === "evidence_backed_inference").length >= 2;
        });
        const exclusions = [...input.selectionExclusions, ...matches.filter((match) => !accepted.some((item) => item.id === match.id)).map((match) => ({ opportunityId: match.opportunityId, reasonCode: "MATCH_QUALITY_INSUFFICIENT" as const }))];
        if (exclusions.length) await transaction.insert(recommendationExclusions).values(exclusions.map((exclusion) => ({ id: deps.id(), userId: input.userId, targetId: input.targetId, opportunityId: exclusion.opportunityId, recommendationListId: list.id, reasonCode: exclusion.reasonCode, createdAt: deps.clock() })));
        if (accepted.length) await transaction.insert(recommendationListItems).values(accepted.map((match, index) => ({ id: deps.id(), userId: input.userId, recommendationListId: list.id, matchVersionId: match.id, ordinal: index + 1, highlighted: index < 3, createdAt: deps.clock() })));
        const result = { recommendationListId: list.id, items: accepted.map((match, index) => ({ matchVersionId: match.id, ordinal: index + 1, highlighted: index < 3 })) };
        await input.onPublished?.(transaction, { resultCount: result.items.length });
        return result;
      });
    },
    async createMatch(input: { userId: string; targetId: string; candidate: SelectedDeepMatchCandidate; modelCall: DeepMatchAdapterCall; fence?: { runId: string; claimToken: string } }) {
      const rawResult = await adapter.assess({ candidates: [{
        opportunityId: input.candidate.opportunityId, sourcePostingVersionId: input.candidate.sourcePostingVersionId,
        jobEvidence: input.candidate.jobEvidence, profileEvidence: input.candidate.profileEvidence,
      }] }, input.modelCall);
      let result: ReturnType<typeof DeepMatchAdapterResultSchema.parse>;
      try {
        result = DeepMatchAdapterResultSchema.parse(rawResult);
      } catch {
        throw new DeepMatchAdapterError("invalid_output");
      }
      const [rawAssessment] = result.assessments;
      if (!rawAssessment) throw new Error("DEEP_MATCH_EMPTY_OUTPUT");
      const validatedAssessment = validateDeepMatchEvidenceClosure(DeepMatchAssessmentSchema.parse(rawAssessment), {
        jobEvidenceIds: input.candidate.jobEvidence.map((item) => item.id),
        profileEvidenceIds: input.candidate.profileEvidence.map((item) => item.id),
      });
      if (validatedAssessment.opportunityId !== input.candidate.opportunityId) throw new Error("DEEP_MATCH_OPPORTUNITY_IDENTITY_INVALID");
      const assessment = { ...validatedAssessment, evidenceSnapshot: {
        jobEvidence: input.candidate.jobEvidence.map(({ id, value }) => ({ id, value })),
        profileEvidence: input.candidate.profileEvidence.map(({ id, value }) => ({ id, value })),
      }, opportunitySnapshot: input.candidate.opportunitySnapshot };
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
        return { matchVersionId: created.id, sequence: created.sequence, overallScore: created.overallScore, displayBand: created.displayBand, usage: result.usage };
      });
    },
    async createDailyList(input: { userId: string; targetId: string; matchVersionIds: readonly string[]; selectionExclusions?: readonly { opportunityId: string; reasonCode: Exclude<RecommendationExclusionReason, "MATCH_QUALITY_INSUFFICIENT"> }[]; fence?: { runId: string; claimToken: string } }) {
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
        const exclusions = [
          ...excluded.map((matchVersionId) => ({ opportunityId: byId.get(matchVersionId)!.opportunityId, reasonCode: "MATCH_QUALITY_INSUFFICIENT" as const })),
          ...(input.selectionExclusions ?? []),
        ];
        if (exclusions.length) await transaction.insert(recommendationExclusions).values(exclusions.map((exclusion) => ({
          id: deps.id(), userId: input.userId, targetId: input.targetId, opportunityId: exclusion.opportunityId,
          recommendationListId: list.id, reasonCode: exclusion.reasonCode, createdAt: deps.clock(),
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
