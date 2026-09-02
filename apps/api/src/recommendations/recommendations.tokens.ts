import type { createRecommendationQueries } from "@job-copilot/domain/recommendation-queries";
import type { createDeepMatchRunStarter } from "@job-copilot/domain/deep-match-agent-runs";

export const RECOMMENDATION_QUERIES = Symbol("RECOMMENDATION_QUERIES");
export type RecommendationQueries = ReturnType<typeof createRecommendationQueries>;
export const RECOMMENDATION_RUN_STARTER = Symbol("RECOMMENDATION_RUN_STARTER");
export type RecommendationRunStarter = ReturnType<typeof createDeepMatchRunStarter>;
