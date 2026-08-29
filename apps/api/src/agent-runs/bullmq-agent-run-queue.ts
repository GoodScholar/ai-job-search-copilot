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

interface AgentRunQueueClient {
  add(name: string, data: AgentRunJob, options: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
}

type BullmqAgentRunQueueOptions = {
  enqueueDeadlineMs?: number;
  queueFactory?: () => AgentRunQueueClient;
};

class AgentRunQueueTimeoutError extends Error {
  readonly code = "AGENT_RUN_QUEUE_TIMEOUT";
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
  private redis: Redis | undefined;
  private queue: AgentRunQueueClient | undefined;

  constructor(
    private readonly redisUrl = process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`,
    private readonly options: BullmqAgentRunQueueOptions = {},
  ) {}

  async enqueue(job: AgentRunJob): Promise<void> {
    const payload = AgentRunJobSchema.parse(job);
    const queue = this.getQueue();
    try {
      await enqueueWithDeadline(() => queue.add(AGENT_RUN_JOB_NAME, payload, {
        jobId: payload.runId,
        attempts: AGENT_RUN_BUDGET.maxAttempts,
        backoff: { type: "fixed", delay: AGENT_RUN_CLAIM_LEASE_MS + AGENT_RUN_SCAN_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: true,
      }), this.options.enqueueDeadlineMs ?? DEFAULT_ENQUEUE_DEADLINE_MS);
    } catch (error) {
      await this.disconnectFailedQueue(queue);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    if (this.redis && this.redis.status !== "end") await this.redis.quit();
  }

  private getQueue(): AgentRunQueueClient {
    if (this.queue) return this.queue;
    if (this.options.queueFactory) {
      this.queue = this.options.queueFactory();
      return this.queue;
    }
    this.redis = new Redis(this.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      retryStrategy: (attempt) => attempt <= 1 ? 50 : null,
      lazyConnect: true,
    });
    this.queue = new Queue(AGENT_RUN_QUEUE, { connection: this.redis });
    return this.queue;
  }

  private async disconnectFailedQueue(queue: AgentRunQueueClient): Promise<void> {
    if (this.queue !== queue) return;
    this.queue = undefined;
    const redis = this.redis;
    this.redis = undefined;
    try { await queue.disconnect(); } catch { /* 原始 enqueue 错误保持为主错误。 */ }
    if (redis && redis.status !== "end") redis.disconnect();
  }
}
