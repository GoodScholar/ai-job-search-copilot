import type { createRecommendationRunPreparationQueries } from "@job-copilot/domain/recommendation-runs-preparation";

export const RECOMMENDATION_RUN_PREPARATION_QUERIES = Symbol("RECOMMENDATION_RUN_PREPARATION_QUERIES");
export type RecommendationRunPreparationQueries = ReturnType<typeof createRecommendationRunPreparationQueries>;
