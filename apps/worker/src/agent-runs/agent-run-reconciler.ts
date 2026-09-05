import type { OnModuleInit } from "@nestjs/common";
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

const REDIS_LIFECYCLE_TIMEOUT_MS = 5_000;

async function withinDeadline<T>(operation: Promise<T>, timeoutMs = REDIS_LIFECYCLE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("agent run redis deadline")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

export class BullmqAgentRunQueue implements AgentRunQueue {
  private readonly redis: Redis;
  private readonly queue: Queue;
  private closePromise: Promise<void> | undefined;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: REDIS_LIFECYCLE_TIMEOUT_MS, commandTimeout: REDIS_LIFECYCLE_TIMEOUT_MS });
    this.queue = new Queue(AGENT_RUN_QUEUE, { connection: this.redis });
  }

  async enqueue(job: AgentRunJob): Promise<void> {
    await withinDeadline(this.queue.add(AGENT_RUN_JOB_NAME, job, agentRunQueueJobOptions(job.runId)));
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    try { await withinDeadline(this.queue.close()); } catch { /* 关闭不能永久阻塞 Worker 退出。 */ }
    if (this.redis.status !== "end") this.redis.disconnect();
  }
}

export class AgentRunReconciler implements OnModuleInit {
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;
  private destroyed = false;
  private scanPromise: Promise<void> | undefined;
  private recoveryPromise: Promise<AgentRunJob[]> | undefined;
  private abortScan: (() => void) | undefined;
  private destroyPromise: Promise<void> | undefined;

  constructor(private readonly input: {
    recoveryQueries: AgentRunRecoveryQueries;
    queue: AgentRunQueue;
    reporter: AgentRunRecoveryReporter;
    scanTimeoutMs?: number;
  }) {}

  async onModuleInit(): Promise<void> {
    await this.scan();
    this.timer = setInterval(() => { void this.scan(); }, AGENT_RUN_SCAN_INTERVAL_MS);
  }

  close(): Promise<void> {
    this.destroyPromise ??= this.destroy();
    return this.destroyPromise;
  }

  private async destroy(): Promise<void> {
    this.destroyed = true;
    this.abortScan?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const deadline = Date.now() + (this.input.scanTimeoutMs ?? REDIS_LIFECYCLE_TIMEOUT_MS);
    await this.waitForClose(this.scanPromise, deadline);
    await this.waitForClose(this.recoveryPromise, deadline);
  }

  private async scan(): Promise<void> {
    if (this.destroyed || this.scanning || this.recoveryPromise) return;
    this.scanning = true;
    let active = true;
    this.abortScan = () => { active = false; };
    const scanDeadline = Date.now() + (this.input.scanTimeoutMs ?? REDIS_LIFECYCLE_TIMEOUT_MS);
    const work = (async () => {
      let jobs: AgentRunJob[];
      const recovery = this.input.recoveryQueries.listRecoverable();
      this.recoveryPromise = recovery;
      void recovery.then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        if (this.recoveryPromise === recovery) this.recoveryPromise = undefined;
      }).catch(() => undefined);
      try {
        jobs = await withinDeadline(recovery, Math.max(1, scanDeadline - Date.now() - 1));
      } catch {
        if (active) await this.report({ failureCode: "AGENT_RUN_RECOVERY_SCAN_FAILED" });
        return;
      }
      for (const job of jobs) {
        if (!active || this.destroyed || Date.now() >= scanDeadline) return;
        try {
          await withinDeadline(this.input.queue.enqueue(job), Math.max(1, scanDeadline - Date.now() - 1));
        } catch {
          if (!active) return;
          await this.report({
            failureCode: "AGENT_RUN_RECOVERY_ENQUEUE_FAILED",
            runId: job.runId,
            userId: job.userId,
          });
        }
      }
    })();
    this.scanPromise = work;
    try {
      await withinDeadline(work, this.input.scanTimeoutMs ?? REDIS_LIFECYCLE_TIMEOUT_MS);
    } catch {
      if (active) await this.report({ failureCode: "AGENT_RUN_RECOVERY_SCAN_FAILED" });
    } finally {
      active = false;
      this.abortScan = undefined;
      this.scanning = false;
      if (this.scanPromise === work) this.scanPromise = undefined;
    }
  }

  private async waitForClose(operation: Promise<unknown> | undefined, deadline: number): Promise<void> {
    if (!operation) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    try { await withinDeadline(operation, remaining); } catch { /* deadline 后由 PostgreSQL client close 强制终止；原 promise 已附加 rejection handler。 */ }
  }

  private async report(failure: AgentRunRecoveryFailure): Promise<void> {
    try { await this.input.reporter.report(failure); } catch { /* Reporter 故障不能改变恢复控制流。 */ }
  }
}
