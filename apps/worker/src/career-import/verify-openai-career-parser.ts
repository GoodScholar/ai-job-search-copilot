import { CareerParserOutputSchema } from "@job-copilot/contracts/career-import";
import { createOpenAiCareerParser, resolveCareerParserConfig } from "@job-copilot/model-access";
import { assertCareerParserEvaluation, CAREER_PARSER_EVALUATION_MARKDOWN } from "@job-copilot/contracts/career-parser-evaluation";

async function main() {
  if (process.env.CAREER_PARSER_ADAPTER !== "openai") throw new Error("CAREER_PARSER_EXPLICIT_MODE_REQUIRED");
  const metadata = resolveCareerParserConfig(process.env);
  const parser = createOpenAiCareerParser({ apiKey: process.env.OPENAI_API_KEY!, model: metadata.model!,
    endpoint: process.env.OPENAI_ENDPOINT, organization: process.env.OPENAI_ORGANIZATION, project: process.env.OPENAI_PROJECT });
  const startedAt = Date.now();
  const output = CareerParserOutputSchema.parse(await parser.parse(CAREER_PARSER_EVALUATION_MARKDOWN));
  const evaluation = assertCareerParserEvaluation(output, Date.now() - startedAt);
  console.log(JSON.stringify({ adapter: output.adapter, model: metadata.model, parserVersion: output.parserVersion, ...evaluation }));
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("CAREER_PARSER_") ? error.message : "CAREER_PARSER_EVALUATION_FAILED");
  process.exitCode = 1;
});
