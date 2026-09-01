import type { JobTargetConstraints } from "@job-copilot/contracts/job-targets";
import type { JobQualifications } from "@job-copilot/contracts/job-imports";

export const QUALIFICATION_RULE_VERSION = "qualification-gates-v1";
export const COARSE_RULE_VERSION = "coarse-ranking-v1";
export const COARSE_THRESHOLD = 60;

type Gate = "location" | "work_mode" | "relocation" | "salary" | "seniority" | "education" | "language" | "work_eligibility" | "deal_breakers";
type Verdict = "pass" | "fail" | "unknown";
type JobEvidence = { sourcePostingVersionId: string; field: string; path: string; value: string };
type TargetEvidence = { kind: "target_constraint"; targetId?: string; version?: number; path: string };
type FactEvidence = { kind: "profile_fact"; factId: string; revisionId: string };
type CandidateEvidence = TargetEvidence | FactEvidence;
type GateResult = { verdict: Verdict; reasonCode: string; jobEvidence: JobEvidence | null; candidateEvidence: CandidateEvidence | null };
type Fact = { factId: string; revisionId: string; factType: string; factValue: { name?: string; summary?: string; level?: string }; state?: "active" | "removed" };
type QualificationInput = Partial<JobQualifications>;

export type JobTriageResult = {
  overallVerdict: Verdict;
  gateResults: Record<Gate, GateResult>;
  pendingItems: Array<{ gate: Gate; reasonCode: string; message: string }>;
  deadlineStatus: "expired" | "closing_soon" | "valid" | "missing" | "invalid";
  confidenceBasisPoints: number;
  dimensionScores: {
    technical: { score: number; reasonCode: string };
    experience: { score: number; reasonCode: string };
    targetAlignment: { score: number; reasonCode: string };
  } | null;
  overallScore: number | null;
  threshold: number | null;
};

const gateNames: Gate[] = ["location", "work_mode", "relocation", "salary", "seniority", "education", "language", "work_eligibility", "deal_breakers"];
const normalized = (value: string) => value.trim().toLocaleLowerCase("en-US");
const evidence = (sourcePostingVersionId: string, field: string, input: { evidence: { path: string; value: string } }): JobEvidence => ({ sourcePostingVersionId, field, path: input.evidence.path, value: input.evidence.value });
const targetEvidence = (path: string): TargetEvidence => ({ kind: "target_constraint", path });
const unknown = (reasonCode: string, jobEvidence: JobEvidence | null = null): GateResult => ({ verdict: "unknown", reasonCode, jobEvidence, candidateEvidence: null });
const pass = (reasonCode: string, jobEvidence: JobEvidence | null = null, candidateEvidence: CandidateEvidence | null = null): GateResult => ({ verdict: "pass", reasonCode, jobEvidence, candidateEvidence });
const fail = (reasonCode: string, jobEvidence: JobEvidence, candidateEvidence: CandidateEvidence): GateResult => ({ verdict: "fail", reasonCode, jobEvidence, candidateEvidence });

function activeFacts(facts: Fact[]) { return facts.filter((fact) => fact.state !== "removed"); }
function findFact(facts: Fact[], type: string, expected: string): Fact | undefined {
  const candidate = normalized(expected);
  return activeFacts(facts).find((fact) => fact.factType === type && [fact.factValue.name, fact.factValue.summary].some((value) => value && normalized(value) === candidate));
}
function factEvidence(fact: Fact): FactEvidence { return { kind: "profile_fact", factId: fact.factId, revisionId: fact.revisionId }; }

function deadlineStatus(deadline: string | null | undefined, now: Date, invalidProvenance?: unknown): JobTriageResult["deadlineStatus"] {
  if (invalidProvenance) return "invalid";
  if (deadline === null || deadline === undefined) return "missing";
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== deadline) return "invalid";
  if (date.getTime() <= now.getTime()) return "expired";
  return date.getTime() <= now.getTime() + 7 * 24 * 60 * 60 * 1000 ? "closing_soon" : "valid";
}

