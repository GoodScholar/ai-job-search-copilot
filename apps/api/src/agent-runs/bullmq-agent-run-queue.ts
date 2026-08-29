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
const DEFAULT_SHUTDOWN_DEADLINE_MS = 2_000;

interface AgentRunQueueClient {
  add(name: string, data: AgentRunJob, options: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
}

type BullmqAgentRunQueueOptions = {
  enqueueDeadlineMs?: number;
  cleanupDeadlineMs?: number;
  cooldownMs?: number;
  shutdownDeadlineMs?: number;
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

class AgentRunQueueDestroyedError extends Error {
  readonly code = "AGENT_RUN_QUEUE_DESTROYED";
}

async function enqueueWithDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const operations: Promise<T>[] = [
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AgentRunQueueTimeoutError()), deadlineMs);
      }),
    ];
    if (signal) {
      operations.push(new Promise<T>((_resolve, reject) => {
        abort = () => reject(new AgentRunQueueDestroyedError());
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }));
    }
    return await Promise.race(operations);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export class BullmqAgentRunQueue implements AgentRunQueue {
  private active: QueueGeneration | undefined;
  private cooldownUntil = 0;
  private destroyed = false;
  private destroyPromise: Promise<void> | undefined;
  private readonly enqueueAbort = new AbortController();
  private readonly cleanupAbort = new AbortController();
  private readonly generations = new Set<QueueGeneration>();
  private readonly enqueues = new Set<Promise<void>>();
  private readonly cleanups = new Set<Promise<void>>();

  constructor(
    private readonly redisUrl = process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`,
    private readonly options: BullmqAgentRunQueueOptions = {},
  ) {}

  async enqueue(job: AgentRunJob): Promise<void> {
    if (this.destroyed) throw new AgentRunQueueDestroyedError();
    const payload = AgentRunJobSchema.parse(job);
    const generation = this.getGeneration();
    generation.inFlight += 1;
    const enqueue = this.enqueueGeneration(generation, payload);
    this.enqueues.add(enqueue);
    try {
      await enqueue;
    } finally {
      this.enqueues.delete(enqueue);
    }
  }

  onModuleDestroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.destroyPromise = this.destroy();
    return this.destroyPromise;
  }

  private async enqueueGeneration(generation: QueueGeneration, payload: AgentRunJob): Promise<void> {
    try {
      await enqueueWithDeadline(() => generation.queue.add(AGENT_RUN_JOB_NAME, payload, {
        jobId: payload.runId,
        attempts: AGENT_RUN_BUDGET.maxAttempts,
        backoff: { type: "fixed", delay: AGENT_RUN_CLAIM_LEASE_MS + AGENT_RUN_SCAN_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: true,
      }), this.options.enqueueDeadlineMs ?? DEFAULT_ENQUEUE_DEADLINE_MS, this.enqueueAbort.signal);
    } catch (error) {
      this.retire(generation);
      throw error;
    } finally {
      generation.inFlight -= 1;
      this.startCleanupWhenIdle(generation);
    }
  }

  private async destroy(): Promise<void> {
    const timer = setTimeout(
      () => this.cleanupAbort.abort(),
      this.options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS,
    );
    this.enqueueAbort.abort();
    for (const generation of this.generations) {
      if (generation.redis && generation.redis.status !== "end") generation.redis.disconnect();
      this.retire(generation);
    }
    try {
      await Promise.allSettled([...this.enqueues]);
      await Promise.allSettled([...this.cleanups]);
    } finally {
      clearTimeout(timer);
      this.cleanupAbort.abort();
      this.active = undefined;
      this.generations.clear();
      this.cleanups.clear();
    }
  }

  private getGeneration(): QueueGeneration {
    if (this.destroyed) throw new AgentRunQueueDestroyedError();
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
    const generation = { queue, redis, inFlight: 0, retired: false, cleanupStarted: false };
    this.generations.add(generation);
    return generation;
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
      this.cleanupAbort.signal,
    )
      .catch(() => undefined)
      .finally(() => {
        if (generation.redis && generation.redis.status !== "end") generation.redis.disconnect();
        this.generations.delete(generation);
        this.cleanups.delete(cleanup);
      });
    this.cleanups.add(cleanup);
  }
}
