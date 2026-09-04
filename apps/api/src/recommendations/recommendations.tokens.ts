import type { createRecommendationQueries } from "@job-copilot/domain/recommendation-queries";
import type { createDeepMatchRunStarter } from "@job-copilot/domain/deep-match-agent-runs";
import type { createRecommendationFeedbackCommands, createRecommendationFeedbackQueries } from "@job-copilot/domain/recommendation-feedback";

export const RECOMMENDATION_QUERIES = Symbol("RECOMMENDATION_QUERIES");
export type RecommendationQueries = ReturnType<typeof createRecommendationQueries>;
export const RECOMMENDATION_RUN_STARTER = Symbol("RECOMMENDATION_RUN_STARTER");
export type RecommendationRunStarter = ReturnType<typeof createDeepMatchRunStarter>;
export const RECOMMENDATION_FEEDBACK_COMMANDS = Symbol("RECOMMENDATION_FEEDBACK_COMMANDS");
export type RecommendationFeedbackCommands = ReturnType<typeof createRecommendationFeedbackCommands>;
export const RECOMMENDATION_FEEDBACK_QUERIES = Symbol("RECOMMENDATION_FEEDBACK_QUERIES");
export type RecommendationFeedbackQueries = ReturnType<typeof createRecommendationFeedbackQueries>;
