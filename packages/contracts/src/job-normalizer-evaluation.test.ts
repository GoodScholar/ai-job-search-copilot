import { describe, expect, it } from "vitest";
import { JobNormalizerOutputSchema } from "./job-imports";
import { assertJobNormalizerEvaluation, JOB_NORMALIZER_EVALUATION_CASES } from "./job-normalizer-evaluation";

function validCaseTwo() {
  return JobNormalizerOutputSchema.parse({
    normalizerVersion: "eval", adapter: "openai", model: "eval", promptVersion: "eval", outputSchemaVersion: "eval", ruleVersion: "eval",
    company: null, title: "AI 应用工程师", location: null, postedAt: null, deadline: null, deadlineProvenance: null, description: "负责检索增强生成服务。",
    qualifications: { workMode: null, relocationRequired: null, salary: null, seniority: null, education: null, languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: null },
    fieldEvidence: [{ field: "title", path: "lines:1-1", rawValue: "AI 应用工程师", normalizedValue: "AI 应用工程师" }, { field: "description", path: "lines:2-2", rawValue: "负责检索增强生成服务。", normalizedValue: "负责检索增强生成服务。" }],
    usage: { status: "known", inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
}

describe("岗位规范化显式评测", () => {
  it("拒绝正常样例中被补出的公司和非 known 用量", () => {
    const fixture = JOB_NORMALIZER_EVALUATION_CASES[1]!;
    const output = validCaseTwo();
    expect(assertJobNormalizerEvaluation(output, fixture.content, 1)).toMatchObject({ caseId: "case-2" });
    const titleEvidence = output.fieldEvidence[0]!;
    for (const invalid of [
      { ...output, company: "编造公司", fieldEvidence: [{ field: "company", path: "lines:1-1", rawValue: "标题", normalizedValue: "编造公司" }, ...output.fieldEvidence] },
      { ...output, fieldEvidence: output.fieldEvidence.filter((item) => item.field !== "description") },
      { ...output, fieldEvidence: [{ ...titleEvidence, normalizedValue: "编造" }, output.fieldEvidence[1]!] },
      { ...output, fieldEvidence: [{ ...titleEvidence, path: "lines:2-2" }, output.fieldEvidence[1]!] },
      { ...output, usage: { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null } },
      { ...output, fieldEvidence: [{ ...titleEvidence, sourcePostingVersionId: "00000000-0000-4000-8000-000000000062" } as any, output.fieldEvidence[1]!] },
    ]) expect(() => assertJobNormalizerEvaluation(invalid as typeof output, fixture.content, 1)).toThrow("JOB_NORMALIZER_EVALUATION_ASSERTION_FAILED");
  });
});
