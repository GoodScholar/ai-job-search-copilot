import { bindJobNormalizerOutput, validateJobNormalizerOutput, validatePersistedJobNormalizerOutput, type JobNormalizerOutput } from "./job-imports";

export const JOB_NORMALIZER_EVALUATION_VERSION = "job-normalizer-eval-v1";
export const JOB_NORMALIZER_EVALUATION_SOURCE_POSTING_VERSION_ID = "00000000-0000-4000-8000-000000000061";

const unknownQualifications = {
  workMode: null, relocationRequired: null, salary: null, seniority: null, education: null,
  languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: null,
};

export const JOB_NORMALIZER_EVALUATION_CASES = [
  {
    id: "case-1", content: "公司：示例科技\n标题：前端工程师\n地点：上海\n发布时间：2026-09-01T09:00:00.000Z\n截止时间：2026-10-01T09:00:00.000Z\n工作方式：远程\n薪资：CNY 30000-40000/month\n必备技能：TypeScript，React\n描述：负责 Web 应用开发。",
    expected: {
      company: "示例科技", title: "前端工程师", location: "上海", postedAt: "2026-09-01T09:00:00.000Z", deadline: "2026-10-01T09:00:00.000Z", description: "负责 Web 应用开发。",
      qualifications: { ...unknownQualifications, workMode: "remote", salary: { minimum: 30000, maximum: 40000, currency: "CNY", period: "month" }, requiredSkills: ["TypeScript", "React"] },
    },
  },
  {
    id: "case-2", content: "标题：AI 应用工程师\n描述：负责检索增强生成服务。",
    expected: { company: null, title: "AI 应用工程师", location: null, postedAt: null, deadline: null, description: "负责检索增强生成服务。", qualifications: unknownQualifications },
  },
  {
    id: "case-3", content: "示例科技正在上海招聘前端工程师。该岗位负责维护 Web 应用并与产品团队协作。",
    expected: { company: "示例科技", title: "前端工程师", location: "上海", postedAt: null, deadline: null, description: "该岗位负责维护 Web 应用并与产品团队协作。", qualifications: unknownQualifications },
  },
] as const;

export function assertJobNormalizerEvaluation(output: JobNormalizerOutput, content: string, latencyMs: number, timeoutMs = 25_000) {
  const fixture = JOB_NORMALIZER_EVALUATION_CASES.find((item) => item.content === content);
  if (!fixture || !Number.isSafeInteger(latencyMs) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || latencyMs < 0 || latencyMs > timeoutMs || output.usage.status !== "known" || !validateJobNormalizerOutput(content, output)) throw new Error("JOB_NORMALIZER_EVALUATION_ASSERTION_FAILED");
  for (const field of ["company", "title", "location", "postedAt", "deadline", "description"] as const) if (output[field] !== fixture.expected[field]) throw new Error("JOB_NORMALIZER_EVALUATION_ASSERTION_FAILED");
  for (const [field, value] of Object.entries(fixture.expected.qualifications)) {
    const actual = output.qualifications[field as keyof typeof output.qualifications];
    if (value === null ? actual !== null : actual === null || JSON.stringify(actual.value) !== JSON.stringify(value)) throw new Error("JOB_NORMALIZER_EVALUATION_ASSERTION_FAILED");
  }
  if (output.deadlineProvenance !== null || output.fieldEvidence.some((item) => "sourcePostingVersionId" in item)) throw new Error("JOB_NORMALIZER_EVALUATION_ASSERTION_FAILED");
  const bound = bindJobNormalizerOutput(JOB_NORMALIZER_EVALUATION_SOURCE_POSTING_VERSION_ID, output);
  validatePersistedJobNormalizerOutput(bound, { sourcePostingVersionId: JOB_NORMALIZER_EVALUATION_SOURCE_POSTING_VERSION_ID, metadata: output });
  return { evaluationVersion: JOB_NORMALIZER_EVALUATION_VERSION, caseId: fixture.id, evidencedFieldCount: output.fieldEvidence.length, qualificationEvidenceCount: Object.values(output.qualifications).filter(Boolean).length };
}
