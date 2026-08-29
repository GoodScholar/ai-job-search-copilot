import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import Redis from "ioredis";
import {
  AGENT_RUN_BUDGET,
  AGENT_RUN_CLAIM_LEASE_MS,
  AGENT_RUN_JOB_NAME,
  AGENT_RUN_QUEUE,
  AGENT_RUN_SCAN_INTERVAL_MS,
  type AgentRunJob,
} from "@job-copilot/contracts/agent-runs";
import type { AgentRunQueue, createAgentRunRecoveryQueries } from "@job-copilot/domain/agent-runs";

type AgentRunRecoveryQueries = ReturnType<typeof createAgentRunRecoveryQueries>;

export function agentRunQueueJobOptions(runId: string): JobsOptions {
  return {
    jobId: runId,
    attempts: AGENT_RUN_BUDGET.maxAttempts,
    backoff: { type: "fixed", delay: AGENT_RUN_CLAIM_LEASE_MS + AGENT_RUN_SCAN_INTERVAL_MS },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

export class BullmqAgentRunQueue implements AgentRunQueue, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly queue: Queue;
  private closePromise: Promise<void> | undefined;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(AGENT_RUN_QUEUE, { connection: this.redis });
  }

  async enqueue(job: AgentRunJob): Promise<void> {
    await this.queue.add(AGENT_RUN_JOB_NAME, job, agentRunQueueJobOptions(job.runId));
  }

  async onModuleDestroy(): Promise<void> {
    this.closePromise ??= this.closeResources();
    await this.closePromise;
  }

  private async closeResources(): Promise<void> {
    await this.queue.close();
    if (this.redis.status !== "end") await this.redis.quit();
  }
}

export class AgentRunReconciler implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;

  constructor(private readonly input: { recoveryQueries: AgentRunRecoveryQueries; queue: AgentRunQueue }) {}

  async onModuleInit(): Promise<void> {
    await this.scan().catch(() => undefined);
    this.timer = setInterval(() => { void this.scan().catch(() => undefined); }, AGENT_RUN_SCAN_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const jobs = await this.input.recoveryQueries.listRecoverable();
      for (const job of jobs) {
        try { await this.input.queue.enqueue(job); } catch { /* 下一次扫描会重试，单个失败不能阻塞其他 run。 */ }
      }
    } finally {
      this.scanning = false;
    }
  }
}
