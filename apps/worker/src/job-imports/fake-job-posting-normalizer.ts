const INVALID_FIXTURE = "<!-- job-copilot:fake-normalizer-invalid -->";

type Field = "company" | "location" | "postedAt" | "deadline";

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

  async normalize(content: string): Promise<unknown> {
    if (this.options.enableFailureFixture && content.trim() === INVALID_FIXTURE) return { invalid: "fake-fixture" };
    if (this.options.testDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.testDelayMs));

    const output = {
      normalizerVersion: "fake-job-normalizer-v1",
      company: null as string | null,
      title: null as string | null,
      location: null as string | null,
      postedAt: null as string | null,
      deadline: null as string | null,
      description: null as string | null,
    };
    const lines = content.split(/\r\n|\r|\n/u);
    let descriptionStart: number | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const heading = line.match(headingPattern);
      if (heading) {
        const headingText = heading[2]!.replace(/\s+#+\s*$/u, "").trim();
        const lower = headingText.toLowerCase();
        if (heading[1]!.length === 1 && output.title === null && headingText) output.title = headingText;
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
      if (!field || !value || output[field] !== null) continue;
      output[field] = field === "postedAt" || field === "deadline" ? validIsoDateTime(value) : value;
    }

    if (descriptionStart !== undefined) {
      const section: string[] = [];
      for (let index = descriptionStart; index < lines.length; index += 1) {
        if (headingPattern.test(lines[index]!)) break;
        section.push(lines[index]!);
      }
      const copied = section.join("\n");
      output.description = copied.trim() ? copied : null;
    }
    return output;
  }
}

function validIsoDateTime(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const iso = `${value}T00:00:00.000Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) || date.toISOString() !== iso ? null : iso;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : value;
}
