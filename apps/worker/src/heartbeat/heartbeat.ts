import type { WorkerHeartbeat } from "@job-copilot/contracts/runtime";

export const WORKER_HEARTBEAT_KEY = "job-copilot:worker:heartbeat:v1";
export const WORKER_HEARTBEAT_TTL_SECONDS = 15;
export const WORKER_HEARTBEAT_FRESHNESS_MS = 10_000;

export interface Heartbeat {
  write(heartbeat: WorkerHeartbeat): Promise<void>;
  readFresh(now: Date): Promise<WorkerHeartbeat | null>;
  close(): Promise<void>;
}
