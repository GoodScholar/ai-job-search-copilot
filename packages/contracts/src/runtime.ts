import { z } from "zod";

export const WorkerHeartbeatSchema = z.object({
  workerId: z.string().min(1),
  recordedAt: z.iso.datetime(),
  contractVersion: z.literal(1),
}).strict();

export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;
