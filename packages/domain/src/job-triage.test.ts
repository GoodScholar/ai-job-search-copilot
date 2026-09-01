import { describe, expect, it } from "vitest";
import type { JobTriageGate } from "@job-copilot/contracts/job-triage";
import type { JobTargetConstraints } from "@job-copilot/contracts/job-targets";
import { compareJobTriageRank, evaluateJobTriage } from "./job-triage";

const sourcePostingVersionId = "00000000-0000-4000-8000-000000000001";
type TriageInput = Parameters<typeof evaluateJobTriage>[0];
type Mutate = (input: TriageInput) => void;
const uuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const target = {
  targetId: "00000000-0000-4000-8000-000000000002", version: 1,
  constraints: {
    roleFamily: "frontend", seniority: "senior", locations: ["上海"], workModes: ["onsite"],
    relocation: "willing" as const, salary: { minimum: 30_000, maximum: null, currency: "CNY", period: "month" }, industries: [],
    dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
  },
} satisfies { targetId: string; version: number; constraints: JobTargetConstraints };

function allPassInput(): TriageInput {
  return {
    sourcePostingVersionId, now: new Date("2026-09-01T00:00:00.000Z"),
    target: { targetId: "00000000-0000-4000-8000-000000000002", version: 1, constraints: { ...target.constraints, locations: [...target.constraints.locations], workModes: [...target.constraints.workModes], salary: { ...target.constraints.salary! }, dealBreakers: { ...target.constraints.dealBreakers } } },
    job: { company: "示例", title: "frontend engineer", location: "上海", deadline: "2026-09-12T00:00:00.000Z", qualifications: {
      workMode: { value: "onsite", evidence: { field: "workMode", path: "工作方式", value: "现场" } },
      relocationRequired: { value: true, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "是" } },
      salary: { value: { minimum: 35_000, maximum: 40_000, currency: "CNY", period: "month" }, evidence: { field: "salary", path: "薪资", value: "3.5-4万" } },
      seniority: { value: "senior", evidence: { field: "seniority", path: "级别", value: "senior" } },
      education: { value: "本科", evidence: { field: "education", path: "学历", value: "本科" } },
      languages: { value: [{ name: "英语", level: "C1" }], evidence: { field: "languages", path: "语言", value: "英语(C1)" } },
      workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } },
      industry: null, employmentType: null, requiredSkills: null,
    } },
    facts: [
      { factId: "00000000-0000-4000-8000-000000000010", revisionId: "00000000-0000-4000-8000-000000000011", factType: "education", factValue: { summary: "本科" } },
      { factId: "00000000-0000-4000-8000-000000000012", revisionId: "00000000-0000-4000-8000-000000000013", factType: "language", factValue: { name: "英语", level: "C1" } },
      { factId: "00000000-0000-4000-8000-000000000014", revisionId: "00000000-0000-4000-8000-000000000015", factType: "work_eligibility", factValue: { summary: "中国工作许可" } },
    ],
  };
}

