import { z } from "zod";
import { ApiProblemSchema } from "./api-problem";

export const WorkerHeartbeatSchema = z.object({
  workerId: z.string().min(1),
  recordedAt: z.iso.datetime(),
  contractVersion: z.literal(1),
}).strict();

export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;

export const WORKER_HEARTBEAT_KEY = "job-copilot:worker:heartbeat:v1";
export const WORKER_HEARTBEAT_TTL_SECONDS = 15;
export const WORKER_HEARTBEAT_FRESHNESS_MS = 10_000;

export function parseFreshWorkerHeartbeat(value: string, now: Date): WorkerHeartbeat | null {
  try {
    const parsed = WorkerHeartbeatSchema.safeParse(JSON.parse(value));
    if (!parsed.success) {
      return null;
    }

    const ageMs = now.getTime() - new Date(parsed.data.recordedAt).getTime();
    return ageMs >= 0 && ageMs <= WORKER_HEARTBEAT_FRESHNESS_MS ? parsed.data : null;
  } catch {
    return null;
  }
}

export const ReadinessDependencyStatusSchema = z.enum(["ready", "not_ready"]);

export const ReadinessDependenciesSchema = z.object({
  postgres: ReadinessDependencyStatusSchema,
  redis: ReadinessDependencyStatusSchema,
  minio: ReadinessDependencyStatusSchema,
  mailpit: ReadinessDependencyStatusSchema,
  worker: ReadinessDependencyStatusSchema,
}).strict();

export const ReadinessResultSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  dependencies: ReadinessDependenciesSchema,
}).strict();

export const ReadinessResponseSchema = z.object({
  status: z.literal("ready"),
  dependencies: ReadinessDependenciesSchema,
}).strict();

export const RuntimeNotReadyProblemSchema = ApiProblemSchema.extend({
  code: z.literal("RUNTIME_NOT_READY"),
  dependencies: ReadinessDependenciesSchema,
}).strict();

export type ReadinessDependencies = z.infer<typeof ReadinessDependenciesSchema>;
export type ReadinessDependencyStatus = z.infer<typeof ReadinessDependencyStatusSchema>;
export type ReadinessResult = z.infer<typeof ReadinessResultSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
export type RuntimeNotReadyProblem = z.infer<typeof RuntimeNotReadyProblemSchema>;
