import {
  parseFreshWorkerHeartbeat,
  WorkerHeartbeatSchema,
  type WorkerHeartbeat,
} from "@job-copilot/contracts/runtime";
import type { OnModuleDestroy } from "@nestjs/common";
import type Redis from "ioredis";
import { closeWithinDeadline } from "../close-within-deadline.js";
import {
  WORKER_HEARTBEAT_FRESHNESS_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
  type Heartbeat,
} from "./heartbeat.js";

export class RedisHeartbeatAdapter implements Heartbeat, OnModuleDestroy {
  private closePromise: Promise<void> | undefined;

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
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async closeResources(): Promise<void> {
    try {
      if (this.redis.status !== "end") await closeWithinDeadline(this.redis.quit(), "heartbeat close deadline");
    } catch {
      // Disconnect below is the non-blocking final fallback.
    } finally {
      if (this.redis.status !== "end") this.redis.disconnect();
    }
  }
}
