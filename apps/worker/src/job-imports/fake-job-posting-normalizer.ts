import { FAKE_JOB_NORMALIZER_METADATA, JobNormalizerOutputSchema, validateJobNormalizerOutput } from "@job-copilot/contracts/job-imports";
import { JobNormalizerError, assertJobNormalizerInputBudget, isJobInstructionLike, knownJobNormalizerUsage, type JobNormalizerCallOptions } from "@job-copilot/contracts/job-normalizer";

const INVALID_FIXTURE = "<!-- job-copilot:fake-normalizer-invalid -->";

type Field = "company" | "location" | "postedAt" | "deadline" | "workMode" | "relocationRequired" | "salary" | "seniority" | "education" | "languages" | "workEligibility" | "industry" | "employmentType" | "requiredSkills";

const labels = new Map<string, Field>([
  ["公司", "company"],
  ["公司名称", "company"],
  ["company", "company"],
  ["地点", "location"],
  ["工作地点", "location"],
  ["location", "location"],
  ["发布时间", "postedAt"],
  ["发布日期", "postedAt"],
  ["posted at", "postedAt"],
  ["deadline", "deadline"],
  ["截止日期", "deadline"],
  ["申请截止", "deadline"],
  ["工作方式", "workMode"],
  ["work mode", "workMode"],
  ["是否需要搬迁", "relocationRequired"],
  ["需要搬迁", "relocationRequired"],
  ["relocation required", "relocationRequired"],
  ["薪资", "salary"],
  ["salary", "salary"],
  ["级别", "seniority"],
  ["seniority", "seniority"],
  ["学历", "education"],
  ["education", "education"],
  ["语言", "languages"],
  ["languages", "languages"],
  ["工作资格", "workEligibility"],
  ["work eligibility", "workEligibility"],
  ["行业", "industry"],
  ["industry", "industry"],
  ["雇佣类型", "employmentType"],
  ["employment type", "employmentType"],
  ["必备技能", "requiredSkills"],
  ["required skills", "requiredSkills"],
]);

