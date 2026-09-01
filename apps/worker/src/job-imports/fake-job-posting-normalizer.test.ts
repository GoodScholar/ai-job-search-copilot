import { describe, expect, it } from "vitest";
import { JobNormalizerOutputSchema } from "@job-copilot/contracts/job-imports";

import { FakeJobPostingNormalizer } from "./fake-job-posting-normalizer.js";

describe("FakeJobPostingNormalizer", () => {
  it("只从显式标题和标签提取岗位字段，并原样保留描述章节", async () => {
    const source = [
      "# 高级前端工程师",
      "公司：示例科技",
      "地点：上海",
      "发布时间：2026-08-01T09:00:00.000Z",
      "截止日期：2026-08-31T09:00:00.000Z",
      "工作方式：远程",
      "是否需要搬迁：否",
      "薪资：CNY 30000-45000/month",
      "雇佣类型：直接雇佣",
      "必备技能：TypeScript, React",
      "## 职位描述",
      "负责 Web 平台。  ",
      "- 与产品团队协作",
      "## 任职要求",
      "5 年经验",
    ].join("\n");

    const output = JobNormalizerOutputSchema.parse(
      await new FakeJobPostingNormalizer().normalize(source),
    );

    expect(output).toEqual({
      normalizerVersion: "fake-job-normalizer-v1",
      title: "高级前端工程师",
      company: "示例科技",
      location: "上海",
      postedAt: "2026-08-01T09:00:00.000Z",
      deadline: "2026-08-31T09:00:00.000Z",
      deadlineProvenance: null,
      description: "负责 Web 平台。  \n- 与产品团队协作",
      qualifications: {
        workMode: { value: "remote", evidence: { field: "workMode", path: "工作方式", value: "远程" } },
        relocationRequired: { value: false, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "否" } },
        salary: { value: { minimum: 30000, maximum: 45000, currency: "CNY", period: "month" }, evidence: { field: "salary", path: "薪资", value: "CNY 30000-45000/month" } },
        seniority: null, education: null, languages: null, workEligibility: null, industry: null,
        employmentType: { value: "direct", evidence: { field: "employmentType", path: "雇佣类型", value: "直接雇佣" } },
        requiredSkills: { value: ["TypeScript", "React"], evidence: { field: "requiredSkills", path: "必备技能", value: "TypeScript, React" } },
      },
    });
  });

  it("忽略未知字段和普通文本，缺失的已知字段保持 nullable", async () => {
    const output = JobNormalizerOutputSchema.parse(
      await new FakeJobPostingNormalizer().normalize("来源：不应解析\n普通正文\n级别：P8"),
    );

    expect(output).toEqual({
      normalizerVersion: "fake-job-normalizer-v1",
      company: null,
      title: null,
      location: null,
      postedAt: null,
      deadline: null,
      deadlineProvenance: null,
      description: null,
      qualifications: {
        workMode: null, relocationRequired: null, salary: null,
        seniority: { value: "P8", evidence: { field: "seniority", path: "级别", value: "P8" } }, education: null,
        languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: null,
      },
    });
  });

  it("将无法解析或无法 round-trip 的显式日期保留为 nullable", async () => {
    const output = JobNormalizerOutputSchema.parse(
      await new FakeJobPostingNormalizer().normalize("发布时间：2026-99-99T09:00:00.000Z\n截止日期：2026-08-01T09:00:00Z"),
    );

    expect(output).toMatchObject({
      postedAt: null, deadline: "2026-08-01T09:00:00.000Z", deadlineProvenance: null,
    });
  });

  it("默认把 failure fixture 当作普通未知正文", async () => {
    const output = JobNormalizerOutputSchema.parse(await new FakeJobPostingNormalizer().normalize(
      "<!-- job-copilot:fake-normalizer-invalid -->",
    ));

    expect(output).toMatchObject({ title: null, company: null, description: null });
  });

  it("仅在显式启用时将 failure fixture 返回为无效输出", async () => {
    await expect(new FakeJobPostingNormalizer({ enableFailureFixture: true }).normalize(
      "<!-- job-copilot:fake-normalizer-invalid -->",
    )).resolves.toEqual({ invalid: "fake-fixture" });
  });
});