const gateMatrix: Array<{
  gate: JobTriageGate;
  missingJob: Mutate;
  insufficientCandidate?: Mutate;
  candidateState: "comparable evidence required" | "explicitly unrestricted";
  hardFail?: Mutate;
  failability: "structured conflict" | "not safely expressible";
}> = [
  { gate: "location", missingJob: (input) => { input.job.location = null; }, insufficientCandidate: (input) => { input.target.constraints.locations = []; }, candidateState: "comparable evidence required", hardFail: (input) => { input.job.location = "北京"; input.target.constraints.relocation = "not_willing"; }, failability: "structured conflict" },
  { gate: "work_mode", missingJob: (input) => { input.job.qualifications.workMode = null; }, insufficientCandidate: (input) => { input.target.constraints.workModes = []; }, candidateState: "comparable evidence required", hardFail: (input) => { input.job.qualifications.workMode = { value: "remote", evidence: { field: "workMode", path: "工作方式", value: "远程" } }; }, failability: "structured conflict" },
  { gate: "relocation", missingJob: (input) => { input.job.qualifications.relocationRequired = null; }, insufficientCandidate: (input) => { input.target.constraints.relocation = "unknown"; }, candidateState: "comparable evidence required", hardFail: (input) => { input.target.constraints.relocation = "not_willing"; }, failability: "structured conflict" },
  { gate: "salary", missingJob: (input) => { input.job.qualifications.salary = null; }, insufficientCandidate: (input) => { input.target.constraints.salary = { minimum: 30_000, maximum: null, currency: "USD", period: "month" }; }, candidateState: "comparable evidence required", hardFail: (input) => { input.job.qualifications.salary = { value: { minimum: 10_000, maximum: 20_000, currency: "CNY", period: "month" }, evidence: { field: "salary", path: "薪资", value: "1-2万" } }; }, failability: "structured conflict" },
  { gate: "seniority", missingJob: (input) => { input.job.qualifications.seniority = null; }, candidateState: "explicitly unrestricted", hardFail: (input) => { input.job.qualifications.seniority = { value: "junior", evidence: { field: "seniority", path: "级别", value: "junior" } }; }, failability: "structured conflict" },
  { gate: "education", missingJob: (input) => { input.job.qualifications.education = null; }, insufficientCandidate: (input) => { input.facts = input.facts.map((fact) => fact.factType === "education" ? { ...fact, factValue: { summary: "硕士" } } : fact); }, candidateState: "comparable evidence required", failability: "not safely expressible" },
  { gate: "language", missingJob: (input) => { input.job.qualifications.languages = null; }, insufficientCandidate: (input) => { input.facts = input.facts.map((fact) => fact.factType === "language" ? { ...fact, factValue: { name: "英语", level: "B1" } } : fact); }, candidateState: "comparable evidence required", failability: "not safely expressible" },
  { gate: "work_eligibility", missingJob: (input) => { input.job.qualifications.workEligibility = null; }, insufficientCandidate: (input) => { input.facts = input.facts.map((fact) => fact.factType === "work_eligibility" ? { ...fact, factValue: { summary: "美国工作许可" } } : fact); }, candidateState: "comparable evidence required", failability: "not safely expressible" },
  { gate: "deal_breakers", missingJob: (input) => { input.target.constraints.dealBreakers.excludedCompanies = ["示例"]; input.job.company = null; }, insufficientCandidate: (input) => { input.target.constraints.dealBreakers.other = ["不接受需轮班"]; }, candidateState: "comparable evidence required", hardFail: (input) => { input.target.constraints.dealBreakers.excludedCompanies = ["示例"]; }, failability: "structured conflict" },
];

