import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { AGENT_RUN_SCAN_INTERVAL_MS } from "@job-copilot/contracts/agent-runs";
import type { createJobDiscoverySchedules } from "@job-copilot/domain/job-discovery-schedules";

type JobDiscoverySchedules = Pick<ReturnType<typeof createJobDiscoverySchedules>, "materializeDue" | "dispatchPending">;

export type AgentRunScheduleFailure =
  | { failureCode: "JOB_DISCOVERY_SCHEDULE_MATERIALIZE_FAILED" }
  | { failureCode: "JOB_DISCOVERY_SCHEDULE_DISPATCH_FAILED" };

export interface AgentRunScheduleReporter {
  report(failure: AgentRunScheduleFailure): void | Promise<void>;
}

const SCHEDULE_SCAN_TIMEOUT_MS = 5_000;

async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("job discovery schedule deadline")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** PostgreSQL schedule facts are authoritative; this only supplies bounded Worker wakeups. */
export class AgentRunScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private destroyed = false;
  private scanPromise: Promise<void> | undefined;

  constructor(private readonly input: {
    schedules: JobDiscoverySchedules;
    reporter: AgentRunScheduleReporter;
    scanTimeoutMs?: number;
  }) {}

  async onModuleInit(): Promise<void> {
    await this.scan();
    if (!this.destroyed) this.timer = setInterval(() => { void this.scan(); }, AGENT_RUN_SCAN_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.scanPromise) {
      try { await withinDeadline(this.scanPromise, this.timeoutMs()); } catch { /* 查询无法取消时也不能阻塞 Worker 退出。 */ }
    }
  }

  private async scan(): Promise<void> {
    if (this.destroyed || this.scanPromise) return;
    const work = this.scanOnce();
    this.scanPromise = work;
    void work.finally(() => {
      if (this.scanPromise === work) this.scanPromise = undefined;
    }).catch(() => undefined);
    try {
      await withinDeadline(work, this.timeoutMs());
    } catch {
      // scanOnce 已按阶段报告稳定码；此处只确保初始化和 tick 始终有界返回。
    }
  }

  private async scanOnce(): Promise<void> {
    let materialization: Promise<unknown> | undefined;
    try {
      materialization = this.input.schedules.materializeDue({ limit: 100 });
      await withinDeadline(materialization, this.timeoutMs());
    } catch {
      if (!this.destroyed) await this.report({ failureCode: "JOB_DISCOVERY_SCHEDULE_MATERIALIZE_FAILED" });
      // Deadline 仅让调用方继续；未结束的 PostgreSQL 调用仍占有 single-flight，禁止重入。
      await materialization?.catch(() => undefined);
      return;
    }
    if (this.destroyed) return;
    let dispatch: Promise<unknown> | undefined;
    try {
      dispatch = this.input.schedules.dispatchPending({ limit: 100 });
      await withinDeadline(dispatch, this.timeoutMs());
    } catch {
      if (!this.destroyed) await this.report({ failureCode: "JOB_DISCOVERY_SCHEDULE_DISPATCH_FAILED" });
      await dispatch?.catch(() => undefined);
    }
  }

  private timeoutMs(): number {
    return this.input.scanTimeoutMs ?? SCHEDULE_SCAN_TIMEOUT_MS;
  }

  private async report(failure: AgentRunScheduleFailure): Promise<void> {
    try { await this.input.reporter.report(failure); } catch { /* 报告器故障不能影响下轮扫描。 */ }
  }
}
