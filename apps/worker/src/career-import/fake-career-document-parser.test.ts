import { CareerParserOutputSchema } from "@job-copilot/contracts/career-import";
import { describe, expect, it } from "vitest";

import { FakeCareerDocumentParser } from "./fake-career-document-parser.js";

describe("FakeCareerDocumentParser", () => {
  it("extracts only supported quoted facts with exact lines", async () => {
    const resume = [
      "# 张三",
      "邮箱：secret@example.test",
      "## 工作经历",
      "- AI 应用工程师｜示例科技｜2024-至今",
      "## 技能",
      "- TypeScript",
      "- React",
      "## 教育经历",
      "- 示例大学｜计算机科学｜2020",
      "## 项目经历",
      "- Job Copilot：构建证据驱动的求职工作流",
      "## 语言",
      "- 英语：专业工作水平",
      "## 成果",
      "- 将解析耗时降低 35%",
      "## 联系方式",
      "- 电话：13800000000",
    ].join("\n");

    const output = CareerParserOutputSchema.parse(
      await new FakeCareerDocumentParser().parse(resume),
    );

    expect(output.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        factType: "skill",
        factValue: { name: "TypeScript" },
        confidenceBasisPoints: 10_000,
        grounding: "quoted",
        evidence: expect.objectContaining({
          startLine: 6,
          endLine: 6,
          excerpt: "- TypeScript",
        }),
      }),
      expect.objectContaining({
        factType: "language",
        factValue: { name: "英语", level: "专业工作水平" },
        evidence: expect.objectContaining({ startLine: 13 }),
      }),
      expect.objectContaining({
        factType: "achievement",
        factValue: { summary: "将解析耗时降低 35%" },
        evidence: expect.objectContaining({ startLine: 15 }),
      }),
    ]));
    expect(JSON.stringify(output)).not.toContain("secret@example.test");
    expect(JSON.stringify(output)).not.toContain("13800000000");
  });

  it("ignores unsupported sections, paragraphs, contact details, and empty list items", async () => {
    const markdown = [
      "## 技能",
      "- TypeScript",
      "熟悉前端工程化。",
      "- ",
      "## 兴趣",
      "- 徒步",
      "## 联系方式",
      "- email@example.test",
    ].join("\n");

    const output = CareerParserOutputSchema.parse(
      await new FakeCareerDocumentParser().parse(markdown),
    );

    expect(output.facts).toEqual([
      expect.objectContaining({
        factType: "skill",
        factValue: { name: "TypeScript" },
      }),
    ]);
    expect(Object.keys(output).sort()).toEqual([
      "adapter",
      "facts",
      "outputSchemaVersion",
      "parserVersion",
      "promptVersion",
    ]);
    expect(Object.keys(output.facts[0]).sort()).toEqual([
      "confidenceBasisPoints",
      "evidence",
      "factType",
      "factValue",
      "grounding",
    ]);
  });

  it("recognizes Chinese and English section aliases", async () => {
    const markdown = [
      "## Skills",
      "- React",
      "## 证书",
      "- AWS Certified Developer",
      "## Languages",
      "- English: Professional working proficiency",
    ].join("\n");

    const output = CareerParserOutputSchema.parse(
      await new FakeCareerDocumentParser().parse(markdown),
    );

    expect(output.facts.map(({ factType, factValue }) => ({ factType, factValue }))).toEqual([
      { factType: "skill", factValue: { name: "React" } },
      { factType: "certification", factValue: { name: "AWS Certified Developer" } },
      {
        factType: "language",
        factValue: { name: "English", level: "Professional working proficiency" },
      },
    ]);
  });

  it("normalizes CRLF and CR before assigning evidence line numbers", async () => {
    const markdown = "## 技能\r\n- TypeScript\r## 成果\r\n- 将构建耗时降低 35%";

    const output = CareerParserOutputSchema.parse(
      await new FakeCareerDocumentParser().parse(markdown),
    );

    expect(output.facts).toEqual([
      expect.objectContaining({
        factType: "skill",
        evidence: expect.objectContaining({ startLine: 2, endLine: 2, excerpt: "- TypeScript" }),
      }),
      expect.objectContaining({
        factType: "achievement",
        evidence: expect.objectContaining({ startLine: 4, endLine: 4, excerpt: "- 将构建耗时降低 35%" }),
      }),
    ]);
  });

  it("extracts supported list markers and deeper headings as quoted facts", async () => {
    const markdown = [
      "## Skills",
      "* TypeScript",
      "+ React",
      "1. Node.js",
      "2) PostgreSQL",
      "## 项目经历",
      "### Job Copilot",
    ].join("\n");

    const output = CareerParserOutputSchema.parse(
      await new FakeCareerDocumentParser().parse(markdown),
    );

    expect(output.facts.map(({ factType, factValue }) => ({ factType, factValue }))).toEqual([
      { factType: "skill", factValue: { name: "TypeScript" } },
      { factType: "skill", factValue: { name: "React" } },
      { factType: "skill", factValue: { name: "Node.js" } },
      { factType: "skill", factValue: { name: "PostgreSQL" } },
      { factType: "project", factValue: { summary: "Job Copilot" } },
    ]);
  });

  it("returns a schema-valid empty fact list when no supported facts exist", async () => {
    const output = CareerParserOutputSchema.parse(
      await new FakeCareerDocumentParser().parse("# 张三\n这是普通段落。\n## 联系方式\n- 13800000000"),
    );

    expect(output.facts).toEqual([]);
  });
});
