import {
  ReadinessResultSchema,
  WorkerHeartbeatSchema,
  type ReadinessDependencyStatus,
  type ReadinessResult as RuntimeReadinessResult,
  type WorkerHeartbeat,
} from "@job-copilot/contracts/runtime";

const WORKER_HEARTBEAT_KEY = "job-copilot:worker:heartbeat:v1";
const WORKER_HEARTBEAT_FRESHNESS_MS = 10_000;
export const READINESS_CHECKS = Symbol("READINESS_CHECKS");

export type ReadinessDependencies = {
  postgres: () => Promise<boolean>;
  redis: () => Promise<boolean>;
  minio: () => Promise<boolean>;
  mailpit: () => Promise<boolean>;
  worker: () => Promise<boolean>;
};

export type ReadinessResult = RuntimeReadinessResult;

export async function checkReadiness(checks: ReadinessDependencies): Promise<ReadinessResult> {
  const [postgres, redis, minio, mailpit, worker] = await Promise.all([
    checkDependency(checks.postgres),
    checkDependency(checks.redis),
    checkDependency(checks.minio),
    checkDependency(checks.mailpit),
    checkDependency(checks.worker),
  ]);
  const dependencies = { postgres, redis, minio, mailpit, worker };

  return ReadinessResultSchema.parse({
    status: Object.values(dependencies).every((status) => status === "ready") ? "ready" : "not_ready",
    dependencies,
  });
}

export async function readFreshHeartbeat(input: {
  redis: { get(key: string): Promise<string | null> };
  now: Date;
}): Promise<WorkerHeartbeat | null> {
  const storedHeartbeat = await input.redis.get(WORKER_HEARTBEAT_KEY);
  if (!storedHeartbeat) {
    return null;
  }

  try {
    const parsed = WorkerHeartbeatSchema.safeParse(JSON.parse(storedHeartbeat));
    if (!parsed.success) {
      return null;
    }

    const ageMs = input.now.getTime() - new Date(parsed.data.recordedAt).getTime();
    return ageMs >= 0 && ageMs <= WORKER_HEARTBEAT_FRESHNESS_MS ? parsed.data : null;
  } catch {
    return null;
  }
}

async function checkDependency(check: () => Promise<boolean>): Promise<ReadinessDependencyStatus> {
  try {
    return await check() ? "ready" : "not_ready";
  } catch {
    return "not_ready";
  }
}
