import { createOpenAiCareerParser, resolveCareerParserConfig } from "@job-copilot/model-access";
import { FakeCareerDocumentParser } from "./fake-career-document-parser.js";

export function createConfiguredCareerParser(environment: NodeJS.ProcessEnv = process.env) {
  const metadata = resolveCareerParserConfig(environment);
  if (metadata.adapter === "fake") return new FakeCareerDocumentParser();
  return createOpenAiCareerParser({ apiKey: environment.OPENAI_API_KEY!, model: metadata.model!,
    endpoint: environment.OPENAI_ENDPOINT, organization: environment.OPENAI_ORGANIZATION, project: environment.OPENAI_PROJECT });
}
