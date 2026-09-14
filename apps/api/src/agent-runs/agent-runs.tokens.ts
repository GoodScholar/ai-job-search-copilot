import type { AgentRunQueue, createAgentRunCommands, createAgentRunQueries, createRecommendationRunCommands, createRecommendationRunQueries } from "@job-copilot/domain/agent-runs";

export const AGENT_RUN_QUEUE_PORT = Symbol("AGENT_RUN_QUEUE_PORT");
export const AGENT_RUN_COMMANDS = Symbol("AGENT_RUN_COMMANDS");
export const AGENT_RUN_QUERIES = Symbol("AGENT_RUN_QUERIES");
export const RECOMMENDATION_RUN_COMMANDS = Symbol("RECOMMENDATION_RUN_COMMANDS");
export const RECOMMENDATION_RUN_QUERIES = Symbol("RECOMMENDATION_RUN_QUERIES");

export type AgentRunCommands = ReturnType<typeof createAgentRunCommands>;
export type AgentRunQueries = ReturnType<typeof createAgentRunQueries>;
export type RecommendationRunCommands = ReturnType<typeof createRecommendationRunCommands>;
export type RecommendationRunQueries = ReturnType<typeof createRecommendationRunQueries>;
export type { AgentRunQueue };
