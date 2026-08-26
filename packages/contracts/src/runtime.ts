import { z } from "zod";
import { ApiProblemSchema } from "./api-problem";

export const WorkerHeartbeatSchema = z.object({
  workerId: z.string().min(1),
  recordedAt: z.iso.datetime(),
  contractVersion: z.literal(1),
}).strict();

export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;

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
