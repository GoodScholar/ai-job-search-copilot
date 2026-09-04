import { z } from "zod";

const summaryCount = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const WorkbenchHomeSchema = z.object({
  account: z.object({ userId: z.string().uuid() }).strict(),
  summary: z.object({
    todayRecommendations: summaryCount,
    pendingFacts: summaryCount,
    activeAgentRuns: summaryCount,
    failedAgentRuns: summaryCount,
    sourceFailures: summaryCount,
    pendingDecisions: summaryCount,
    applications: z.literal(0),
    applicationsAvailable: z.literal(false),
  }).strict(),
}).strict();

export type WorkbenchHome = z.infer<typeof WorkbenchHomeSchema>;
