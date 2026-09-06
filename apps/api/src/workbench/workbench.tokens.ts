import type { GetWorkbenchHome } from "@job-copilot/domain/workbench-home";
import type { createFirstRecommendationJourneyCommands } from "@job-copilot/domain/first-recommendation-journey";

export const WORKBENCH_HOME = Symbol("WORKBENCH_HOME");
export const FIRST_RECOMMENDATION_JOURNEY_COMMANDS = Symbol("FIRST_RECOMMENDATION_JOURNEY_COMMANDS");

export type WorkbenchHomeService = GetWorkbenchHome;
export type FirstRecommendationJourneyCommands = ReturnType<typeof createFirstRecommendationJourneyCommands>;
