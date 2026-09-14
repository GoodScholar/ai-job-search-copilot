import type { AgentRunQueue, createAgentRunCommands, createAgentRunQueries, createRecommendationRunCommands } from "@job-copilot/domain/agent-runs";

export const AGENT_RUN_QUEUE_PORT = Symbol("AGENT_RUN_QUEUE_PORT");
export const AGENT_RUN_COMMANDS = Symbol("AGENT_RUN_COMMANDS");
export const AGENT_RUN_QUERIES = Symbol("AGENT_RUN_QUERIES");
export const RECOMMENDATION_RUN_COMMANDS = Symbol("RECOMMENDATION_RUN_COMMANDS");

export type AgentRunCommands = ReturnType<typeof createAgentRunCommands>;
export type AgentRunQueries = ReturnType<typeof createAgentRunQueries>;
export type RecommendationRunCommands = ReturnType<typeof createRecommendationRunCommands>;
export type { AgentRunQueue };
