import type { JobTargetConstraints } from "@job-copilot/contracts/job-targets";
import type { JobQualifications } from "@job-copilot/contracts/job-imports";
import { JOB_TRIAGE_GATES, JOB_TRIAGE_MAX_CANDIDATE_EVIDENCE_VALUE_LENGTH, JOB_TRIAGE_MAX_EVIDENCE_ITEMS, JOB_TRIAGE_MAX_JOB_EVIDENCE_VALUE_LENGTH, type EvidenceGap, type JobTriageGate, type JobTriageReasonCode } from "@job-copilot/contracts/job-triage";

export const QUALIFICATION_RULE_VERSION = "qualification-gates-v1";
export const COARSE_RULE_VERSION = "coarse-ranking-v1";
export const COARSE_THRESHOLD = 60;

/** 粗排展示使用的稳定顺序：先总分，再优先临近截止，最后不可变机会/版本标识。 */
export function compareJobTriageRank(
  left: Pick<JobTriageResult, "overallScore" | "deadlineStatus"> & { opportunityId: string; sequence: number },
  right: Pick<JobTriageResult, "overallScore" | "deadlineStatus"> & { opportunityId: string; sequence: number },
): number {
  const score = (right.overallScore ?? -1) - (left.overallScore ?? -1);
  if (score) return score;
  const deadline = Number(right.deadlineStatus === "closing_soon") - Number(left.deadlineStatus === "closing_soon");
  if (deadline) return deadline;
  return left.opportunityId.localeCompare(right.opportunityId) || left.sequence - right.sequence;
}

type Gate = JobTriageGate;
type Verdict = "pass" | "fail" | "unknown";
type JobEvidence = { sourcePostingVersionId: string; field: string; path: string; value: string };
type TargetEvidence = { kind: "target_constraint"; targetId: string; version: number; path: string; label: string; value: string };
type FactEvidence = { kind: "profile_fact"; factId: string; revisionId: string; label: string; value: string };
type CandidateEvidence = TargetEvidence | FactEvidence;
type GateResult = { verdict: Verdict; reasonCode: JobTriageReasonCode; jobEvidence: JobEvidence | null; candidateEvidence: CandidateEvidence | null };
type Fact = { factId: string; revisionId: string; factType: string; factValue: { name?: string; summary?: string; level?: string }; state?: "active" | "removed" };
type QualificationInput = Partial<JobQualifications>;

export type JobTriageResult = {
  overallVerdict: Verdict;
  gateResults: Record<Gate, GateResult>;
  pendingItems: Array<{ gate: Gate; reasonCode: string; message: string }>;
  deadlineStatus: "expired" | "closing_soon" | "valid" | "missing" | "invalid";
  confidenceBasisPoints: number;
  dimensionScores: {
    technical: DimensionScore;
    experience: DimensionScore;
    targetAlignment: DimensionScore;
  } | null;
  overallScore: number | null;
  threshold: number | null;
};

type DimensionScore = { score: number; reasonCode: JobTriageReasonCode; jobEvidence: JobEvidence[]; candidateEvidence: CandidateEvidence[]; missing: EvidenceGap[] };
const gateNames = JOB_TRIAGE_GATES;
const normalized = (value: string) => value.trim().toLocaleLowerCase("en-US");
const summarizeEvidence = (value: string, maximum: number) => value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
const jobEvidenceValue = (value: string) => summarizeEvidence(value, JOB_TRIAGE_MAX_JOB_EVIDENCE_VALUE_LENGTH);
const candidateEvidenceValue = (value: string) => summarizeEvidence(value, JOB_TRIAGE_MAX_CANDIDATE_EVIDENCE_VALUE_LENGTH);
const directJobEvidence = (sourcePostingVersionId: string, field: string, path: string, value: string): JobEvidence => ({ sourcePostingVersionId, field, path, value: jobEvidenceValue(value) });
const evidence = (sourcePostingVersionId: string, field: string, input: { evidence: { path: string; value: string } }): JobEvidence => directJobEvidence(sourcePostingVersionId, field, input.evidence.path, input.evidence.value);
const unknown = (reasonCode: JobTriageReasonCode, jobEvidence: JobEvidence | null = null): GateResult => ({ verdict: "unknown", reasonCode, jobEvidence, candidateEvidence: null });
const pass = (reasonCode: JobTriageReasonCode, jobEvidence: JobEvidence | null = null, candidateEvidence: CandidateEvidence | null = null): GateResult => ({ verdict: "pass", reasonCode, jobEvidence, candidateEvidence });
const fail = (reasonCode: JobTriageReasonCode, jobEvidence: JobEvidence, candidateEvidence: CandidateEvidence): GateResult => ({ verdict: "fail", reasonCode, jobEvidence, candidateEvidence });