describe("job triage gates", () => {
  it.each(gateMatrix)("$gate: independent complete evidence passes", ({ gate }) => {
    expect(evaluateJobTriage(allPassInput()).gateResults[gate]).toMatchObject({ verdict: "pass" });
  });

  it.each(gateMatrix)("$gate: missing job evidence is unknown, never a default pass or fail", ({ gate, missingJob }) => {
    const input = allPassInput();
    missingJob(input);
    expect(evaluateJobTriage(input).gateResults[gate]).toMatchObject({ verdict: "unknown" });
  });

  it.each(gateMatrix.filter((entry) => entry.insufficientCandidate))("$gate: missing or insufficient candidate evidence is unknown", ({ gate, insufficientCandidate }) => {
    const input = allPassInput();
    insufficientCandidate!(input);
    expect(evaluateJobTriage(input).gateResults[gate]).toMatchObject({ verdict: "unknown" });
  });

  it.each(gateMatrix.filter((entry) => entry.candidateState === "explicitly unrestricted"))(
    "$gate: null target constraint is an explicit unrestricted policy, not missing evidence",
    ({ gate }) => {
      const input = allPassInput();
      input.target.constraints.seniority = null;
      expect(evaluateJobTriage(input).gateResults[gate]).toMatchObject({ verdict: "pass", reasonCode: "SENIORITY_NOT_RESTRICTED" });
    },
  );

  it.each(gateMatrix.filter((entry) => entry.hardFail))("$gate: only structured explicit conflicts fail with both evidence sides", ({ gate, hardFail }) => {
    const input = allPassInput();
    hardFail!(input);
    const result = evaluateJobTriage(input);
    expect(result.gateResults[gate]).toMatchObject({ verdict: "fail", jobEvidence: expect.any(Object), candidateEvidence: expect.any(Object) });
    expect(result.overallVerdict).toBe("fail");
    expect(result.overallScore).toBeNull();
  });

  it.each(gateMatrix.filter((entry) => entry.failability === "not safely expressible"))(
    "$gate: missing or different facts cannot reach fail without inventing a negative parser",
    ({ gate, insufficientCandidate }) => {
      const input = allPassInput();
      insufficientCandidate!(input);
      expect(evaluateJobTriage(input).gateResults[gate]).toMatchObject({ verdict: "unknown" });
    },
  );

  it.each([
    ["company", (input: TriageInput) => { input.target.constraints.dealBreakers.excludedCompanies = ["示例"]; }],
    ["industry", (input: TriageInput) => { input.job.qualifications.industry = { value: "金融", evidence: { field: "industry", path: "行业", value: "金融" } }; input.target.constraints.dealBreakers.excludedIndustries = ["金融"]; }],
    ["employment type", (input: TriageInput) => { input.job.qualifications.employmentType = { value: "outsourcing", evidence: { field: "employmentType", path: "雇佣类型", value: "外包" } }; input.target.constraints.dealBreakers.excludeOutsourcing = true; }],
  ] as const)("deal breakers: structured %s conflict fails with both evidence sides", (_kind, mutate) => {
    const input = allPassInput();
    mutate(input);
    expect(evaluateJobTriage(input).gateResults.deal_breakers).toMatchObject({ verdict: "fail", jobEvidence: expect.any(Object), candidateEvidence: expect.any(Object) });
  });

  it("keeps invalid and missing deadlines pending, and uses the UTC seven-day boundary", () => {
    const missing = allPassInput();
    missing.job.deadline = null;
    expect(evaluateJobTriage(missing)).toMatchObject({ deadlineStatus: "missing", overallVerdict: "pass", overallScore: expect.any(Number) });
    const invalid = allPassInput();
    invalid.job.deadlineProvenance = { status: "invalid" };
    expect(evaluateJobTriage(invalid)).toMatchObject({ deadlineStatus: "invalid", overallScore: expect.any(Number) });
    const closingSoon = allPassInput();
    closingSoon.job.deadline = "2026-09-08T00:00:00.000Z";
    expect(evaluateJobTriage(closingSoon).deadlineStatus).toBe("closing_soon");
    const valid = allPassInput();
    valid.job.deadline = "2026-09-08T00:00:00.001Z";
    expect(evaluateJobTriage(valid).deadlineStatus).toBe("valid");
    for (const value of ["2026-02-31T00:00:00Z", "2026-09-01T24:00:00Z"]) {
      const malformed = allPassInput();
      malformed.job.deadline = value;
      expect(evaluateJobTriage(malformed)).toMatchObject({ deadlineStatus: "invalid", overallScore: expect.any(Number) });
    }
    for (const value of ["2026-08-31T23:59:59.999Z", "2026-09-01T00:00:00.000Z"]) {
      const expired = allPassInput();
      expired.job.deadline = value;
      expect(evaluateJobTriage(expired)).toMatchObject({ deadlineStatus: "expired", overallScore: null, dimensionScores: null });
    }
  });

  it("uses the matching language fact after non-matching facts and preserves exact target evidence", () => {
    const input = allPassInput();
    input.target.targetId = uuid(200);
    input.target.version = 7;
    input.facts.splice(1, 0, { factId: uuid(201), revisionId: uuid(202), factType: "language", factValue: { name: "法语", level: "C1" } });
    const result = evaluateJobTriage(input);
    expect(result.gateResults.language.candidateEvidence).toEqual({ kind: "profile_fact", factId: "00000000-0000-4000-8000-000000000012", revisionId: "00000000-0000-4000-8000-000000000013", label: "已确认画像", value: "英语" });
    expect(result.gateResults.location.candidateEvidence).toEqual({ kind: "target_constraint", targetId: uuid(200), version: 7, path: "locations", label: "求职目标条件", value: "上海" });
  });

  it.each([21, 100])("aggregates %i valid skill facts but projects at most twenty required-skill facts", (factCount) => {
    const input = allPassInput();
    const requiredSkills = Array.from({ length: 21 }, (_, index) => `技能${index + 1}`);
    input.job.qualifications.requiredSkills = { value: requiredSkills, evidence: { field: "requiredSkills", path: "必备技能", value: requiredSkills.join("、") } };
    input.facts.push(...Array.from({ length: factCount }, (_, index) => ({
      factId: uuid(300 + index * 2), revisionId: uuid(301 + index * 2), factType: "skill", factValue: { name: index < requiredSkills.length ? requiredSkills[index] : `无关技能${index + 1}` },
    })));
    const technical = evaluateJobTriage(input).dimensionScores!.technical;
    expect(technical).toMatchObject({ score: 100, missing: [] });
    expect(technical.candidateEvidence).toHaveLength(20);
    expect(technical.candidateEvidence.map((item) => item.value)).toEqual(requiredSkills.slice(0, 20));
    expect(technical.candidateEvidence.every((item) => requiredSkills.includes(item.value))).toBe(true);
  });

  it.each([21, 100])("keeps all %i unmatched required skills in scoring while projecting one bounded deterministic gap", (skillCount) => {
    const input = allPassInput();
    const requiredSkills = Array.from({ length: skillCount }, (_, index) => `缺失技能${index + 1}`);
    input.job.qualifications.requiredSkills = { value: requiredSkills, evidence: { field: "requiredSkills", path: "必备技能", value: requiredSkills.join("、") } };
    const result = evaluateJobTriage(input);
    expect(result.dimensionScores?.technical).toMatchObject({
      score: 50,
      missing: [{ kind: "profile_skills", count: skillCount, examples: requiredSkills.slice(0, 20) }],
    });
    expect(result.dimensionScores?.technical.missing).toHaveLength(1);
    expect(result.confidenceBasisPoints).toBe(0);
  });

  it("将合法最大目标列表和岗位标题摘要为可读、稳定且有界的证据", () => {
    const input = allPassInput();
    const values = (prefix: string) => Array.from({ length: 20 }, (_, index) => `${prefix}${index + 1}${"甲".repeat(195)}`);
    const locations = values("地点");
    const industries = values("行业");
    input.target.constraints.locations = locations;
    input.target.constraints.industries = industries;
    input.job.location = locations[0];
    input.job.title = `frontend ${"x".repeat(19_991)}`;
    input.job.qualifications.industry = { value: industries[0], evidence: { field: "industry", path: "行业", value: industries[0] } };

    const result = evaluateJobTriage(input);
    expect(result.gateResults.location.candidateEvidence?.value).toHaveLength(256);
    expect(result.dimensionScores?.targetAlignment.candidateEvidence.find((item) => item.kind === "target_constraint" && item.path === "industries")?.value).toHaveLength(256);
    expect(result.dimensionScores?.targetAlignment.jobEvidence.find((item) => item.field === "title")?.value).toHaveLength(512);
    expect(evaluateJobTriage(input).dimensionScores).toEqual(result.dimensionScores);

    input.target.constraints.dealBreakers.excludedCompanies = values("公司");
    input.job.company = input.target.constraints.dealBreakers.excludedCompanies[0];
    const dealBreaker = evaluateJobTriage(input).gateResults.deal_breakers;
    expect(dealBreaker.candidateEvidence?.value).toHaveLength(256);
    expect(dealBreaker.candidateEvidence?.value).not.toContain("targetId");
  });

  it("scores only an all-pass, non-expired opportunity and makes closing soon win score ties", () => {
    const result = evaluateJobTriage(allPassInput());
    expect(result).toMatchObject({ overallVerdict: "pass", deadlineStatus: "valid", threshold: 60, dimensionScores: { technical: { score: expect.any(Number), reasonCode: expect.any(String) }, experience: { score: 50, reasonCode: "EXPERIENCE_EVIDENCE_MISSING_NEUTRAL" }, targetAlignment: { score: expect.any(Number), reasonCode: expect.any(String) } } });
    const valid = { opportunityId: "b", sequence: 2, overallScore: 60, deadlineStatus: "valid" as const };
    const closing = { opportunityId: "a", sequence: 1, overallScore: 60, deadlineStatus: "closing_soon" as const };
    expect([valid, closing].sort(compareJobTriageRank)).toEqual([closing, valid]);
  });

  it("uses neutral coarse scores with missing evidence and rejects date-only deadlines", () => {
    const input = allPassInput();
    input.job.qualifications.requiredSkills = { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } };
    const scored = evaluateJobTriage(input);
    expect(scored.dimensionScores?.technical).toMatchObject({ score: 50, missing: [{ kind: "profile_skills", count: 1, examples: ["TypeScript"] }] });
    expect(scored.confidenceBasisPoints).toBeLessThan(10_000);
    const dateOnly = allPassInput();
    dateOnly.job.deadline = "2026-09-08";
    expect(evaluateJobTriage(dateOnly).deadlineStatus).toBe("invalid");
  });
});
