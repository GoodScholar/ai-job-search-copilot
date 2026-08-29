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

export type AgentRunRecoveryFailure =
  | { failureCode: "AGENT_RUN_RECOVERY_SCAN_FAILED" }
  | {
    failureCode: "AGENT_RUN_RECOVERY_ENQUEUE_FAILED";
    runId: string;
    userId: string;
  };

export interface AgentRunRecoveryReporter {
  report(failure: AgentRunRecoveryFailure): void | Promise<void>;
}

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

  constructor(private readonly input: {
    recoveryQueries: AgentRunRecoveryQueries;
    queue: AgentRunQueue;
    reporter: AgentRunRecoveryReporter;
  }) {}

  async onModuleInit(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => { void this.scan(); }, AGENT_RUN_SCAN_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let jobs: AgentRunJob[];
      try {
        jobs = await this.input.recoveryQueries.listRecoverable();
      } catch {
        await this.report({ failureCode: "AGENT_RUN_RECOVERY_SCAN_FAILED" });
        return;
      }
      for (const job of jobs) {
        try {
          await this.input.queue.enqueue(job);
        } catch {
          await this.report({
            failureCode: "AGENT_RUN_RECOVERY_ENQUEUE_FAILED",
            runId: job.runId,
            userId: job.userId,
          });
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async report(failure: AgentRunRecoveryFailure): Promise<void> {
    try { await this.input.reporter.report(failure); } catch { /* Reporter 故障不能改变恢复控制流。 */ }
  }
}
