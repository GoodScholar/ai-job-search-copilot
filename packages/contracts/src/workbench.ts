import { z } from "zod";

export const WorkbenchHomeSchema = z.object({
  account: z.object({ userId: z.string().uuid() }).strict(),
  summary: z.object({
    recommendations: z.literal(0),
    pendingFacts: z.int().nonnegative(),
    runningAgentRuns: z.int().nonnegative(),
    applications: z.literal(0),
  }).strict(),
}).strict();

export type WorkbenchHome = z.infer<typeof WorkbenchHomeSchema>;
