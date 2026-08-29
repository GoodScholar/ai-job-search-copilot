import { Queue, type JobsOptions } from "bullmq";
import Redis from "ioredis";
import {
  AGENT_RUN_BUDGET,
  AGENT_RUN_CLAIM_LEASE_MS,
  AGENT_RUN_JOB_NAME,
  AGENT_RUN_QUEUE,
  AGENT_RUN_SCAN_INTERVAL_MS,
  AgentRunJobSchema,
  type AgentRunJob,
} from "@job-copilot/contracts/agent-runs";
import type { AgentRunQueue } from "@job-copilot/domain/agent-runs";

const DEFAULT_ENQUEUE_DEADLINE_MS = 1_500;
const DEFAULT_CLEANUP_DEADLINE_MS = 250;
const DEFAULT_COOLDOWN_MS = 1_000;

interface AgentRunQueueClient {
  add(name: string, data: AgentRunJob, options: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
}

type BullmqAgentRunQueueOptions = {
  enqueueDeadlineMs?: number;
  cleanupDeadlineMs?: number;
  cooldownMs?: number;
  queueFactory?: () => AgentRunQueueClient;
};

type QueueGeneration = {
  queue: AgentRunQueueClient;
  redis?: Redis;
  inFlight: number;
  retired: boolean;
  cleanupStarted: boolean;
};

class AgentRunQueueTimeoutError extends Error {
  readonly code = "AGENT_RUN_QUEUE_TIMEOUT";
}

class AgentRunQueueCooldownError extends Error {
  readonly code = "AGENT_RUN_QUEUE_COOLDOWN";
}

async function enqueueWithDeadline<T>(operation: () => Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentRunQueueTimeoutError()), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BullmqAgentRunQueue implements AgentRunQueue {
  private active: QueueGeneration | undefined;
  private cooldownUntil = 0;
  private readonly cleanups = new Set<Promise<void>>();

  constructor(
    private readonly redisUrl = process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`,
    private readonly options: BullmqAgentRunQueueOptions = {},
  ) {}

  async enqueue(job: AgentRunJob): Promise<void> {
    const payload = AgentRunJobSchema.parse(job);
    const generation = this.getGeneration();
    generation.inFlight += 1;
    try {
      await enqueueWithDeadline(() => generation.queue.add(AGENT_RUN_JOB_NAME, payload, {
        jobId: payload.runId,
        attempts: AGENT_RUN_BUDGET.maxAttempts,
        backoff: { type: "fixed", delay: AGENT_RUN_CLAIM_LEASE_MS + AGENT_RUN_SCAN_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: true,
      }), this.options.enqueueDeadlineMs ?? DEFAULT_ENQUEUE_DEADLINE_MS);
    } catch (error) {
      this.retire(generation);
      throw error;
    } finally {
      generation.inFlight -= 1;
      this.startCleanupWhenIdle(generation);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.active) this.retire(this.active);
    await Promise.allSettled(this.cleanups);
  }

  private getGeneration(): QueueGeneration {
    if (this.active) return this.active;
    if (Date.now() < this.cooldownUntil) throw new AgentRunQueueCooldownError();

    if (this.options.queueFactory) {
      this.active = this.createGeneration(this.options.queueFactory());
      return this.active;
    }
    const redis = new Redis(this.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      retryStrategy: (attempt) => attempt <= 1 ? 50 : null,
      lazyConnect: true,
    });
    this.active = this.createGeneration(new Queue(AGENT_RUN_QUEUE, { connection: redis }), redis);
    return this.active;
  }

  private createGeneration(queue: AgentRunQueueClient, redis?: Redis): QueueGeneration {
    return { queue, redis, inFlight: 0, retired: false, cleanupStarted: false };
  }

  private retire(generation: QueueGeneration): void {
    if (generation.retired) return;
    generation.retired = true;
    if (this.active === generation) this.active = undefined;
    this.cooldownUntil = Math.max(
      this.cooldownUntil,
      Date.now() + (this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS),
    );
    this.startCleanupWhenIdle(generation);
  }

  private startCleanupWhenIdle(generation: QueueGeneration): void {
    if (!generation.retired || generation.inFlight > 0 || generation.cleanupStarted) return;
    generation.cleanupStarted = true;
    const cleanup = enqueueWithDeadline(
      () => generation.queue.disconnect(),
      this.options.cleanupDeadlineMs ?? DEFAULT_CLEANUP_DEADLINE_MS,
    )
      .catch(() => undefined)
      .finally(() => {
        if (generation.redis && generation.redis.status !== "end") generation.redis.disconnect();
        this.cleanups.delete(cleanup);
      });
    this.cleanups.add(cleanup);
  }
}