export function evaluateJobTriage(input: {
  sourcePostingVersionId: string; now: Date; target: { targetId?: string; version?: number; constraints: JobTargetConstraints };
  job: { company: string | null; location: string | null; title?: string | null; deadline: string | null; deadlineProvenance?: unknown; qualifications: QualificationInput };
  facts: Fact[];
}): JobTriageResult {
  const q = input.job.qualifications;
  const t = input.target.constraints;
  const results = {} as Record<Gate, GateResult>;

  const mode = q.workMode;
  if (!mode) results.work_mode = unknown("JOB_EVIDENCE_MISSING");
  else if (!t.workModes.length) results.work_mode = unknown("TARGET_CONSTRAINT_MISSING", evidence(input.sourcePostingVersionId, "workMode", mode));
  else if (!t.workModes.includes(mode.value)) results.work_mode = fail("WORK_MODE_CONFLICT", evidence(input.sourcePostingVersionId, "workMode", mode), targetEvidence("workModes"));
  else results.work_mode = pass("WORK_MODE_ALLOWED", evidence(input.sourcePostingVersionId, "workMode", mode), targetEvidence("workModes"));

  if (mode?.value === "remote") results.location = pass("REMOTE_LOCATION_COMPATIBLE", evidence(input.sourcePostingVersionId, "workMode", mode));
  else if (!input.job.location) results.location = unknown("JOB_EVIDENCE_MISSING");
  else if (!t.locations.length) results.location = unknown("TARGET_CONSTRAINT_MISSING");
  else if (t.locations.some((location) => normalized(location) === normalized(input.job.location!))) results.location = pass("LOCATION_ALLOWED", { sourcePostingVersionId: input.sourcePostingVersionId, field: "location", path: "location", value: input.job.location }, targetEvidence("locations"));
  else if (t.relocation === "not_willing") results.location = fail("LOCATION_CONFLICT", { sourcePostingVersionId: input.sourcePostingVersionId, field: "location", path: "location", value: input.job.location }, targetEvidence("locations"));
  else results.location = unknown("RELOCATION_CONFIRMATION_REQUIRED", { sourcePostingVersionId: input.sourcePostingVersionId, field: "location", path: "location", value: input.job.location });

  const relocation = q.relocationRequired;
  if (!relocation) results.relocation = unknown("JOB_EVIDENCE_MISSING");
  else if (!relocation.value) results.relocation = pass("RELOCATION_NOT_REQUIRED", evidence(input.sourcePostingVersionId, "relocationRequired", relocation));
  else if (t.relocation === "willing") results.relocation = pass("RELOCATION_WILLING", evidence(input.sourcePostingVersionId, "relocationRequired", relocation), targetEvidence("relocation"));
  else if (t.relocation === "not_willing") results.relocation = fail("RELOCATION_CONFLICT", evidence(input.sourcePostingVersionId, "relocationRequired", relocation), targetEvidence("relocation"));
  else results.relocation = unknown("RELOCATION_CONFIRMATION_REQUIRED", evidence(input.sourcePostingVersionId, "relocationRequired", relocation));

  const salary = q.salary;
  if (!t.salary?.minimum) results.salary = pass("SALARY_MINIMUM_NOT_SET");
  else if (!salary || salary.value.minimum === null && salary.value.maximum === null) results.salary = unknown("JOB_EVIDENCE_MISSING");
  else if (salary.value.currency !== t.salary.currency || salary.value.period !== t.salary.period) results.salary = unknown("SALARY_NOT_COMPARABLE", evidence(input.sourcePostingVersionId, "salary", salary));
  else if (salary.value.maximum !== null && salary.value.maximum < t.salary.minimum) results.salary = fail("SALARY_BELOW_MINIMUM", evidence(input.sourcePostingVersionId, "salary", salary), targetEvidence("salary.minimum"));
  else if ((salary.value.minimum ?? salary.value.maximum ?? 0) >= t.salary.minimum) results.salary = pass("SALARY_COVERS_MINIMUM", evidence(input.sourcePostingVersionId, "salary", salary), targetEvidence("salary.minimum"));
  else results.salary = unknown("SALARY_RANGE_INSUFFICIENT", evidence(input.sourcePostingVersionId, "salary", salary));

  const seniority = q.seniority;
  if (!t.seniority) results.seniority = pass("SENIORITY_NOT_RESTRICTED");
  else if (!seniority) results.seniority = unknown("JOB_EVIDENCE_MISSING");
  else if (normalized(seniority.value) === normalized(t.seniority)) results.seniority = pass("SENIORITY_MATCH", evidence(input.sourcePostingVersionId, "seniority", seniority), targetEvidence("seniority"));
  else results.seniority = fail("SENIORITY_CONFLICT", evidence(input.sourcePostingVersionId, "seniority", seniority), targetEvidence("seniority"));

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
    const requirement = languages.value[0]!;
    const matching = activeFacts(input.facts).find((fact) => fact.factType === "language" && normalized(fact.factValue.name ?? "") === normalized(requirement.name) && (!requirement.level || fact.factValue.level === requirement.level));
    const named = activeFacts(input.facts).find((fact) => fact.factType === "language" && normalized(fact.factValue.name ?? "") === normalized(requirement.name));
    results.language = matching ? pass("LANGUAGE_MATCH", evidence(input.sourcePostingVersionId, "languages", languages), factEvidence(matching))
      : named && requirement.level ? unknown("CANDIDATE_LEVEL_INSUFFICIENT", evidence(input.sourcePostingVersionId, "languages", languages))
        : named ? fail("LANGUAGE_CONFLICT", evidence(input.sourcePostingVersionId, "languages", languages), factEvidence(named))
          : unknown("CANDIDATE_EVIDENCE_MISSING", evidence(input.sourcePostingVersionId, "languages", languages));
  }

  const deal = q.employmentType;
  if (t.dealBreakers.excludeOutsourcing || t.dealBreakers.excludeDispatch || t.dealBreakers.excludeHeadhunter) {
    if (!deal) results.deal_breakers = unknown("JOB_EVIDENCE_MISSING");
    else if ((deal.value === "outsourcing" && t.dealBreakers.excludeOutsourcing) || (deal.value === "dispatch" && t.dealBreakers.excludeDispatch) || (deal.value === "headhunter" && t.dealBreakers.excludeHeadhunter)) results.deal_breakers = fail("DEAL_BREAKER_MATCH", evidence(input.sourcePostingVersionId, "employmentType", deal), targetEvidence("dealBreakers"));
    else results.deal_breakers = pass("DEAL_BREAKER_NOT_MATCHED", evidence(input.sourcePostingVersionId, "employmentType", deal), targetEvidence("dealBreakers"));
  } else results.deal_breakers = pass("DEAL_BREAKERS_NOT_ENABLED");

  const verdict: Verdict = gateNames.some((gate) => results[gate].verdict === "fail") ? "fail" : gateNames.some((gate) => results[gate].verdict === "unknown") ? "unknown" : "pass";
  const status = deadlineStatus(input.job.deadline, input.now, input.job.deadlineProvenance);
  const pendingItems = gateNames.filter((gate) => results[gate].verdict === "unknown").map((gate) => ({ gate, reasonCode: results[gate].reasonCode, message: "需要补充岗位或画像证据" }));
  if (status === "missing" || status === "invalid") pendingItems.push({ gate: "location", reasonCode: status === "missing" ? "DEADLINE_MISSING" : "DEADLINE_INVALID", message: "需要确认岗位截止时间" });
  const confidenceBasisPoints = Math.max(0, 10000 - pendingItems.length * 800 - (status === "invalid" ? 800 : 0));
  if (verdict !== "pass" || status === "expired") return { overallVerdict: verdict, gateResults: results, pendingItems, deadlineStatus: status, confidenceBasisPoints, dimensionScores: null, overallScore: null, threshold: null };
  const skills = q.requiredSkills?.value;
  const skillFacts = activeFacts(input.facts).filter((fact) => fact.factType === "skill").map((fact) => normalized(fact.factValue.name ?? ""));
  const technical = skills
    ? { score: Math.round(100 * skills.filter((skill) => skillFacts.includes(normalized(skill))).length / skills.length), reasonCode: "REQUIRED_SKILLS_COMPARED" }
    : { score: 50, reasonCode: "REQUIRED_SKILLS_MISSING_NEUTRAL" };
  // 当前画像事实模型尚未提供可比较的年限字段；缺失时保持中性，不能伪造经验结论。
  const experience = { score: 50, reasonCode: "EXPERIENCE_EVIDENCE_MISSING_NEUTRAL" };
  const alignmentSignals = [
    q.seniority ? "SENIORITY_REQUIREMENT_PRESENT" : null,
    q.industry && t.industries.some((industry) => normalized(industry) === normalized(q.industry!.value)) ? "INDUSTRY_TARGET_MATCH" : null,
    input.job.title && normalized(input.job.title).includes(normalized(t.roleFamily)) ? "ROLE_FAMILY_TITLE_MATCH" : null,
  ].filter(Boolean);
  const targetAlignment = alignmentSignals.length
    ? { score: Math.round(alignmentSignals.length / 3 * 100), reasonCode: alignmentSignals.join("_") }
    : { score: 50, reasonCode: "TARGET_ALIGNMENT_EVIDENCE_MISSING_NEUTRAL" };
  const overallScore = Math.round(technical.score * .35 + experience.score * .25 + targetAlignment.score * .4);
  return { overallVerdict: verdict, gateResults: results, pendingItems, deadlineStatus: status, confidenceBasisPoints, dimensionScores: { technical, experience, targetAlignment }, overallScore, threshold: COARSE_THRESHOLD };
}
