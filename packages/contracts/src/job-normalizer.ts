import { z } from "zod";

export const JOB_NORMALIZER_PROMPT_VERSION = "job-normalizer-prompt-v1";
export const JOB_NORMALIZER_OUTPUT_SCHEMA_VERSION = "job-normalizer-v1";
export const DEFAULT_JOB_NORMALIZER_BUDGET = { maxInputBytes: 16_384, maxOutputTokens: 2_000, maxTotalTokens: 12_000, timeoutMs: 25_000 } as const;

export type JobNormalizerBudget = { maxInputBytes: number; maxOutputTokens: number; maxTotalTokens?: number; timeoutMs: number };
export type JobNormalizerCallOptions = { signal?: AbortSignal; budget?: JobNormalizerBudget };
export type JobNormalizerMetadata = { adapter: "fake" | "openai"; normalizerVersion: string; promptVersion: string; outputSchemaVersion: string; model: string | null };
export type JobNormalizerErrorCode = "JOB_NORMALIZER_OUTPUT_INVALID" | "JOB_NORMALIZER_EVIDENCE_INVALID" | "JOB_NORMALIZER_INJECTION_DETECTED" | "JOB_NORMALIZER_RATE_LIMITED" | "JOB_NORMALIZER_CANCELLED" | "JOB_NORMALIZER_BUDGET_EXHAUSTED" | "JOB_NORMALIZER_UNAVAILABLE" | "JOB_NORMALIZER_AUTH_FAILED";

export class JobNormalizerError extends Error {
  constructor(readonly code: JobNormalizerErrorCode) { super(code); }
}

export const JobNormalizationEvidenceSchema = z.object({
  field: z.string().trim().min(1).max(64),
  path: z.string().trim().min(1).max(256),
  rawValue: z.string().trim().min(1).max(2_000),
  normalizedValue: z.string().trim().min(1).max(2_000),
}).strict();

export const JobNormalizerFieldEvidenceSchema = z.record(z.string().trim().min(1).max(64), JobNormalizationEvidenceSchema);

export function assertJobNormalizerInputBudget(content: string, options: JobNormalizerCallOptions = {}) {
  if (options.signal?.aborted) throw new JobNormalizerError("JOB_NORMALIZER_CANCELLED");
  const budget = options.budget ?? DEFAULT_JOB_NORMALIZER_BUDGET;
  const maxTotalTokens = budget.maxTotalTokens ?? DEFAULT_JOB_NORMALIZER_BUDGET.maxTotalTokens;
  const inputTokenBound = new TextEncoder().encode(content).byteLength + 1_500;
  if (![budget.maxInputBytes, budget.maxOutputTokens, budget.timeoutMs, maxTotalTokens].every((value) => Number.isSafeInteger(value) && value > 0)
    || new TextEncoder().encode(content).byteLength > budget.maxInputBytes || inputTokenBound + budget.maxOutputTokens > maxTotalTokens)
    throw new JobNormalizerError("JOB_NORMALIZER_BUDGET_EXHAUSTED");
  return { ...budget, maxTotalTokens, inputTokenBound };
}

export function isJobInstructionLike(value: string): boolean {
  return /(?:ignore\s+(?:all\s+)?previous|system\s+prompt|developer\s+message|tool\s+call|忽略.{0,16}(?:指令|之前)|系统提示|开发者消息|调用工具)/iu.test(value);
}
