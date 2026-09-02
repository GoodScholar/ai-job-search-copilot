import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  deepMatchRunCandidates, agentRuns, jobMatchVersions, jobOpportunities, jobOpportunitySources, jobSourcePostingVersions, jobTargetRevisions, jobTriageVersions, profileFactRevisions, profileFacts,
  recommendationExclusions, recommendationListItems, recommendationLists, recommendationDecisionEvents, type Database,
} from "@job-copilot/database";
import {
  DEEP_MATCH_OUTPUT_SCHEMA_VERSION, DeepMatchAdapterError, DeepMatchAdapterInputSchema, DeepMatchAdapterResultSchema, DeepMatchAssessmentSchema, DeepMatchCandidateSchema, FakeDeepMatchAdapter, acceptsDeepMatchAssessment, isDeepMatchTriageEligible, validateDeepMatchEvidenceClosure, type DeepMatchAdapter, type DeepMatchAdapterCall, type DeepMatchCandidate,
} from "@job-copilot/contracts/deep-match";
import { JobQualificationsSchema } from "@job-copilot/contracts/job-imports";
import { JobTargetConstraintsSchema } from "@job-copilot/contracts/job-targets";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export const DEEP_MATCH_RULE_VERSION = "deep-match-rules-v1";
export const DEEP_MATCH_PROMPT_VERSION = "deep-match-prompt-v1";
export class DeepMatchClaimLostError extends Error { constructor() { super("DEEP_MATCH_CLAIM_LOST"); } }

export type SelectedDeepMatchCandidate = DeepMatchCandidate & {
  triageVersionId: string; profileId: string; profileVersion: number; targetVersion: number; overallScore: number;
  opportunitySnapshot: { company: string | null; title: string | null; location: string | null };
};
export type RecommendationExclusionReason = "TRIAGE_NOT_PASS" | "DEADLINE_EXPIRED" | "SCORE_BELOW_THRESHOLD" | "CANDIDATE_LIMIT" | "MATCH_QUALITY_INSUFFICIENT";
export type CandidateSelection = { candidates: SelectedDeepMatchCandidate[]; exclusions: Array<{ opportunityId: string; reasonCode: RecommendationExclusionReason }> };

function profileDimensions(factType: string): DeepMatchCandidate["profileEvidence"][number]["dimensions"] {
  if (factType === "skill" || factType === "language") return ["skills"];
  if (factType === "experience" || factType === "achievement") return ["experience"];
  if (factType === "project") return ["project_depth"];
  if (factType === "education" || factType === "certification" || factType === "work_eligibility") return ["qualification_risk"];
  return [];
}

function displayBand(assessment: { overallScore: number; dimensions: Array<{ judgment: string }> }): "highly_matched" | "worth_trying" | "consider_carefully" {
  // A deterministic CI ordering fixture may provide a score, but it cannot fabricate the
  // six-sided evidence needed for the user-facing high-match label.
  if (assessment.overallScore >= 80 && assessment.dimensions.filter((dimension) => dimension.judgment === "evidence_backed_inference").length === 6) return "highly_matched";
  if (assessment.overallScore >= 60) return "worth_trying";
  return "consider_carefully";
}

function assertStagedAssessment(candidate: SelectedDeepMatchCandidate, assessment: ReturnType<typeof DeepMatchAssessmentSchema.parse>) {
  if (assessment.opportunityId !== candidate.opportunityId) throw new Error("DEEP_MATCH_STAGED_CANDIDATE_INVALID");
  validateDeepMatchEvidenceClosure(assessment, {
    jobEvidence: candidate.jobEvidence,
    profileEvidence: candidate.profileEvidence,
  });
  const expectedEvidenceSnapshot = {
    jobEvidence: candidate.jobEvidence.map(({ id, value, provenance }) => ({ id, value, ...(provenance ? { provenance } : {}) })),
    profileEvidence: candidate.profileEvidence.map((evidence) => evidence.kind === "profile_fact"
      ? { id: evidence.id, value: evidence.value, kind: evidence.kind, profileFactRevisionId: evidence.profileFactRevisionId }
      : { id: evidence.id, value: evidence.value, kind: evidence.kind, targetRevisionId: evidence.targetRevisionId }),
  };
  const sameEvidence = (actual: typeof assessment.evidenceSnapshot, expected: typeof expectedEvidenceSnapshot) => actual !== undefined
    && actual.jobEvidence.length === expected.jobEvidence.length
    && actual.profileEvidence.length === expected.profileEvidence.length
    && actual.jobEvidence.every((item, index) => {
      const expectedItem = expected.jobEvidence[index];
      if (!expectedItem || item.id !== expectedItem.id || item.value !== expectedItem.value) return false;
      if (!item.provenance || !expectedItem.provenance) return item.provenance === expectedItem.provenance;
      return item.provenance.sourcePostingVersionId === expectedItem.provenance.sourcePostingVersionId
        && item.provenance.field === expectedItem.provenance.field && item.provenance.path === expectedItem.provenance.path
        && item.provenance.originalValue === expectedItem.provenance.originalValue && item.provenance.normalizedValue === expectedItem.provenance.normalizedValue;
    })
    && actual.profileEvidence.every((item, index) => {
      const expectedItem = expected.profileEvidence[index];
      if (!expectedItem || item.id !== expectedItem.id || item.value !== expectedItem.value || item.kind !== expectedItem.kind) return false;
      return item.kind === "profile_fact"
        ? expectedItem.kind === "profile_fact" && item.profileFactRevisionId === expectedItem.profileFactRevisionId
        : expectedItem.kind === "target_revision" && item.targetRevisionId === expectedItem.targetRevisionId;
    });
  const sameOpportunity = assessment.opportunitySnapshot !== undefined
    && assessment.opportunitySnapshot.company === candidate.opportunitySnapshot.company
    && assessment.opportunitySnapshot.title === candidate.opportunitySnapshot.title
    && assessment.opportunitySnapshot.location === candidate.opportunitySnapshot.location;
  if (!sameEvidence(assessment.evidenceSnapshot, expectedEvidenceSnapshot) || !sameOpportunity) {
    throw new Error("DEEP_MATCH_STAGED_CANDIDATE_INVALID");
  }
}

function shanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function boundedEvidenceText(prefix: string, values: readonly string[], limit = 512): string | null {
  let result = prefix;
  let appended = 0;
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value) continue;
    const separator = appended === 0 ? "" : "、";
    const available = limit - result.length - separator.length;
    if (available <= 0) break;
    result += `${separator}${value.slice(0, available)}`;
    appended += 1;
    if (value.length > available) break;
  }
  return appended > 0 ? result : null;
}

export function createDeepMatchQueries(deps: { db: Database }) {
  const readList = async (input: { userId: string; targetId: string; recommendationListId?: string; includeExclusions?: boolean; exclusionLimit?: number }) => {
    const [list] = await deps.db.select().from(recommendationLists).where(and(
      eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId),
      ...(input.recommendationListId ? [eq(recommendationLists.id, input.recommendationListId)] : []),
    )).orderBy(desc(recommendationLists.createdAt), desc(recommendationLists.sequence)).limit(1);
    if (!list) return null;
      const items = await deps.db.select({ item: recommendationListItems, match: jobMatchVersions, opportunity: jobOpportunities }).from(recommendationListItems)
      .innerJoin(jobMatchVersions, and(eq(jobMatchVersions.userId, recommendationListItems.userId), eq(jobMatchVersions.id, recommendationListItems.matchVersionId)))
      .innerJoin(jobOpportunities, and(eq(jobOpportunities.userId, jobMatchVersions.userId), eq(jobOpportunities.id, jobMatchVersions.opportunityId)))
      .where(and(eq(recommendationListItems.userId, input.userId), eq(recommendationListItems.recommendationListId, list.id))).orderBy(recommendationListItems.ordinal);
    const exclusionRows = input.includeExclusions === false ? [] : await deps.db.select({ id: recommendationExclusions.id, opportunityId: recommendationExclusions.opportunityId, reasonCode: recommendationExclusions.reasonCode }).from(recommendationExclusions)
      .where(and(eq(recommendationExclusions.userId, input.userId), eq(recommendationExclusions.recommendationListId, list.id))).orderBy(asc(recommendationExclusions.createdAt), asc(recommendationExclusions.id)).limit((input.exclusionLimit ?? Number.MAX_SAFE_INTEGER) + 1);
    const exclusions = input.exclusionLimit ? exclusionRows.slice(0, input.exclusionLimit).map(({ opportunityId, reasonCode }) => ({ opportunityId, reasonCode })) : exclusionRows.map(({ opportunityId, reasonCode }) => ({ opportunityId, reasonCode }));
    const exclusionsNextCursor = input.exclusionLimit && exclusionRows.length > input.exclusionLimit ? exclusionRows[input.exclusionLimit - 1]!.id : null;
    const decisions = await deps.db.select().from(recommendationDecisionEvents).where(and(eq(recommendationDecisionEvents.userId, input.userId), eq(recommendationDecisionEvents.recommendationListId, list.id))).orderBy(desc(recommendationDecisionEvents.version));
    const latestDecision = new Map<string, typeof decisions[number]>();
    for (const decision of decisions) if (!latestDecision.has(decision.recommendationListItemId)) latestDecision.set(decision.recommendationListItemId, decision);
    return { recommendationListId: list.id, targetId: list.targetId, localDate: list.localDate, sequence: list.sequence, createdAt: list.createdAt.toISOString(), exclusions, ...(input.exclusionLimit ? { exclusionsNextCursor } : {}),
      items: items.map(({ item, match, opportunity }) => {
        const assessment = DeepMatchAssessmentSchema.parse(match.assessment);
        const citedJobEvidence = new Set(assessment.dimensions.flatMap((dimension) => dimension.jobEvidenceIds));
        const citedProfileEvidence = new Set(assessment.dimensions.flatMap((dimension) => dimension.profileEvidenceIds));
        const decision = latestDecision.get(item.id);
        return { recommendationListItemId: item.id, decision: decision ? { status: decision.decision, version: decision.version } : { status: "pending", version: 0 }, matchVersionId: match.id, opportunityId: opportunity.id, company: assessment.opportunitySnapshot?.company ?? opportunity.company, title: assessment.opportunitySnapshot?.title ?? opportunity.title, location: assessment.opportunitySnapshot?.location ?? opportunity.location, displayBand: match.displayBand, highlighted: item.highlighted, ordinal: item.ordinal,
          jobEvidence: (assessment.evidenceSnapshot?.jobEvidence ?? []).filter((evidence) => citedJobEvidence.has(evidence.id)).map(({ id, value, provenance }) => ({ id, value, ...(provenance ? { provenance } : {}) })),
          profileEvidence: (assessment.evidenceSnapshot?.profileEvidence ?? []).filter((evidence) => citedProfileEvidence.has(evidence.id)),
          assessment: match.assessment,
        };
      }) };
  };
  const selectCandidateSelection = async (input: { userId: string; targetId: string; targetVersion: number; opportunityId?: string; ruleConfig?: { excludedOpportunityIds: string[] } }): Promise<CandidateSelection> => {
      const triageRows = await deps.db.select({ triage: jobTriageVersions, opportunity: jobOpportunities, sourceVersion: jobSourcePostingVersions, targetRevisionId: jobTargetRevisions.id, targetConstraints: jobTargetRevisions.constraints })
        .from(jobTriageVersions).innerJoin(jobOpportunities, and(eq(jobOpportunities.userId, jobTriageVersions.userId), eq(jobOpportunities.id, jobTriageVersions.opportunityId)))
        .innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, jobTriageVersions.userId), eq(jobSourcePostingVersions.id, jobTriageVersions.sourcePostingVersionId)))
        .innerJoin(jobTargetRevisions, and(eq(jobTargetRevisions.userId, jobTriageVersions.userId), eq(jobTargetRevisions.targetId, jobTriageVersions.targetId), eq(jobTargetRevisions.version, jobTriageVersions.targetVersion)))
        .where(and(eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.targetId, input.targetId)))
        .orderBy(desc(jobTriageVersions.sequence), asc(jobTriageVersions.opportunityId), asc(jobTriageVersions.id));
      const latest = new Map<string, typeof triageRows[number]>();
      for (const row of triageRows) if (!latest.has(row.triage.opportunityId)) latest.set(row.triage.opportunityId, row);
      const excluded = new Set(input.ruleConfig?.excludedOpportunityIds ?? []);
      const scoped = [...latest.values()].filter(({ opportunity }) => !excluded.has(opportunity.id) && (input.opportunityId === undefined || opportunity.id === input.opportunityId));
      const exclusions: CandidateSelection["exclusions"] = [];
      const eligible = scoped.filter(({ triage, opportunity }) => {
        const eligibleByPolicy = isDeepMatchTriageEligible({ sourcePostingVersionId: triage.sourcePostingVersionId, expectedSourcePostingVersionId: opportunity.sourcePostingVersionId, targetVersion: triage.targetVersion, expectedTargetVersion: input.targetVersion, overallVerdict: triage.overallVerdict, deadlineStatus: triage.deadlineStatus, availability: opportunity.availability, overallScore: triage.overallScore, threshold: triage.threshold });
        if (eligibleByPolicy) return true;
        if (triage.sourcePostingVersionId !== opportunity.sourcePostingVersionId || triage.overallVerdict !== "pass" || opportunity.availability !== "open") { exclusions.push({ opportunityId: opportunity.id, reasonCode: "TRIAGE_NOT_PASS" }); return false; }
        if (triage.deadlineStatus === "expired") { exclusions.push({ opportunityId: opportunity.id, reasonCode: "DEADLINE_EXPIRED" }); return false; }
        if (triage.overallScore === null || triage.threshold === null || triage.overallScore < triage.threshold) { exclusions.push({ opportunityId: opportunity.id, reasonCode: "SCORE_BELOW_THRESHOLD" }); return false; }
        exclusions.push({ opportunityId: opportunity.id, reasonCode: "TRIAGE_NOT_PASS" }); return false;
      }).sort((left, right) => right.triage.overallScore! - left.triage.overallScore! || left.triage.opportunityId.localeCompare(right.triage.opportunityId));
      const evaluated = await Promise.all(eligible.map(async ({ triage, opportunity, sourceVersion, targetRevisionId, targetConstraints }) => {
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
          return dimensions.length ? [{ id: `profile:${revision.revisionId}`, kind: "profile_fact" as const, profileFactRevisionId: revision.revisionId, value: JSON.stringify(revision.factValue).slice(0, 256), dimensions }] : [];
        });
        const targetConstraintsResult = JobTargetConstraintsSchema.safeParse(targetConstraints);
        if (!targetConstraintsResult.success) return null;
        const constraints = targetConstraintsResult.data;
        const roleFact = boundedEvidenceText("已确认的岗位方向：", [constraints.roleFamily ?? ""], 256);
        if (roleFact) profileEvidence.push({ id: `target:${targetRevisionId}:career`, kind: "target_revision", targetRevisionId, value: roleFact, dimensions: ["career_direction"] });
        const locationFact = boundedEvidenceText("已确认的地点/工作方式约束：", [...constraints.workModes, constraints.relocation !== "unknown" ? constraints.relocation : "", ...constraints.locations], 256);
        if (locationFact) profileEvidence.push({ id: `target:${targetRevisionId}:location`, kind: "target_revision", targetRevisionId, value: locationFact, dimensions: ["location_logistics"] });
        // Reserve one stable slot for every available semantic dimension before filling
        // the remaining bounded context.  A long skills list must not erase project,
        // experience, qualification or frozen target constraints.
        const byDimension = [...profileEvidence].sort((left, right) => left.id.localeCompare(right.id));
        const quota = new Set<string>();
        const selectedProfileEvidence: DeepMatchCandidate["profileEvidence"] = [];
        for (const dimension of ["skills", "experience", "project_depth", "career_direction", "location_logistics", "qualification_risk"] as const) {
          const evidence = byDimension.find((item) => item.dimensions.includes(dimension));
          if (evidence && !quota.has(evidence.id)) { quota.add(evidence.id); selectedProfileEvidence.push(evidence); }
        }
        for (const evidence of byDimension) if (selectedProfileEvidence.length < 20 && !quota.has(evidence.id)) { quota.add(evidence.id); selectedProfileEvidence.push(evidence); }
        profileEvidence.splice(0, profileEvidence.length, ...selectedProfileEvidence);
        if (!profileEvidence.length) return null;
        // Both records are immutable, source-backed snapshots from the imported posting.
        // Prefer the posting-version payload; old imports can only contribute their
        // opportunity normalization when it is non-empty (never an `{}` fallback).
        const sourceNormalized = sourceVersion.normalizedData as Record<string, unknown>;
        const opportunityNormalized = opportunity.normalizedData as Record<string, unknown>;
        const normalized = Object.keys(sourceNormalized).length > 0 ? sourceNormalized : opportunityNormalized;
        const qualifications = JobQualificationsSchema.safeParse((normalized as { qualifications?: unknown }).qualifications).data;
        const requiredSkills = qualifications?.requiredSkills?.value ?? [];
        const requiredSkillsEvidence = qualifications?.requiredSkills ? boundedEvidenceText("岗位明确要求：", requiredSkills) : null;
        const qualificationValue = (value: NonNullable<typeof qualifications>["seniority"] | NonNullable<typeof qualifications>["education"] | NonNullable<typeof qualifications>["languages"] | NonNullable<typeof qualifications>["workEligibility"]) => value === null ? null : typeof value.value === "string" ? value.value : value.value.map((language) => `${language.name}${language.level ? `（${language.level}）` : ""}`).join("、");
        const boundedValue = (value: string) => boundedEvidenceText("", [value]) ?? "";
        const sourceEvidence = (field: string, path: string, originalValue: string, normalizedValue: string) => ({ sourcePostingVersionId: triage.sourcePostingVersionId, field, path, originalValue: boundedValue(originalValue), normalizedValue: boundedValue(normalizedValue) });
        const jobEvidenceItem = (value: string, dimensions: DeepMatchCandidate["jobEvidence"][number]["dimensions"], provenance: ReturnType<typeof sourceEvidence>) => ({ value: boundedValue(value), dimensions, provenance });
        const rawJobEvidence: Array<Omit<DeepMatchCandidate["jobEvidence"][number], "id">> = [
          ...(requiredSkillsEvidence ? [jobEvidenceItem(requiredSkillsEvidence, ["skills"], sourceEvidence(qualifications!.requiredSkills!.evidence.field, qualifications!.requiredSkills!.evidence.path, qualifications!.requiredSkills!.evidence.value, boundedEvidenceText("", requiredSkills) ?? ""))] : []),
          ...([qualifications?.seniority, qualifications?.education, qualifications?.languages, qualifications?.workEligibility].flatMap((item) => {
            if (!item) return [];
            const value = qualificationValue(item);
            return value ? [jobEvidenceItem(`岗位资格要求：${value}`, ["qualification_risk"], sourceEvidence(item.evidence.field, item.evidence.path, item.evidence.value, value))] : [];
          })),
          ...(qualifications?.workMode ? [jobEvidenceItem(`工作方式：${qualifications.workMode.value}`, ["location_logistics"], sourceEvidence(qualifications.workMode.evidence.field, qualifications.workMode.evidence.path, qualifications.workMode.evidence.value, qualifications.workMode.value))] : []),
          ...(qualifications?.relocationRequired ? [jobEvidenceItem(qualifications.relocationRequired.value ? "需要异地到岗" : "不要求异地到岗", ["location_logistics"], sourceEvidence(qualifications.relocationRequired.evidence.field, qualifications.relocationRequired.evidence.path, qualifications.relocationRequired.evidence.value, String(qualifications.relocationRequired.value)))] : []),
          ...(qualifications?.salary ? [jobEvidenceItem(`薪资：${qualifications.salary.value.currency} ${qualifications.salary.value.minimum ?? ""}${qualifications.salary.value.maximum === null ? "" : `-${qualifications.salary.value.maximum}`}/${qualifications.salary.value.period}`, ["qualification_risk"], sourceEvidence(qualifications.salary.evidence.field, qualifications.salary.evidence.path, qualifications.salary.evidence.value, JSON.stringify(qualifications.salary.value)))] : []),
          ...(qualifications?.industry ? [jobEvidenceItem(`行业：${qualifications.industry.value}`, ["career_direction"], sourceEvidence(qualifications.industry.evidence.field, qualifications.industry.evidence.path, qualifications.industry.evidence.value, qualifications.industry.value))] : []),
          ...(qualifications?.employmentType ? [jobEvidenceItem(`雇佣类型：${qualifications.employmentType.value}`, ["qualification_risk"], sourceEvidence(qualifications.employmentType.evidence.field, qualifications.employmentType.evidence.path, qualifications.employmentType.evidence.value, qualifications.employmentType.value))] : []),
          ...(opportunity.title ? [jobEvidenceItem(opportunity.title, ["career_direction"], sourceEvidence("title", "title", opportunity.title, opportunity.title))] : []),
          ...(opportunity.location ? [jobEvidenceItem(opportunity.location, ["location_logistics"], sourceEvidence("location", "location", opportunity.location, opportunity.location))] : []),
          ...(opportunity.description ? [jobEvidenceItem(opportunity.description, ["experience"], sourceEvidence("description", "description", opportunity.description, opportunity.description))] : []),
        ];
        const jobEvidence: DeepMatchCandidate["jobEvidence"] = rawJobEvidence.filter((evidence) => evidence.value.length > 0).map((evidence, index) => ({ id: `job:${triage.sourcePostingVersionId}:${index + 1}`, ...evidence }));
        if (!jobEvidence.length) return null;
        const candidate = {
          opportunityId: opportunity.id, sourcePostingVersionId: triage.sourcePostingVersionId, triageVersionId: triage.id, profileId: triage.profileId, profileVersion: triage.profileVersion, targetVersion: triage.targetVersion, overallScore: triage.overallScore!, opportunitySnapshot: { company: opportunity.company, title: opportunity.title, location: opportunity.location },
          jobEvidence, profileEvidence,
        } satisfies SelectedDeepMatchCandidate;
        const adapterCandidate = {
          opportunityId: candidate.opportunityId,
          sourcePostingVersionId: candidate.sourcePostingVersionId,
          jobEvidence: candidate.jobEvidence,
          profileEvidence: candidate.profileEvidence,
        };
        return DeepMatchCandidateSchema.safeParse(adapterCandidate).success ? candidate : null;
      }));
      const candidates: SelectedDeepMatchCandidate[] = [];
      for (const [index, candidate] of evaluated.entries()) {
        const opportunityId = eligible[index]!.opportunity.id;
        if (!candidate) exclusions.push({ opportunityId, reasonCode: "MATCH_QUALITY_INSUFFICIENT" });
        else if (candidates.length < 10) candidates.push(candidate);
        else exclusions.push({ opportunityId, reasonCode: "CANDIDATE_LIMIT" });
      }
      return { candidates, exclusions: exclusions.sort((left, right) => left.opportunityId.localeCompare(right.opportunityId) || left.reasonCode.localeCompare(right.reasonCode)) };
    };
  return {
    selectCandidateSelection,
    async getLatestList(input: { userId: string; targetId: string }) { return readList({ ...input, exclusionLimit: 25 }); },
    async getFrozenCandidates(input: { userId: string; runId: string }): Promise<SelectedDeepMatchCandidate[]> {
      const rows = await deps.db.select({ candidateSnapshot: deepMatchRunCandidates.candidateSnapshot }).from(deepMatchRunCandidates)
        .where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId))).orderBy(deepMatchRunCandidates.ordinal);
      return rows.map((row) => row.candidateSnapshot as SelectedDeepMatchCandidate);
    },
    async hasStagedCandidate(input: { userId: string; runId: string; opportunityId: string }) {
      const [row] = await deps.db.select({ assessment: deepMatchRunCandidates.assessment, adapterUsage: deepMatchRunCandidates.adapterUsage }).from(deepMatchRunCandidates)
        .where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId), eq(deepMatchRunCandidates.opportunityId, input.opportunityId))).limit(1);
      return row?.assessment !== null && row?.assessment !== undefined && row.adapterUsage !== null && row.adapterUsage !== undefined;
    },
    async getListHistoryPage(input: { userId: string; targetId: string; cursor?: string | null; limit: number }) {
      const [cursor] = input.cursor ? await deps.db.select().from(recommendationLists).where(and(eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId), eq(recommendationLists.id, input.cursor))).limit(1) : [];
      if (input.cursor && !cursor) throw new Error("RECOMMENDATION_HISTORY_CURSOR_INVALID");
      const lists = await deps.db.select().from(recommendationLists).where(and(eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId),
        ...(cursor ? [or(
          lt(recommendationLists.createdAt, sql`(select ${recommendationLists.createdAt} from ${recommendationLists} where ${recommendationLists.id} = ${cursor.id}::uuid)`),
          and(eq(recommendationLists.createdAt, sql`(select ${recommendationLists.createdAt} from ${recommendationLists} where ${recommendationLists.id} = ${cursor.id}::uuid)`), or(lt(recommendationLists.sequence, cursor.sequence), and(eq(recommendationLists.sequence, cursor.sequence), lt(recommendationLists.id, cursor.id)))),
        )] : []),
      )).orderBy(desc(recommendationLists.createdAt), desc(recommendationLists.sequence), desc(recommendationLists.id)).limit(input.limit + 1);
      const page = lists.slice(0, input.limit);
      const items = await Promise.all(page.map(async (list) => {
        const details = await readList({ userId: input.userId, targetId: input.targetId, recommendationListId: list.id, includeExclusions: false });
        if (!details) throw new Error("RECOMMENDATION_HISTORY_VERSION_NOT_FOUND");
        return details;
      }));
      return { items, nextCursor: lists.length > input.limit ? page.at(-1)?.id ?? null : null };
    },
    async getListExclusionsPage(input: { userId: string; targetId: string; recommendationListId: string; cursor?: string | null; limit: number }) {
      const [list] = await deps.db.select({ id: recommendationLists.id }).from(recommendationLists).where(and(eq(recommendationLists.userId, input.userId), eq(recommendationLists.targetId, input.targetId), eq(recommendationLists.id, input.recommendationListId))).limit(1);
      if (!list) throw new Error("RECOMMENDATION_LIST_NOT_FOUND");
      const [cursor] = input.cursor ? await deps.db.select({ id: recommendationExclusions.id, createdAt: recommendationExclusions.createdAt }).from(recommendationExclusions)
        .where(and(eq(recommendationExclusions.userId, input.userId), eq(recommendationExclusions.recommendationListId, list.id), eq(recommendationExclusions.id, input.cursor))).limit(1) : [];
      if (input.cursor && !cursor) throw new Error("RECOMMENDATION_EXCLUSION_CURSOR_INVALID");
      const exclusions = await deps.db.select({ id: recommendationExclusions.id, opportunityId: recommendationExclusions.opportunityId, reasonCode: recommendationExclusions.reasonCode }).from(recommendationExclusions)
        .where(and(eq(recommendationExclusions.userId, input.userId), eq(recommendationExclusions.recommendationListId, list.id),
          ...(cursor ? [or(
            gt(recommendationExclusions.createdAt, sql`(select ${recommendationExclusions.createdAt} from ${recommendationExclusions} where ${recommendationExclusions.id} = ${cursor.id}::uuid)`),
            and(eq(recommendationExclusions.createdAt, sql`(select ${recommendationExclusions.createdAt} from ${recommendationExclusions} where ${recommendationExclusions.id} = ${cursor.id}::uuid)`), gt(recommendationExclusions.id, cursor.id)),
          )] : []),
        )).orderBy(asc(recommendationExclusions.createdAt), asc(recommendationExclusions.id)).limit(input.limit + 1);
      const page = exclusions.slice(0, input.limit);
      return { items: page.map(({ opportunityId, reasonCode }) => ({ opportunityId, reasonCode })), nextCursor: exclusions.length > input.limit ? page.at(-1)?.id ?? null : null };
    },
  };
}

