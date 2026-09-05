import type { createRunPreflightQueries, RunPreflightEvaluator } from "@job-copilot/domain/run-preflight";

export const RUN_PREFLIGHT_EVALUATOR = Symbol("RUN_PREFLIGHT_EVALUATOR");
export const RUN_PREFLIGHT_QUERIES = Symbol("RUN_PREFLIGHT_QUERIES");
export type RunPreflightQueries = ReturnType<typeof createRunPreflightQueries>;
export type { RunPreflightEvaluator };
