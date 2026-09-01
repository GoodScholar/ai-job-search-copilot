import { describe, expect, it } from "vitest";
import type { JobTargetConstraints } from "@job-copilot/contracts/job-targets";
import { compareJobTriageRank, evaluateJobTriage } from "./job-triage";

const sourcePostingVersionId = "00000000-0000-4000-8000-000000000001";
const target = {
  constraints: {
    roleFamily: "frontend", seniority: "senior", locations: ["上海"], workModes: ["remote"],
    relocation: "not_willing" as const, salary: { minimum: 30000, maximum: null, currency: "CNY", period: "month" }, industries: [],
    dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
  },
} satisfies { constraints: JobTargetConstraints };

describe("job triage gates", () => {
  const allPassInput = (): Parameters<typeof evaluateJobTriage>[0] => ({
    sourcePostingVersionId, now: new Date("2026-09-01T00:00:00.000Z"),
    target: { constraints: { ...target.constraints, salary: null, relocation: "willing" as const, dealBreakers: { ...target.constraints.dealBreakers } } },
    job: { company: "示例", title: "frontend engineer", location: "上海", deadline: "2026-09-12T00:00:00.000Z", qualifications: {
      workMode: { value: "remote" as const, evidence: { field: "workMode", path: "工作方式", value: "远程" } },
      relocationRequired: { value: false, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "否" } }, salary: null,
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
  });

  it("emits an explicit result for all nine gates and never defaults missing requirements to pass", () => {
    const passing = evaluateJobTriage(allPassInput());
    expect(passing.overallVerdict).toBe("pass");
    expect(Object.values(passing.gateResults).every((gate) => gate.verdict === "pass")).toBe(true);

    const missingLanguage = allPassInput();
    missingLanguage.job.qualifications.languages = null;
    const unknownResult = evaluateJobTriage(missingLanguage);
    expect(unknownResult.gateResults.language).toMatchObject({ verdict: "unknown", reasonCode: "JOB_EVIDENCE_MISSING" });
    expect(unknownResult.overallVerdict).toBe("unknown");
  });

  it.each([
    ["location", (input: ReturnType<typeof allPassInput>) => { input.job.location = "北京"; input.job.qualifications.workMode = { value: "onsite", evidence: { field: "workMode", path: "工作方式", value: "现场" } }; input.target.constraints.workModes = ["onsite"]; input.target.constraints.relocation = "not_willing"; }, "location"],
    ["relocation", (input: ReturnType<typeof allPassInput>) => { input.job.qualifications.relocationRequired = { value: true, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "是" } }; input.target.constraints.relocation = "not_willing"; }, "relocation"],
    ["salary", (input: ReturnType<typeof allPassInput>) => { input.target.constraints.salary = { minimum: 30_000, maximum: null, currency: "CNY", period: "month" }; input.job.qualifications.salary = { value: { minimum: 10_000, maximum: 20_000, currency: "CNY", period: "month" }, evidence: { field: "salary", path: "薪资", value: "1-2万" } }; }, "salary"],
    ["seniority", (input: ReturnType<typeof allPassInput>) => { input.job.qualifications.seniority = { value: "junior", evidence: { field: "seniority", path: "级别", value: "junior" } }; }, "seniority"],
    ["deal breakers", (input: ReturnType<typeof allPassInput>) => { input.target.constraints.dealBreakers.excludeOutsourcing = true; input.job.qualifications.employmentType = { value: "outsourcing", evidence: { field: "employmentType", path: "雇佣类型", value: "外包" } }; }, "deal_breakers"],
  ] as const)("requires both sides' evidence for %s hard failure", (_name, mutate, gate) => {
    const input = allPassInput();
    mutate(input);
    const result = evaluateJobTriage(input);
    expect(result.overallVerdict).toBe("fail");
    expect(result.gateResults[gate]).toMatchObject({ verdict: "fail", jobEvidence: expect.any(Object), candidateEvidence: expect.any(Object) });
    expect(result.overallScore).toBeNull();
  });

  it("keeps invalid and missing deadlines pending, and uses the UTC seven-day boundary", () => {
    const missing = evaluateJobTriage({ ...allPassInput(), job: { ...allPassInput().job, deadline: null } });
    expect(missing).toMatchObject({ deadlineStatus: "missing", overallVerdict: "pass", overallScore: expect.any(Number) });
    expect(missing.pendingItems).toContainEqual(expect.objectContaining({ reasonCode: "DEADLINE_MISSING" }));

    const invalidInput = allPassInput();
    invalidInput.job.deadlineProvenance = { status: "invalid" };
    const invalid = evaluateJobTriage(invalidInput);
    expect(invalid).toMatchObject({ deadlineStatus: "invalid", overallScore: expect.any(Number) });
    expect(invalid.pendingItems).toContainEqual(expect.objectContaining({ reasonCode: "DEADLINE_INVALID" }));

    const closingSoon = allPassInput();
    closingSoon.job.deadline = "2026-09-08T00:00:00.000Z";
    expect(evaluateJobTriage(closingSoon).deadlineStatus).toBe("closing_soon");
    const valid = allPassInput();
    valid.job.deadline = "2026-09-08T00:00:00.001Z";
    expect(evaluateJobTriage(valid).deadlineStatus).toBe("valid");
  });
  it("requires explicit evidence on both sides before returning a hard failure", () => {
    const result = evaluateJobTriage({
      sourcePostingVersionId, now: new Date("2026-09-01T00:00:00.000Z"), target,
      job: { company: "示例", location: "上海", deadline: null, qualifications: {
        workMode: { value: "onsite", evidence: { field: "workMode", path: "工作方式", value: "现场" } },
        relocationRequired: { value: true, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "是" } },
      } },
      facts: [],
    });
    expect(result.overallVerdict).toBe("fail");
    expect(result.gateResults.work_mode).toMatchObject({ verdict: "fail", jobEvidence: { sourcePostingVersionId }, candidateEvidence: { kind: "target_constraint", path: "workModes" } });
    expect(result.dimensionScores).toBeNull();
  });

  it("returns unknown and pending when an explicit job requirement lacks confirmed candidate evidence", () => {
    const result = evaluateJobTriage({
      sourcePostingVersionId, now: new Date("2026-09-01T00:00:00.000Z"), target,
      job: { company: "示例", location: "上海", deadline: null, qualifications: { workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } } } },
      facts: [],
    });
    expect(result.overallVerdict).toBe("unknown");
    expect(result.gateResults.work_eligibility).toMatchObject({ verdict: "unknown", reasonCode: "CANDIDATE_EVIDENCE_MISSING" });
    expect(result.pendingItems).toContainEqual(expect.objectContaining({ gate: "work_eligibility" }));
    expect(result.dimensionScores).toBeNull();
  });

  it.each([
    ["education", { education: { value: "本科", evidence: { field: "education", path: "学历", value: "本科" } } }, { factType: "education", factValue: { summary: "硕士" } }],
    ["work eligibility", { workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } } }, { factType: "work_eligibility", factValue: { summary: "美国工作许可" } }],
  ])("does not turn an unproven %s difference into a hard failure", (_name, qualifications, fact) => {
    const result = evaluateJobTriage({
      sourcePostingVersionId, now: new Date("2026-09-01T00:00:00.000Z"), target,
      job: { company: "示例", location: "上海", deadline: null, qualifications },
      facts: [{ factId: "00000000-0000-4000-8000-000000000021", revisionId: "00000000-0000-4000-8000-000000000022", ...fact }],
    });
    const gate = fact.factType === "education" ? "education" : "work_eligibility";
    expect(result.gateResults[gate]).toMatchObject({ verdict: "unknown", reasonCode: "CANDIDATE_EVIDENCE_INSUFFICIENT" });
  });

  it("scores only an all-pass, non-expired opportunity and makes closing soon win score ties", () => {
    const result = evaluateJobTriage({
      sourcePostingVersionId, now: new Date("2026-09-01T00:00:00.000Z"), target: { constraints: { ...target.constraints, salary: null, relocation: "willing" } },
      job: { company: "示例", location: "上海", deadline: "2026-09-08T00:00:00.000Z", qualifications: {
        workMode: { value: "remote", evidence: { field: "workMode", path: "工作方式", value: "远程" } },
        relocationRequired: { value: false, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "否" } },
        seniority: { value: "senior", evidence: { field: "seniority", path: "级别", value: "senior" } },
        education: { value: "本科", evidence: { field: "education", path: "学历", value: "本科" } },
        languages: { value: [{ name: "英语", level: "C1" }], evidence: { field: "languages", path: "语言", value: "英语(C1)" } },
        workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } },
      } }, facts: [
        { factId: "00000000-0000-4000-8000-000000000010", revisionId: "00000000-0000-4000-8000-000000000011", factType: "education", factValue: { summary: "本科" } },
        { factId: "00000000-0000-4000-8000-000000000012", revisionId: "00000000-0000-4000-8000-000000000013", factType: "language", factValue: { name: "英语", level: "C1" } },
        { factId: "00000000-0000-4000-8000-000000000014", revisionId: "00000000-0000-4000-8000-000000000015", factType: "work_eligibility", factValue: { summary: "中国工作许可" } },
      ],
    });
    expect(result).toMatchObject({
      overallVerdict: "pass", deadlineStatus: "closing_soon", threshold: 60,
      dimensionScores: {
        technical: { score: expect.any(Number), reasonCode: expect.any(String) },
        experience: { score: 50, reasonCode: "EXPERIENCE_EVIDENCE_MISSING_NEUTRAL" },
        targetAlignment: { score: expect.any(Number), reasonCode: expect.any(String) },
      },
    });
  });

  it("requires every stated language and evaluates structured company deal breakers", () => {
    const input = allPassInput();
    input.job.qualifications.languages = { value: [{ name: "英语", level: "C1" }, { name: "日语", level: "N2" }], evidence: { field: "languages", path: "语言", value: "英语 C1；日语 N2" } };
    expect(evaluateJobTriage(input).gateResults.language).toMatchObject({ verdict: "unknown", reasonCode: "CANDIDATE_EVIDENCE_MISSING" });

    const excluded = allPassInput();
    excluded.target.constraints.dealBreakers.excludedCompanies = ["示例"];
    expect(evaluateJobTriage(excluded).gateResults.deal_breakers).toMatchObject({ verdict: "fail", reasonCode: "DEAL_BREAKER_COMPANY_CONFLICT", jobEvidence: expect.any(Object), candidateEvidence: expect.any(Object) });
  });

  it("uses neutral coarse scores with missing evidence and rejects date-only deadlines", () => {
    const input = allPassInput();
    input.job.qualifications.requiredSkills = { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } };
    const scored = evaluateJobTriage(input);
    expect(scored.dimensionScores?.technical).toMatchObject({ score: 50, missing: ["profile.skills"] });
    expect(scored.confidenceBasisPoints).toBeLessThan(10_000);
    const dateOnly = allPassInput(); dateOnly.job.deadline = "2026-09-08";
    expect(evaluateJobTriage(dateOnly).deadlineStatus).toBe("invalid");
  });

  it("orders score ties by closing-soon status and then a stable immutable key", () => {
    const valid = { opportunityId: "b", sequence: 2, overallScore: 60, deadlineStatus: "valid" as const };
    const closing = { opportunityId: "a", sequence: 1, overallScore: 60, deadlineStatus: "closing_soon" as const };
    expect([valid, closing].sort(compareJobTriageRank)).toEqual([closing, valid]);
    expect(compareJobTriageRank({ ...valid, opportunityId: "a", sequence: 2 }, { ...valid, opportunityId: "a", sequence: 1 })).toBe(1);
  });
});
