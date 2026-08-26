import { z } from "zod";

export const StartDevSessionRequestSchema = z.object({
  subject: z.string().min(1).max(80),
}).strict();

export type StartDevSessionRequest = z.infer<typeof StartDevSessionRequestSchema>;