const descriptionHeadings = new Set(["职位描述", "工作描述", "job description", "description"]);
const headingPattern = /^(#{1,6})\s+(.+?)\s*$/;
const labelPattern = /^\s*([^：:]+?)\s*[：:]\s*(.+?)\s*$/;

/**
 * 仅用于端到端失败路径的确定性夹具；普通未知正文不会触发它。
 */
export const FAKE_JOB_NORMALIZER_INVALID_FIXTURE = INVALID_FIXTURE;

export class FakeJobPostingNormalizer {
  constructor(private readonly options: { enableFailureFixture?: boolean; testDelayMs?: number } = {}) {}

  readonly metadata = FAKE_JOB_NORMALIZER_METADATA;

  async normalize(content: string, options: JobNormalizerCallOptions = {}): Promise<unknown> {
    const budget = assertJobNormalizerInputBudget(content, options);
    if (isJobInstructionLike(content)) throw new JobNormalizerError("JOB_NORMALIZER_INJECTION_DETECTED");
    await options.beforeRequest?.();
    await options.onUsage?.({ inputTokens: 0, outputTokens: 0 });
    if (this.options.enableFailureFixture && content.trim() === INVALID_FIXTURE) return { invalid: "fake-fixture" };
    if (this.options.testDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.testDelayMs));

    const output = {
      ...this.metadata,
      company: null as string | null,
      title: null as string | null,
      location: null as string | null,
      postedAt: null as string | null,
      deadline: null as string | null,
      deadlineProvenance: null as { field: "deadline"; path: string; value: string; status: "invalid" } | null,
      description: null as string | null,
      qualifications: {
        workMode: null, relocationRequired: null, salary: null, seniority: null, education: null,
        languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: null,
      },
      fieldEvidence: [] as Array<{ field: string; path: string; rawValue: string; normalizedValue: string }>,
    };
    const lines = content.split(/\r\n|\r|\n/u);
    let descriptionStart: number | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const heading = line.match(headingPattern);
      if (heading) {
        const headingText = heading[2]!.replace(/\s+#+\s*$/u, "").trim();
        const lower = headingText.toLowerCase();
        if (heading[1]!.length === 1 && output.title === null && headingText) {
          output.title = headingText;
          output.fieldEvidence.push({ field: "title", path: `lines:${index + 1}-${index + 1}`, rawValue: headingText, normalizedValue: headingText });
        }
        if (descriptionHeadings.has(lower)) {
          descriptionStart = index + 1;
          break;
        }
        continue;
      }

      const label = line.match(labelPattern);
      if (!label) continue;
      const field = labels.get(label[1]!.trim().toLowerCase());
      const value = label[2]!.trim();
      const path = `lines:${index + 1}-${index + 1}`;
      if (!field || !value) continue;
      if (field === "company" || field === "location" || field === "postedAt" || field === "deadline") {
        if (output[field] !== null) continue;
        if (field === "postedAt" || field === "deadline") {
          const parsed = validIsoDateTime(value);
          output[field] = parsed;
          if (parsed) output.fieldEvidence.push({ field, path, rawValue: value, normalizedValue: parsed });
          if (field === "deadline" && parsed === null) output.deadlineProvenance = { field: "deadline", path, value, status: "invalid" };
        } else {
          output[field] = value;
          output.fieldEvidence.push({ field, path, rawValue: value, normalizedValue: value });
        }
        continue;
      }
      if (output.qualifications[field] !== null) continue;
      const qualification = parseQualification(field, value);
      if (qualification !== null) output.qualifications[field] = { value: qualification, evidence: { field, path, value, rawValue: value, normalizedValue: typeof qualification === "string" ? qualification : JSON.stringify(qualification) } } as never;
    }

    if (descriptionStart !== undefined) {
      const section: string[] = [];
      for (let index = descriptionStart; index < lines.length; index += 1) {
        if (headingPattern.test(lines[index]!)) break;
        section.push(lines[index]!);
      }
      const copied = section.join("\n");
      output.description = copied.trim() ? copied : null;
      if (output.description) output.fieldEvidence.push({ field: "description", path: `lines:${descriptionStart + 1}-${descriptionStart + section.length}`, rawValue: output.description, normalizedValue: output.description });
    }
    const outputTokenBound = Math.ceil(new TextEncoder().encode(JSON.stringify(output)).byteLength / 4);
    if (outputTokenBound > budget.maxOutputTokens || budget.inputTokenBound + outputTokenBound > budget.maxTotalTokens) throw new JobNormalizerError("JOB_NORMALIZER_BUDGET_EXHAUSTED");
    const result = JobNormalizerOutputSchema.parse({ ...output, usage: knownJobNormalizerUsage(0, 0) });
    if (!validateJobNormalizerOutput(content, result)) throw new JobNormalizerError("JOB_NORMALIZER_EVIDENCE_INVALID");
    return result;
  }
}

function parseQualification(field: Exclude<Field, "company" | "location" | "postedAt" | "deadline">, value: string): unknown | null {
  if (field === "workMode") return ({ "现场": "onsite", "混合": "hybrid", "远程": "remote", onsite: "onsite", hybrid: "hybrid", remote: "remote" } as Record<string, string>)[value.toLowerCase()] ?? null;
  if (field === "relocationRequired") return ({ "是": true, "否": false, yes: true, no: false, true: true, false: false } as Record<string, boolean>)[value.toLowerCase()] ?? null;
  if (field === "salary") {
    const match = value.match(/^([A-Z]{3})\s+(\d+)(?:-(\d+))\/(month|year)$/u);
    if (!match) return null;
    return { minimum: Number(match[2]), maximum: match[3] ? Number(match[3]) : null, currency: match[1], period: match[4] };
  }
  if (field === "employmentType") return ({ "直接雇佣": "direct", "外包": "outsourcing", "派遣": "dispatch", "猎头": "headhunter", direct: "direct", outsourcing: "outsourcing", dispatch: "dispatch", headhunter: "headhunter" } as Record<string, string>)[value.toLowerCase()] ?? null;
  if (field === "requiredSkills") {
    const skills = value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
    return skills.length ? skills : null;
  }
  if (field === "languages") {
    const languages = value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean).map((item) => {
      const [name, level] = item.split(/\s*\(([^)]+)\)\s*/u);
      return { name: name!.trim(), level: level?.trim() || null };
    });
    return languages.length ? languages : null;
  }
  return value;
}

function validIsoDateTime(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const normalized = date.toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}