function activeFacts(facts: Fact[]) { return facts.filter((fact) => fact.state !== "removed"); }
function findFact(facts: Fact[], type: string, expected: string): Fact | undefined {
  const candidate = normalized(expected);
  return activeFacts(facts).find((fact) => fact.factType === type && [fact.factValue.name, fact.factValue.summary].some((value) => value && normalized(value) === candidate));
}
function factEvidence(fact: Fact): FactEvidence { return { kind: "profile_fact", factId: fact.factId, revisionId: fact.revisionId, label: "已确认画像", value: candidateEvidenceValue(fact.factValue.name ?? fact.factValue.summary ?? "已确认") }; }
function evidenceGapCount(gaps: EvidenceGap[]) { return gaps.reduce((total, gap) => total + (gap.kind === "profile_skills" ? gap.count : 1), 0); }

function deadlineStatus(deadline: string | null | undefined, now: Date, invalidProvenance?: unknown): JobTriageResult["deadlineStatus"] {
  if (invalidProvenance) return "invalid";
  if (deadline === null || deadline === undefined) return "missing";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(deadline)) return "invalid";
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return "invalid";
  if (date.toISOString().slice(0, 19) !== deadline.slice(0, 19)) return "invalid";
  if (date.getTime() <= now.getTime()) return "expired";
  return date.getTime() <= now.getTime() + 7 * 24 * 60 * 60 * 1000 ? "closing_soon" : "valid";
}

