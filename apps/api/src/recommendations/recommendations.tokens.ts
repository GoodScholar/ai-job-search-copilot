import type { createDeepMatchQueries } from "@job-copilot/domain/deep-match-persistence";
import type { createDeepMatchRunStarter } from "@job-copilot/domain/deep-match-agent-runs";

export const RECOMMENDATION_QUERIES = Symbol("RECOMMENDATION_QUERIES");
export type RecommendationQueries = ReturnType<typeof createDeepMatchQueries>;
export const RECOMMENDATION_RUN_STARTER = Symbol("RECOMMENDATION_RUN_STARTER");
export type RecommendationRunStarter = ReturnType<typeof createDeepMatchRunStarter>;