export function createDeepMatchCommands(deps: { db: Database; id: () => string; clock: () => Date; adapter?: DeepMatchAdapter }) {
  const adapter = deps.adapter ?? new FakeDeepMatchAdapter();
  const assertCandidateTuple = async (transaction: any, input: { userId: string; targetId: string; candidate: SelectedDeepMatchCandidate }) => {
    const candidate = input.candidate;
    if (candidate.targetVersion === undefined || candidate.profileVersion === undefined || !candidate.triageVersionId || !candidate.sourcePostingVersionId) throw new Error("DEEP_MATCH_TUPLE_INVALID");
    const [bound] = await transaction.select({ id: jobTriageVersions.id }).from(jobTriageVersions)
      .innerJoin(jobOpportunitySources, and(eq(jobOpportunitySources.userId, jobTriageVersions.userId), eq(jobOpportunitySources.opportunityId, jobTriageVersions.opportunityId), eq(jobOpportunitySources.sourcePostingVersionId, jobTriageVersions.sourcePostingVersionId)))
      .where(and(
        eq(jobTriageVersions.userId, input.userId), eq(jobTriageVersions.id, candidate.triageVersionId), eq(jobTriageVersions.opportunityId, candidate.opportunityId),
        eq(jobTriageVersions.sourcePostingVersionId, candidate.sourcePostingVersionId), eq(jobTriageVersions.profileId, candidate.profileId),
        eq(jobTriageVersions.profileVersion, candidate.profileVersion), eq(jobTriageVersions.targetId, input.targetId), eq(jobTriageVersions.targetVersion, candidate.targetVersion),
      )).limit(1);
    if (!bound) throw new Error("DEEP_MATCH_TUPLE_INVALID");
    for (const evidence of candidate.profileEvidence) {
      if (evidence.kind === "profile_fact") {
        const [profileRevision] = await transaction.select({ id: profileFactRevisions.id }).from(profileFactRevisions)
          .innerJoin(profileFacts, and(eq(profileFacts.userId, profileFactRevisions.userId), eq(profileFacts.id, profileFactRevisions.profileFactId)))
          .where(and(eq(profileFactRevisions.userId, input.userId), eq(profileFactRevisions.id, evidence.profileFactRevisionId), eq(profileFacts.profileId, candidate.profileId), lte(profileFactRevisions.profileVersion, candidate.profileVersion))).limit(1);
        if (!profileRevision) throw new Error("DEEP_MATCH_TUPLE_INVALID");
      } else {
        const [targetRevision] = await transaction.select({ id: jobTargetRevisions.id }).from(jobTargetRevisions)
          .where(and(eq(jobTargetRevisions.userId, input.userId), eq(jobTargetRevisions.id, evidence.targetRevisionId), eq(jobTargetRevisions.targetId, input.targetId), eq(jobTargetRevisions.version, candidate.targetVersion))).limit(1);
        if (!targetRevision) throw new Error("DEEP_MATCH_TUPLE_INVALID");
      }
    }
  };
  return {
    async stageValidatedAssessment(input: { userId: string; runId: string; claimToken: string; candidate: SelectedDeepMatchCandidate; assessment: ReturnType<typeof DeepMatchAssessmentSchema.parse>; usage: ReturnType<typeof DeepMatchAdapterResultSchema.parse>["usage"] }) {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [run] = await transaction.select({ id: agentRuns.id, ruleVersion: agentRuns.ruleVersion }).from(agentRuns).where(and(
          eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"),
          eq(agentRuns.claimToken, input.claimToken), eq(agentRuns.controlState, "none"), gt(agentRuns.claimExpiresAt, deps.clock()),
        )).limit(1);
        if (!run) throw new DeepMatchClaimLostError();
        const [frozen] = await transaction.select({ candidateSnapshot: deepMatchRunCandidates.candidateSnapshot }).from(deepMatchRunCandidates)
          .where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId), eq(deepMatchRunCandidates.opportunityId, input.candidate.opportunityId))).limit(1);
        if (!frozen || JSON.stringify(frozen.candidateSnapshot) !== JSON.stringify(input.candidate)) throw new Error("DEEP_MATCH_STAGED_CANDIDATE_INVALID");
        assertStagedAssessment(input.candidate, input.assessment);
        const [row] = await transaction.update(deepMatchRunCandidates).set({ assessment: input.assessment, adapterUsage: input.usage })
          .where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId), eq(deepMatchRunCandidates.opportunityId, input.candidate.opportunityId), isNull(deepMatchRunCandidates.assessment))).returning();
        if (row) return row;
        const [existing] = await transaction.select().from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId), eq(deepMatchRunCandidates.opportunityId, input.candidate.opportunityId)));
        if (!existing?.assessment || !existing.adapterUsage) throw new Error("DEEP_MATCH_STAGE_MISSING");
        const existingAssessment = DeepMatchAssessmentSchema.parse(existing.assessment);
        if (existingAssessment.opportunityId !== input.candidate.opportunityId) throw new Error("DEEP_MATCH_STAGE_CONFLICT");
        return existing;
      });
    },
    async invokeAndValidate(input: { userId: string; runId: string; candidate: SelectedDeepMatchCandidate; modelCall: DeepMatchAdapterCall }) {
      const [existing] = await deps.db.select({ assessment: deepMatchRunCandidates.assessment, adapterUsage: deepMatchRunCandidates.adapterUsage })
        .from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId), eq(deepMatchRunCandidates.opportunityId, input.candidate.opportunityId))).limit(1);
      if (existing?.assessment && existing.adapterUsage) {
        const parsed = DeepMatchAdapterResultSchema.parse({ assessments: [existing.assessment], usage: existing.adapterUsage });
        return { assessment: parsed.assessments[0]!, usage: parsed.usage, reused: true };
      }
      let result: ReturnType<typeof DeepMatchAdapterResultSchema.parse>;
      let validated: ReturnType<typeof DeepMatchAssessmentSchema.parse>;
      try {
        const strictInput = DeepMatchAdapterInputSchema.parse({ candidates: [{ opportunityId: input.candidate.opportunityId, sourcePostingVersionId: input.candidate.sourcePostingVersionId, jobEvidence: input.candidate.jobEvidence, profileEvidence: input.candidate.profileEvidence }] });
        result = DeepMatchAdapterResultSchema.parse(await adapter.assess(strictInput, input.modelCall));
        const rawAssessment = result.assessments[0];
        if (!rawAssessment || result.assessments.length !== 1) throw new DeepMatchAdapterError("invalid_output");
        validated = validateDeepMatchEvidenceClosure(DeepMatchAssessmentSchema.parse(rawAssessment), { jobEvidence: input.candidate.jobEvidence, profileEvidence: input.candidate.profileEvidence });
        if (validated.opportunityId !== input.candidate.opportunityId) throw new DeepMatchAdapterError("invalid_output");
      } catch (error) {
        if (error instanceof DeepMatchAdapterError) throw error;
        throw new DeepMatchAdapterError("invalid_output");
      }
      const assessment = { ...validated, evidenceSnapshot: { jobEvidence: input.candidate.jobEvidence.map(({ id, value, provenance }) => ({ id, value, ...(provenance ? { provenance } : {}) })), profileEvidence: input.candidate.profileEvidence.map((evidence) => evidence.kind === "profile_fact" ? { id: evidence.id, value: evidence.value, kind: evidence.kind, profileFactRevisionId: evidence.profileFactRevisionId } : { id: evidence.id, value: evidence.value, kind: evidence.kind, targetRevisionId: evidence.targetRevisionId }) }, opportunitySnapshot: input.candidate.opportunitySnapshot };
      return { assessment, usage: result.usage, reused: false };
    },
    /** Publishes a fully staged matching run in one fenced transaction.  Staging is private;
     * no match version or recommendation list becomes visible before every candidate is ready. */
    async publishStagedRun(input: { userId: string; targetId: string; runId: string; fence: { claimToken: string }; selectionExclusions: readonly { opportunityId: string; reasonCode: RecommendationExclusionReason }[]; ruleConfig?: { minimumOverallScore: number; minimumEvidenceDimensions: number; requiredEvidenceDimensions: string[] }; onPublished?: (transaction: any, result: { resultCount: number }) => Promise<void> }) {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [run] = await transaction.select({ id: agentRuns.id, ruleVersion: agentRuns.ruleVersion }).from(agentRuns).where(and(
          eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"),
          eq(agentRuns.claimToken, input.fence.claimToken), eq(agentRuns.controlState, "none"), gt(agentRuns.claimExpiresAt, deps.clock()),
        )).limit(1);
        if (!run) throw new DeepMatchClaimLostError();
        const staged = await transaction.select().from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, input.runId))).orderBy(deepMatchRunCandidates.ordinal);
        if (staged.some((row) => row.assessment === null || row.adapterUsage === null)) throw new Error("DEEP_MATCH_STAGE_INCOMPLETE");
        const completed = staged.map((row) => {
          const candidate = row.candidateSnapshot as SelectedDeepMatchCandidate;
          const assessment = DeepMatchAssessmentSchema.parse(row.assessment);
          assertStagedAssessment(candidate, assessment);
          return { candidate, assessment };
        })
          .sort((left, right) => right.assessment.overallScore - left.assessment.overallScore || left.candidate.opportunityId.localeCompare(right.candidate.opportunityId));
        const matches: Array<{ id: string; opportunityId: string; overallScore: number; displayBand: ReturnType<typeof displayBand> }> = [];
        for (const entry of completed) {
          const candidate = entry.candidate;
          await assertCandidateTuple(transaction, { userId: input.userId, targetId: input.targetId, candidate });
          const [previous] = await transaction.select({ sequence: jobMatchVersions.sequence }).from(jobMatchVersions).where(and(eq(jobMatchVersions.userId, input.userId), eq(jobMatchVersions.opportunityId, candidate.opportunityId))).orderBy(desc(jobMatchVersions.sequence)).limit(1);
          const assessment = { ...entry.assessment, evidenceSnapshot: entry.assessment.evidenceSnapshot ?? { jobEvidence: candidate.jobEvidence.map(({ id, value, provenance }) => ({ id, value, ...(provenance ? { provenance } : {}) })), profileEvidence: candidate.profileEvidence.map((evidence) => evidence.kind === "profile_fact" ? { id: evidence.id, value: evidence.value, kind: evidence.kind, profileFactRevisionId: evidence.profileFactRevisionId } : { id: evidence.id, value: evidence.value, kind: evidence.kind, targetRevisionId: evidence.targetRevisionId }) }, opportunitySnapshot: entry.assessment.opportunitySnapshot ?? candidate.opportunitySnapshot };
          const [match] = await transaction.insert(jobMatchVersions).values({
            id: deps.id(), userId: input.userId, opportunityId: candidate.opportunityId, sourcePostingVersionId: candidate.sourcePostingVersionId, triageVersionId: candidate.triageVersionId,
            profileId: candidate.profileId, profileVersion: candidate.profileVersion, targetId: input.targetId, targetVersion: candidate.targetVersion,
            ruleVersion: run.ruleVersion, promptVersion: DEEP_MATCH_PROMPT_VERSION, adapter: adapter.adapter, adapterVersion: adapter.adapterVersion, model: adapter.model, outputSchemaVersion: DEEP_MATCH_OUTPUT_SCHEMA_VERSION,
            overallScore: assessment.overallScore, displayBand: displayBand(assessment), assessment, sequence: (previous?.sequence ?? 0) + 1, createdAt: deps.clock(),
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
          const evidenceCount = assessment.dimensions.filter((dimension) => dimension.judgment === "evidence_backed_inference").length;
          const config = input.ruleConfig;
          return acceptsDeepMatchAssessment(assessment) && (!config || (assessment.overallScore >= config.minimumOverallScore && evidenceCount >= config.minimumEvidenceDimensions && config.requiredEvidenceDimensions.every((dimension) => assessment.dimensions.some((item) => item.dimension === dimension && item.judgment === "evidence_backed_inference"))));
        });
        const exclusions = [...input.selectionExclusions, ...matches.filter((match) => !accepted.some((item) => item.id === match.id)).map((match) => ({ opportunityId: match.opportunityId, reasonCode: "MATCH_QUALITY_INSUFFICIENT" as const }))];
        if (exclusions.length) await transaction.insert(recommendationExclusions).values(exclusions.map((exclusion) => ({ id: deps.id(), userId: input.userId, targetId: input.targetId, opportunityId: exclusion.opportunityId, recommendationListId: list.id, reasonCode: exclusion.reasonCode, createdAt: deps.clock() })));
        if (accepted.length) await transaction.insert(recommendationListItems).values(accepted.map((match, index) => ({ id: deps.id(), userId: input.userId, recommendationListId: list.id, matchVersionId: match.id, ordinal: index + 1, highlighted: index < 3, createdAt: deps.clock() })));
        const result = { recommendationListId: list.id, items: accepted.map((match, index) => ({ matchVersionId: match.id, ordinal: index + 1, highlighted: index < 3 })) };
        await input.onPublished?.(transaction, { resultCount: result.items.length });
        return result;
      });
    },
  };
}

export type DeepMatchCommands = ReturnType<typeof createDeepMatchCommands>;
export type DeepMatchQueries = ReturnType<typeof createDeepMatchQueries>;
