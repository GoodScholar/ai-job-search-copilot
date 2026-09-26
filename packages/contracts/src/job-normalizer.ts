import { z } from "zod";

export const JOB_NORMALIZER_PROMPT_VERSION = "job-normalizer-prompt-v7";
export const JOB_NORMALIZER_OUTPUT_SCHEMA_VERSION = "job-normalizer-v2";
export const JOB_NORMALIZER_RULE_VERSION = "job-normalization-evidence-v4";
export const DEFAULT_JOB_NORMALIZER_BUDGET = { maxInputBytes: 16_384, maxOutputTokens: 2_000, maxTotalTokens: 12_000, timeoutMs: 25_000 } as const;

export type JobNormalizerBudget = { maxInputBytes: number; maxOutputTokens: number; maxTotalTokens?: number; timeoutMs: number };
export type JobNormalizerCallOptions = {
  signal?: AbortSignal;
  budget?: JobNormalizerBudget;
  /** Called after local safety and budget checks, immediately before a provider request. */
  beforeRequest?: () => Promise<void>;
  /** Called once a provider has reported usage, before parsing or evidence validation can fail. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => Promise<void>;
  /** Explicit evaluation may record only this fixed stage enum; production callers do not log provider payloads. */
  onDiagnostic?: (stage: JobNormalizerDiagnosticStage) => void;
};
export type JobNormalizerDiagnosticStage = "response_incomplete_max_output_tokens" | "response_status_invalid" | "response_output_text_invalid" | "model_payload_invalid" | "model_payload_valid" | "evidence_invalid" | "evidence_invalid:input_injection" | "evidence_invalid:deadlineProvenance" | "evidence_invalid:scalar:company" | "evidence_invalid:scalar:title" | "evidence_invalid:scalar:location" | "evidence_invalid:scalar:postedAt" | "evidence_invalid:scalar:deadline" | "evidence_invalid:scalar:description" | `evidence_invalid:qualification:${"workMode" | "relocationRequired" | "salary" | "seniority" | "education" | "languages" | "workEligibility" | "industry" | "employmentType" | "requiredSkills"}:${"missing" | "field" | "path" | "normalized" | "mapping"}` | `model_payload_invalid:${"invalid_type" | "unrecognized_keys" | "too_small" | "too_big" | "invalid_value" | "custom" | "json"}:${string}`;
export type JobNormalizerMetadata = { adapter: "fake" | "openai"; normalizerVersion: string; promptVersion: string; outputSchemaVersion: string; ruleVersion: string; model: string | null };
export const JobNormalizerMetadataSchema = z.object({
  adapter: z.enum(["fake", "openai"]), normalizerVersion: z.string().trim().min(1).max(64),
  promptVersion: z.string().trim().min(1).max(64), outputSchemaVersion: z.string().trim().min(1).max(64),
  ruleVersion: z.string().trim().min(1).max(64), model: z.string().trim().min(1).max(128).nullable(),
}).strict();
export type JobNormalizerUsage = { status: "known" | "unknown" | "not_called"; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
export type JobNormalizerErrorCode = "JOB_NORMALIZER_OUTPUT_INVALID" | "JOB_NORMALIZER_EVIDENCE_INVALID" | "JOB_NORMALIZER_INJECTION_DETECTED" | "JOB_NORMALIZER_RATE_LIMITED" | "JOB_NORMALIZER_CANCELLED" | "JOB_NORMALIZER_BUDGET_EXHAUSTED" | "JOB_NORMALIZER_UNAVAILABLE" | "JOB_NORMALIZER_AUTH_FAILED";

export class JobNormalizerError extends Error {
  constructor(readonly code: JobNormalizerErrorCode, readonly usage: JobNormalizerUsage = { status: "not_called", inputTokens: null, outputTokens: null, totalTokens: null }) { super(code); }
}

export const JobNormalizationEvidenceSchema = z.object({
  field: z.string().trim().min(1).max(64),
  path: z.string().trim().min(1).max(256),
  rawValue: z.string().trim().min(1).max(2_000),
  normalizedValue: z.string().trim().min(1).max(2_000),
}).strict();

export const JobNormalizerFieldEvidenceSchema = z.record(z.string().trim().min(1).max(64), JobNormalizationEvidenceSchema);

export type BoundJobNormalizationEvidence = z.infer<typeof JobNormalizationEvidenceSchema> & { sourcePostingVersionId: string };

/** Source identities are assigned by the application only, after model output has been validated. */
export function bindJobNormalizerEvidence(sourcePostingVersionId: string, evidence: z.infer<typeof JobNormalizationEvidenceSchema>): BoundJobNormalizationEvidence {
  return { ...evidence, sourcePostingVersionId };
}

export function knownJobNormalizerUsage(inputTokens: number, outputTokens: number): JobNormalizerUsage {
  return { status: "known", inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export const unknownJobNormalizerUsage = (): JobNormalizerUsage => ({ status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null });

export function assertJobNormalizerInputBudget(content: string, options: JobNormalizerCallOptions = {}, requestOverheadTokens = 1_500) {
  if (options.signal?.aborted) throw new JobNormalizerError("JOB_NORMALIZER_CANCELLED");
  const budget = options.budget ?? DEFAULT_JOB_NORMALIZER_BUDGET;
  const maxTotalTokens = budget.maxTotalTokens ?? DEFAULT_JOB_NORMALIZER_BUDGET.maxTotalTokens;
  const inputTokenBound = new TextEncoder().encode(content).byteLength + requestOverheadTokens;
  if (![budget.maxInputBytes, budget.maxOutputTokens, budget.timeoutMs, maxTotalTokens, requestOverheadTokens].every((value) => Number.isSafeInteger(value) && value > 0)
    || new TextEncoder().encode(content).byteLength > budget.maxInputBytes || inputTokenBound + budget.maxOutputTokens > maxTotalTokens)
    throw new JobNormalizerError("JOB_NORMALIZER_BUDGET_EXHAUSTED");
  return { ...budget, maxTotalTokens, inputTokenBound };
}

export function isJobInstructionLike(value: string): boolean {
  return /(?:ignore\s+(?:all\s+)?(?:previous\s+)?(?:instructions?|system\s+(?:prompt|message)|developer\s+message)|(?:reveal|show|display)\s+(?:the\s+)?(?:system\s+(?:prompt|message)|developer\s+message)|忽略.{0,24}(?:之前|所有).{0,24}(?:指令|系统提示|开发者消息)|(?:泄露|显示).{0,24}(?:系统提示|开发者消息))/iu.test(value);
}
