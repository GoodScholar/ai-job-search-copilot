import { createInternalOpenAiModelDiagnosticAdapter, type OpenAiModelDiagnosticConfig } from "./internal.js";
export { createOpenAiCareerParser, resolveCareerParserConfig, openAiCareerParserMetadata } from "./career-parser.js";
export { assertJobNormalizerRequestBudget, createOpenAiJobPostingNormalizer, resolveJobNormalizerConfig, openAiJobNormalizerMetadata } from "./job-normalizer.js";

export type { ModelDiagnosticAdapter, ModelDiagnosticProbeResult } from "@job-copilot/contracts/model-diagnostics";
export type { OpenAiModelDiagnosticConfig } from "./internal.js";

/** Production construction only receives deployment runtime configuration. */
export function createOpenAiModelDiagnosticAdapter(config: OpenAiModelDiagnosticConfig) {
  return createInternalOpenAiModelDiagnosticAdapter(config);
}
