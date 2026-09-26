import { createHash } from "node:crypto";
import { JobNormalizerOutputSchema, validateJobNormalizerOutput, type JobNormalizerOutput } from "@job-copilot/contracts/job-imports";
import { DEFAULT_JOB_NORMALIZER_BUDGET, JobNormalizerError, assertJobNormalizerInputBudget, type JobNormalizerCallOptions, type JobNormalizerMetadata } from "@job-copilot/contracts/job-normalizer";

export interface DiscoveryJobPostingNormalizer { metadata: JobNormalizerMetadata; normalize(content: string, options?: JobNormalizerCallOptions): Promise<unknown>; }
export interface DiscoveryJobNormalizerResolver { resolve(metadata: JobNormalizerMetadata): DiscoveryJobPostingNormalizer | undefined; }
export interface DiscoveryJobNormalizationCheckpoint {
  check(input: { userId: string; runId: string; claimToken: string; checkpointKey: string; reserve: Record<string, number | boolean> }): Promise<{ kind: string }>;
}

export class DiscoveryJobNormalizationError extends Error {
  constructor(readonly code: "DISCOVERY_JOB_NORMALIZATION_INTERRUPTED" | "DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE" | "DISCOVERY_JOB_NORMALIZATION_SNAPSHOT_UNSUPPORTED", readonly interruption?: string) { super(code); }
}

function sameMetadata(left: JobNormalizerOutput, right: JobNormalizerMetadata) {
  return left.adapter === right.adapter && left.normalizerVersion === right.normalizerVersion && left.promptVersion === right.promptVersion && left.outputSchemaVersion === right.outputSchemaVersion && left.ruleVersion === right.ruleVersion && left.model === right.model;
}

/** 供 processor 注入 workflow/gate 的唯一模型调用边界；不读取环境，也不持久化未绑定 output。 */
export function createDiscoveryJobNormalizer(input: {
  metadata: JobNormalizerMetadata | null;
  normalizerResolver: DiscoveryJobNormalizerResolver;
  checkpoint: DiscoveryJobNormalizationCheckpoint;
  userId: string; runId: string; claimToken: string; attemptCount: number;
  clock: () => Date; deadline: Date; signal: AbortSignal;
  markUsageIncomplete: () => Promise<void>;
}) {
  if (!input.metadata) throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_SNAPSHOT_UNSUPPORTED");
  const normalizer = input.normalizerResolver.resolve(input.metadata);
  if (!normalizer) throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_SNAPSHOT_UNSUPPORTED");
  const pending = new Map<string, Promise<JobNormalizerOutput>>();
  let usageIncomplete = false;
  let markedIncomplete = false;
  const markIncomplete = async () => {
    usageIncomplete = true;
    if (!markedIncomplete) { markedIncomplete = true; await input.markUsageIncomplete(); }
  };
  const interrupt = (decision: { kind: string }) => {
    if (decision.kind !== "continue") throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_INTERRUPTED", decision.kind);
  };
  return {
    async normalizePosting(value: { identity: string; content: string }): Promise<JobNormalizerOutput> {
      if (usageIncomplete) throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE");
      const key = createHash("sha256").update(`${value.identity}\u001f${value.content}`).digest("hex");
      const existing = pending.get(key);
      if (existing) return existing;
      const call = (async () => {
        const remaining = input.deadline.getTime() - input.clock().getTime();
        if (input.signal.aborted || remaining <= 0) throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_INTERRUPTED");
        const budget = assertJobNormalizerInputBudget(value.content, { budget: { ...DEFAULT_JOB_NORMALIZER_BUDGET, timeoutMs: Math.min(DEFAULT_JOB_NORMALIZER_BUDGET.timeoutMs, remaining) } });
        const prefix = `job_normalizer:${key}:attempt:${input.attemptCount}`;
        let usageSettled = false;
        let invocationStarted = false;
        try {
          const raw = await normalizer.normalize(value.content, {
            signal: input.signal,
            budget,
            beforeRequest: async (requestBudget) => {
              if (input.signal.aborted) throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_INTERRUPTED");
              const reserve: Record<string, number | boolean> = input.metadata!.adapter === "fake" ? {} : { modelCalls: 1, budgetTokens: requestBudget.inputTokenBound + requestBudget.maxOutputTokens };
              interrupt(await input.checkpoint.check({ userId: input.userId, runId: input.runId, claimToken: input.claimToken, checkpointKey: `${prefix}:invoke`, reserve }));
              if (input.signal.aborted) throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_INTERRUPTED");
              invocationStarted = true;
            },
            onUsage: async (usage) => {
              if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) {
                await markIncomplete();
                throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE");
              }
              usageSettled = true;
              interrupt(await input.checkpoint.check({ userId: input.userId, runId: input.runId, claimToken: input.claimToken, checkpointKey: `${prefix}:usage`, reserve: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, settleActual: true, invocationAttemptCount: input.attemptCount } }));
            },
          });
          if (!usageSettled) { await markIncomplete(); throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE"); }
          if (input.signal.aborted) throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_INTERRUPTED");
          const output = JobNormalizerOutputSchema.parse(raw);
          if (!sameMetadata(output, input.metadata!) || !validateJobNormalizerOutput(value.content, output)) throw new JobNormalizerError("JOB_NORMALIZER_EVIDENCE_INVALID");
          return output;
        } catch (error) {
          if (error instanceof DiscoveryJobNormalizationError && error.code === "DISCOVERY_JOB_NORMALIZATION_INTERRUPTED") throw error;
          if (input.signal.aborted && !(error instanceof DiscoveryJobNormalizationError && error.code === "DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE")) {
            if (invocationStarted && !usageSettled) await markIncomplete();
            throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_INTERRUPTED");
          }
          if (invocationStarted && !usageSettled && !(error instanceof DiscoveryJobNormalizationError && error.code === "DISCOVERY_JOB_NORMALIZATION_INTERRUPTED")) {
            await markIncomplete();
            if (error instanceof JobNormalizerError && ["JOB_NORMALIZER_AUTH_FAILED", "JOB_NORMALIZER_INJECTION_DETECTED", "JOB_NORMALIZER_EVIDENCE_INVALID", "JOB_NORMALIZER_OUTPUT_INVALID"].includes(error.code)) throw error;
            throw new DiscoveryJobNormalizationError("DISCOVERY_JOB_NORMALIZATION_USAGE_INCOMPLETE");
          }
          throw error;
        }
      })();
      pending.set(key, call);
      return call;
    },
  };
}
