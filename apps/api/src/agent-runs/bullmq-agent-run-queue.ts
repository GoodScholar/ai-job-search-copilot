import { Queue } from "bullmq";
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

export class BullmqAgentRunQueue implements AgentRunQueue {
  private redis: Redis | undefined;
  private queue: Queue | undefined;

  constructor(private readonly redisUrl = process.env.REDIS_URL ?? `redis://127.0.0.1:${process.env.REDIS_PORT ?? "63790"}`) {}

  async enqueue(job: AgentRunJob): Promise<void> {
    const payload = AgentRunJobSchema.parse(job);
    await this.getQueue().add(AGENT_RUN_JOB_NAME, payload, {
      jobId: payload.runId,
      attempts: AGENT_RUN_BUDGET.maxAttempts,
      backoff: { type: "fixed", delay: AGENT_RUN_CLAIM_LEASE_MS + AGENT_RUN_SCAN_INTERVAL_MS },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    if (this.redis && this.redis.status !== "end") await this.redis.quit();
  }

  private getQueue(): Queue {
    if (this.queue) return this.queue;
    this.redis = new Redis(this.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.queue = new Queue(AGENT_RUN_QUEUE, { connection: this.redis });
    return this.queue;
  }
}
