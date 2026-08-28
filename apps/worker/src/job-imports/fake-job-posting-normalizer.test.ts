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
      description: "负责 Web 平台。  \n- 与产品团队协作",
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
      description: null,
    });
  });

  it("原样复制显式描述章节的内容", async () => {
    const output = await new FakeJobPostingNormalizer().normalize(
      "## 职位描述\n  保留缩进和尾随空格  \n\n最后一行  \n## 任职要求\n未知内容",
    );

    expect(output).toMatchObject({
      description: "  保留缩进和尾随空格  \n\n最后一行  ",
    });
  });

  it("仅将明确的 Fake 无效夹具返回为无效输出", async () => {
    await expect(new FakeJobPostingNormalizer().normalize(
      "<!-- job-copilot:fake-normalizer-invalid -->",
    )).resolves.toEqual({ invalid: "fake-fixture" });
  });
});
