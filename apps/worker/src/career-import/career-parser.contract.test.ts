import { describe, expect, it } from "vitest";
import { CareerParserOutputSchema } from "@job-copilot/contracts/career-import";
import { createOpenAiCareerParser } from "@job-copilot/model-access";
import { FakeCareerDocumentParser } from "./fake-career-document-parser.js";

const markdown = "## 技能\n- TypeScript";
const openAi = () => createOpenAiCareerParser({ apiKey: "test-key" }, async () => new Response(JSON.stringify({
  status: "completed", usage: { input_tokens: 30, output_tokens: 20 },
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ facts: [{ factType: "skill", startLine: 2, endLine: 2 }] }) }] }],
})));

describe.each([
  ["Fake", () => new FakeCareerDocumentParser()],
  ["OpenAI Responses", openAi],
])("%s 解析端口契约", (_name, createParser) => {
  it("接受相同 Markdown 并返回结构化原文证据", async () => {
    const output = CareerParserOutputSchema.parse(await createParser().parse(markdown));
    expect(output.facts).toMatchObject([{ factValue: { name: "TypeScript" }, grounding: "quoted",
      evidence: { locatorType: "markdown_lines", startLine: 2, endLine: 2, excerpt: "- TypeScript" } }]);
  });
  it("取消与输入预算耗尽使用相同稳定错误", async () => {
    const parser = createParser(); const controller = new AbortController(); controller.abort();
    await expect(parser.parse(markdown, { signal: controller.signal })).rejects.toMatchObject({ code: "CAREER_PARSER_CANCELLED" });
    await expect(parser.parse(markdown, { budget: { maxInputBytes: 1, maxOutputTokens: 100, timeoutMs: 1000 } }))
      .rejects.toMatchObject({ code: "CAREER_PARSER_BUDGET_EXHAUSTED" });
    await expect(parser.parse(markdown, { budget: { maxInputBytes: 16_384, maxOutputTokens: 100, maxTotalTokens: 1, timeoutMs: 1000 } }))
      .rejects.toMatchObject({ code: "CAREER_PARSER_BUDGET_EXHAUSTED" });
    await expect(parser.parse(markdown, { budget: { maxInputBytes: 16_384, maxOutputTokens: 1, maxTotalTokens: 20000, timeoutMs: 1000 } }))
      .rejects.toMatchObject({ code: "CAREER_PARSER_BUDGET_EXHAUSTED" });
  });
});
