import type { OnModuleInit } from "@nestjs/common";

/** 仅触发领域观察器，独立于页面访问；没有业务进度或完成状态。 */
export class JourneyMetricsObserver implements OnModuleInit {
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> | undefined;
  constructor(private readonly metrics: { collect(): Promise<void> }, private readonly report: (code: "JOURNEY_METRIC_COLLECTION_FAILED") => void) {}

  onModuleInit(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), 5_000);
  }
  private tick(): void {
    if (this.work) return;
    this.work = this.metrics.collect().catch(() => { this.report("JOURNEY_METRIC_COLLECTION_FAILED"); }).finally(() => { this.work = undefined; });
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.work;
  }
}
