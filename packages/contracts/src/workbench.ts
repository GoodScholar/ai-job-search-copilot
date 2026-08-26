import { z } from "zod";

export const WorkbenchHomeSchema = z.object({
  account: z.object({ userId: z.string().uuid() }).strict(),
  summary: z.object({
    recommendations: z.literal(0),
    pendingFacts: z.literal(0),
    runningAgentRuns: z.literal(0),
    applications: z.literal(0),
  }).strict(),
}).strict();

export type WorkbenchHome = z.infer<typeof WorkbenchHomeSchema>;
