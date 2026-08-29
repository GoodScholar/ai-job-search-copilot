import type { OnModuleDestroy } from "@nestjs/common";
import { Worker } from "bullmq";
import Redis from "ioredis";
import {
  AGENT_RUN_CLAIM_LEASE_MS,
  AGENT_RUN_QUEUE,
  AgentRunJobSchema,
  type AgentRunJob,
} from "@job-copilot/contracts/agent-runs";
import type { createAgentRunProcessor } from "@job-copilot/domain/agent-runs";

type AgentRunProcessor = ReturnType<typeof createAgentRunProcessor>;
type AgentRunOutcome = Awaited<ReturnType<AgentRunProcessor["process"]>>;
const CLOSE_TIMEOUT_MS = 5_000;

async function closeWithinDeadline(operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("agent run worker close deadline")), CLOSE_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function agentRunAttemptContext(attemptsMade: number, attempts: number | undefined): { finalAttempt: boolean } {
  return { finalAttempt: attemptsMade + 1 >= (attempts ?? 1) };
}

export async function processAgentRunJob(
  job: { data: unknown; attemptsMade: number; attempts: number | undefined },
  processor: AgentRunProcessor,
): Promise<AgentRunOutcome> {
  const payload: AgentRunJob = AgentRunJobSchema.parse(job.data);
  const outcome = await processor.process({
    ...payload,
    ...agentRunAttemptContext(job.attemptsMade, job.attempts),
  });
  if (outcome === "retry") throw new Error("agent run temporarily unavailable");
  return outcome;
}

export class AgentRunConsumer implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly worker: Worker;
  private closePromise: Promise<void> | undefined;

  constructor(input: { redisUrl: string; processor: AgentRunProcessor }) {
    this.redis = new Redis(input.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(
      AGENT_RUN_QUEUE,
      (job) => processAgentRunJob({ data: job.data, attemptsMade: job.attemptsMade, attempts: job.opts.attempts }, input.processor),
      {
        connection: this.redis,
        concurrency: 1,
        lockDuration: AGENT_RUN_CLAIM_LEASE_MS,
        stalledInterval: AGENT_RUN_CLAIM_LEASE_MS,
      },
    );
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private async closeResources(): Promise<void> {
    try { await closeWithinDeadline(this.worker.close()); } catch { /* Redis 故障不能卡住进程销毁。 */ }
    if (this.redis.status !== "end") this.redis.disconnect();
  }
}
