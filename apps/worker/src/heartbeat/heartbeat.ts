import type { WorkerHeartbeat } from "@job-copilot/contracts/runtime";
export {
  WORKER_HEARTBEAT_FRESHNESS_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from "@job-copilot/contracts/runtime";

export interface Heartbeat {
  write(heartbeat: WorkerHeartbeat): Promise<void>;
  readFresh(now: Date): Promise<WorkerHeartbeat | null>;
  close(): Promise<void>;
}
