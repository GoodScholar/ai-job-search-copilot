import {
  parseFreshWorkerHeartbeat,
  WorkerHeartbeatSchema,
  type WorkerHeartbeat,
} from "@job-copilot/contracts/runtime";
import type Redis from "ioredis";
import {
  WORKER_HEARTBEAT_FRESHNESS_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
  type Heartbeat,
} from "./heartbeat.js";

export class RedisHeartbeatAdapter implements Heartbeat {
  constructor(private readonly redis: Redis) {}

  async write(heartbeat: WorkerHeartbeat): Promise<void> {
    const validHeartbeat = WorkerHeartbeatSchema.parse(heartbeat);
    await this.redis.set(
      WORKER_HEARTBEAT_KEY,
      JSON.stringify(validHeartbeat),
      "EX",
      WORKER_HEARTBEAT_TTL_SECONDS,
    );
  }

  async readFresh(now: Date): Promise<WorkerHeartbeat | null> {
    const storedHeartbeat = await this.redis.get(WORKER_HEARTBEAT_KEY);
    if (!storedHeartbeat) {
      return null;
    }

    return parseFreshWorkerHeartbeat(storedHeartbeat, now);
  }

  async close(): Promise<void> {
    if (this.redis.status !== "end") {
      await this.redis.quit();
    }
  }
}