export function evaluateJobTriage(input: {
  sourcePostingVersionId: string; now: Date; target: { targetId: string; version: number; constraints: JobTargetConstraints };
  job: { company: string | null; location: string | null; title?: string | null; deadline: string | null; deadlineProvenance?: unknown; qualifications: QualificationInput };
  facts: Fact[];
}): JobTriageResult {
  const q = input.job.qualifications;
  const t = input.target.constraints;
  const targetEvidence = (path: string, value: string): TargetEvidence => ({ kind: "target_constraint", targetId: input.target.targetId, version: input.target.version, path, label: "求职目标条件", value: candidateEvidenceValue(value) });
  const results = {} as Record<Gate, GateResult>;

  const mode = q.workMode;
  if (!mode) results.work_mode = unknown("JOB_EVIDENCE_MISSING");
  else if (!t.workModes.length) results.work_mode = unknown("TARGET_CONSTRAINT_MISSING", evidence(input.sourcePostingVersionId, "workMode", mode));
  else if (!t.workModes.includes(mode.value)) results.work_mode = fail("WORK_MODE_CONFLICT", evidence(input.sourcePostingVersionId, "workMode", mode), targetEvidence("workModes", t.workModes.join("、")));
  else results.work_mode = pass("WORK_MODE_ALLOWED", evidence(input.sourcePostingVersionId, "workMode", mode), targetEvidence("workModes", t.workModes.join("、")));

  if (mode?.value === "remote") results.location = pass("REMOTE_LOCATION_COMPATIBLE", evidence(input.sourcePostingVersionId, "workMode", mode));
  else if (!input.job.location) results.location = unknown("JOB_EVIDENCE_MISSING");
  else if (!t.locations.length) results.location = unknown("TARGET_CONSTRAINT_MISSING");
  else if (t.locations.some((location) => normalized(location) === normalized(input.job.location!))) results.location = pass("LOCATION_ALLOWED", directJobEvidence(input.sourcePostingVersionId, "location", "location", input.job.location), targetEvidence("locations", t.locations.join("、")));
  else if (t.relocation === "not_willing") results.location = fail("LOCATION_CONFLICT", directJobEvidence(input.sourcePostingVersionId, "location", "location", input.job.location), targetEvidence("locations", t.locations.join("、")));
  else results.location = unknown("RELOCATION_CONFIRMATION_REQUIRED", directJobEvidence(input.sourcePostingVersionId, "location", "location", input.job.location));

  const relocation = q.relocationRequired;
  if (!relocation) results.relocation = unknown("JOB_EVIDENCE_MISSING");
  else if (!relocation.value) results.relocation = pass("RELOCATION_NOT_REQUIRED", evidence(input.sourcePostingVersionId, "relocationRequired", relocation));
  else if (t.relocation === "willing") results.relocation = pass("RELOCATION_WILLING", evidence(input.sourcePostingVersionId, "relocationRequired", relocation), targetEvidence("relocation", t.relocation));
  else if (t.relocation === "not_willing") results.relocation = fail("RELOCATION_CONFLICT", evidence(input.sourcePostingVersionId, "relocationRequired", relocation), targetEvidence("relocation", t.relocation));
  else results.relocation = unknown("RELOCATION_CONFIRMATION_REQUIRED", evidence(input.sourcePostingVersionId, "relocationRequired", relocation));

  const salary = q.salary;
  if (!t.salary?.minimum) results.salary = pass("SALARY_MINIMUM_NOT_SET");
  else if (!salary || salary.value.minimum === null && salary.value.maximum === null) results.salary = unknown("JOB_EVIDENCE_MISSING");
  else if (salary.value.currency !== t.salary.currency || salary.value.period !== t.salary.period) results.salary = unknown("SALARY_NOT_COMPARABLE", evidence(input.sourcePostingVersionId, "salary", salary));
  else if (salary.value.maximum !== null && salary.value.maximum < t.salary.minimum) results.salary = fail("SALARY_BELOW_MINIMUM", evidence(input.sourcePostingVersionId, "salary", salary), targetEvidence("salary.minimum", String(t.salary.minimum)));
  else if ((salary.value.minimum ?? salary.value.maximum ?? 0) >= t.salary.minimum) results.salary = pass("SALARY_COVERS_MINIMUM", evidence(input.sourcePostingVersionId, "salary", salary), targetEvidence("salary.minimum", String(t.salary.minimum)));
  else results.salary = unknown("SALARY_RANGE_INSUFFICIENT", evidence(input.sourcePostingVersionId, "salary", salary));

  const seniority = q.seniority;
  if (!t.seniority) results.seniority = pass("SENIORITY_NOT_RESTRICTED");
  else if (!seniority) results.seniority = unknown("JOB_EVIDENCE_MISSING");
  else if (normalized(seniority.value) === normalized(t.seniority)) results.seniority = pass("SENIORITY_MATCH", evidence(input.sourcePostingVersionId, "seniority", seniority), targetEvidence("seniority", t.seniority));
  else results.seniority = fail("SENIORITY_CONFLICT", evidence(input.sourcePostingVersionId, "seniority", seniority), targetEvidence("seniority", t.seniority));

  for (const [gate, field, type] of [["education", "education", "education"], ["work_eligibility", "workEligibility", "work_eligibility"]] as const) {
    const requirement = q[field];
    if (!requirement) results[gate] = unknown("JOB_EVIDENCE_MISSING");
    else {
      const matching = findFact(input.facts, type, requirement.value);
      const any = activeFacts(input.facts).find((fact) => fact.factType === type);
      // 画像中存在另一条事实并不等于它与岗位要求互斥（例如硕士满足本科）。
      // 在没有领域可证明的反证前保守待确认，绝不能把“未找到满足证据”降格为 hard fail。
      results[gate] = matching ? pass(`${gate.toUpperCase()}_MATCH`, evidence(input.sourcePostingVersionId, field, requirement), factEvidence(matching))
        : any ? unknown("CANDIDATE_EVIDENCE_INSUFFICIENT", evidence(input.sourcePostingVersionId, field, requirement))
          : unknown("CANDIDATE_EVIDENCE_MISSING", evidence(input.sourcePostingVersionId, field, requirement));
    }
  }

  const languages = q.languages;
  if (!languages) results.language = unknown("JOB_EVIDENCE_MISSING");
  else {
    const languageFacts = activeFacts(input.facts).filter((fact) => fact.factType === "language");
    const matchingFacts = languages.value.map((requirement) => languageFacts.find((fact) => normalized(fact.factValue.name ?? "") === normalized(requirement.name) && (!requirement.level || fact.factValue.level === requirement.level)));
    const missing = languages.value.find((_requirement, index) => !matchingFacts[index]);
    const named = missing && languageFacts.find((fact) => normalized(fact.factValue.name ?? "") === normalized(missing.name));
    results.language = !missing ? pass("LANGUAGE_MATCH", evidence(input.sourcePostingVersionId, "languages", languages), factEvidence(matchingFacts[0]!))
      : named && missing.level ? unknown("CANDIDATE_LEVEL_INSUFFICIENT", evidence(input.sourcePostingVersionId, "languages", languages))
        : unknown("CANDIDATE_EVIDENCE_MISSING", evidence(input.sourcePostingVersionId, "languages", languages));
  }

  const deal = q.employmentType;
  const breakerEnabled = t.dealBreakers.excludeOutsourcing || t.dealBreakers.excludeDispatch || t.dealBreakers.excludeHeadhunter || t.dealBreakers.excludedCompanies.length || t.dealBreakers.excludedIndustries.length || t.dealBreakers.other.length;
  const companyConflict = input.job.company && t.dealBreakers.excludedCompanies.some((company) => normalized(company) === normalized(input.job.company!));
  const industryConflict = q.industry && t.dealBreakers.excludedIndustries.some((industry) => normalized(industry) === normalized(q.industry!.value));
  const employmentConflict = deal && ((deal.value === "outsourcing" && t.dealBreakers.excludeOutsourcing) || (deal.value === "dispatch" && t.dealBreakers.excludeDispatch) || (deal.value === "headhunter" && t.dealBreakers.excludeHeadhunter));
  if (!breakerEnabled) results.deal_breakers = pass("DEAL_BREAKERS_NOT_ENABLED");
  else if (companyConflict) results.deal_breakers = fail("DEAL_BREAKER_COMPANY_CONFLICT", directJobEvidence(input.sourcePostingVersionId, "company", "company", input.job.company!), targetEvidence("dealBreakers.excludedCompanies", t.dealBreakers.excludedCompanies.join("、")));
  else if (industryConflict) results.deal_breakers = fail("DEAL_BREAKER_INDUSTRY_CONFLICT", evidence(input.sourcePostingVersionId, "industry", q.industry!), targetEvidence("dealBreakers.excludedIndustries", t.dealBreakers.excludedIndustries.join("、")));
  else if (employmentConflict) results.deal_breakers = fail("DEAL_BREAKER_MATCH", evidence(input.sourcePostingVersionId, "employmentType", deal!), targetEvidence("dealBreakers", deal!.value));
  else if (t.dealBreakers.other.length) results.deal_breakers = unknown("JOB_EVIDENCE_MISSING");
  else if ((t.dealBreakers.excludedCompanies.length && !input.job.company) || (t.dealBreakers.excludedIndustries.length && !q.industry) || ((t.dealBreakers.excludeOutsourcing || t.dealBreakers.excludeDispatch || t.dealBreakers.excludeHeadhunter) && !deal)) results.deal_breakers = unknown("JOB_EVIDENCE_MISSING");
  else results.deal_breakers = pass("DEAL_BREAKER_NOT_MATCHED", deal ? evidence(input.sourcePostingVersionId, "employmentType", deal) : null, targetEvidence("dealBreakers", "未命中"));

  const verdict: Verdict = gateNames.some((gate) => results[gate].verdict === "fail") ? "fail" : gateNames.some((gate) => results[gate].verdict === "unknown") ? "unknown" : "pass";
  const status = deadlineStatus(input.job.deadline, input.now, input.job.deadlineProvenance);
  const pendingItems = gateNames.filter((gate) => results[gate].verdict === "unknown").map((gate) => ({ gate, reasonCode: results[gate].reasonCode, message: "需要补充岗位或画像证据" }));
  if (status === "missing" || status === "invalid") pendingItems.push({ gate: "location", reasonCode: status === "missing" ? "DEADLINE_MISSING" : "DEADLINE_INVALID", message: "需要确认岗位截止时间" });
  let confidenceBasisPoints = Math.max(0, 10000 - pendingItems.length * 800 - (status === "invalid" ? 800 : 0));
  if (verdict !== "pass" || status === "expired") return { overallVerdict: verdict, gateResults: results, pendingItems, deadlineStatus: status, confidenceBasisPoints, dimensionScores: null, overallScore: null, threshold: null };
  const skills = q.requiredSkills?.value;
  const skillFacts = activeFacts(input.facts).filter((fact) => fact.factType === "skill").map((fact) => normalized(fact.factValue.name ?? ""));
  const technical: DimensionScore = !skills
    ? { score: 50, reasonCode: "REQUIRED_SKILLS_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: [{ kind: "job_requirements" }] }
    : !skillFacts.length
      ? { score: 50, reasonCode: "REQUIRED_SKILLS_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [evidence(input.sourcePostingVersionId, "requiredSkills", q.requiredSkills!)], candidateEvidence: [], missing: [{ kind: "profile_skills", count: skills.length, examples: skills.slice(0, JOB_TRIAGE_MAX_EVIDENCE_ITEMS) }] }
      : (() => {
        const missingSkills = skills.filter((skill) => !skillFacts.includes(normalized(skill)));
        return { score: Math.round(skills.reduce((total, skill) => total + (skillFacts.includes(normalized(skill)) ? 100 : 50), 0) / skills.length), reasonCode: "REQUIRED_SKILLS_COMPARED" as const, jobEvidence: [evidence(input.sourcePostingVersionId, "requiredSkills", q.requiredSkills!)], candidateEvidence: activeFacts(input.facts).filter((fact) => fact.factType === "skill" && skills.some((skill) => normalized(skill) === normalized(fact.factValue.name ?? ""))).map(factEvidence).slice(0, JOB_TRIAGE_MAX_EVIDENCE_ITEMS), missing: missingSkills.length ? [{ kind: "profile_skills" as const, count: missingSkills.length, examples: missingSkills.slice(0, JOB_TRIAGE_MAX_EVIDENCE_ITEMS) }] : [] };
      })();
  // 当前画像事实模型尚未提供可比较的年限字段；缺失时保持中性，不能伪造经验结论。
  const experience: DimensionScore = { score: 50, reasonCode: "EXPERIENCE_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: [{ kind: "profile_experience" }] };
  const alignmentJob = [q.seniority && evidence(input.sourcePostingVersionId, "seniority", q.seniority), q.industry && evidence(input.sourcePostingVersionId, "industry", q.industry), input.job.title && directJobEvidence(input.sourcePostingVersionId, "title", "title", input.job.title)].filter(Boolean) as JobEvidence[];
  const alignmentTarget = [t.seniority && targetEvidence("seniority", t.seniority), t.industries.length && targetEvidence("industries", t.industries.join("、")), t.roleFamily && targetEvidence("roleFamily", t.roleFamily)].filter(Boolean) as TargetEvidence[];
  const completeAlignment = alignmentJob.length === 3 && alignmentTarget.length === 3 && q.seniority?.value === t.seniority && q.industry && t.industries.some((industry) => normalized(industry) === normalized(q.industry!.value)) && input.job.title && normalized(input.job.title).includes(normalized(t.roleFamily));
  const targetAlignment: DimensionScore = completeAlignment
    ? { score: 100, reasonCode: "TARGET_ALIGNMENT_CONFIRMED", jobEvidence: alignmentJob, candidateEvidence: alignmentTarget, missing: [] }
    : { score: 50, reasonCode: alignmentJob.length || alignmentTarget.length ? "TARGET_ALIGNMENT_EVIDENCE_INCOMPLETE_NEUTRAL" : "TARGET_ALIGNMENT_EVIDENCE_MISSING_NEUTRAL", jobEvidence: alignmentJob, candidateEvidence: alignmentTarget, missing: [{ kind: "target_alignment" }] };
  confidenceBasisPoints = Math.max(0, confidenceBasisPoints - [technical, experience, targetAlignment].reduce((total, dimension) => total + evidenceGapCount(dimension.missing) * 500, 0));
  const overallScore = Math.round(technical.score * .35 + experience.score * .25 + targetAlignment.score * .4);
  return { overallVerdict: verdict, gateResults: results, pendingItems, deadlineStatus: status, confidenceBasisPoints, dimensionScores: { technical, experience, targetAlignment }, overallScore, threshold: COARSE_THRESHOLD };
}
