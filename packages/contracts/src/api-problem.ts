import { z } from "zod";

export const ApiProblemSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().uuid(),
}).strict();

export type ApiProblem = z.infer<typeof ApiProblemSchema>;
