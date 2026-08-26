import { describe, expect, it } from "vitest";
import { ApiProblemSchema } from "./api-problem";
import { StartDevSessionRequestSchema } from "./auth";
import { ReadinessDependenciesSchema, RuntimeNotReadyProblemSchema, WorkerHeartbeatSchema } from "./runtime";
import { WorkbenchHomeSchema } from "./workbench";
import { parseFreshWorkerHeartbeat } from "./runtime";

describe("shared contracts", () => {
  it("rejects error payloads without a request id", () => {
    expect(ApiProblemSchema.safeParse({ code: "AUTH_REQUIRED", message: "请先登录" }).success)
      .toBe(false);
  });

  it("accepts only the real empty workbench in this slice", () => {
    expect(WorkbenchHomeSchema.parse({
      account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
      summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
    }).summary.recommendations).toBe(0);
  });

  it("rejects an empty Dev Auth subject", () => {
    expect(StartDevSessionRequestSchema.safeParse({ subject: "" }).success).toBe(false);
  });

  it("rejects a worker heartbeat from another contract version", () => {
    expect(WorkerHeartbeatSchema.safeParse({
      workerId: "worker-1",
      recordedAt: "2026-08-26T13:00:00.000Z",
      contractVersion: 2,
    }).success).toBe(false);
  });

  it("shares strict worker heartbeat freshness parsing between runtime participants", () => {
    const heartbeat = JSON.stringify({
      workerId: "worker-1",
      recordedAt: "2026-08-26T10:00:00.000Z",
      contractVersion: 1,
    });

    expect(parseFreshWorkerHeartbeat(heartbeat, new Date("2026-08-26T10:00:10.000Z"))).toEqual({
      workerId: "worker-1",
      recordedAt: "2026-08-26T10:00:00.000Z",
      contractVersion: 1,
    });
    expect(parseFreshWorkerHeartbeat(heartbeat, new Date("2026-08-26T10:00:10.001Z"))).toBeNull();
    expect(parseFreshWorkerHeartbeat("not-json", new Date("2026-08-26T10:00:00.000Z"))).toBeNull();
  });

  it("keeps dependency statuses as the only strict runtime problem extension", () => {
    const dependencies = {
      postgres: "ready",
      redis: "ready",
      minio: "not_ready",
      mailpit: "ready",
      worker: "not_ready",
    };

    expect(ReadinessDependenciesSchema.safeParse(dependencies).success).toBe(true);
    expect(RuntimeNotReadyProblemSchema.safeParse({
      code: "RUNTIME_NOT_READY",
      message: "运行依赖未就绪",
      requestId: "3d4c8eb3-2b92-4d91-aad4-2b92f4c6f77a",
      dependencies,
    }).success).toBe(true);
    expect(ApiProblemSchema.safeParse({
      code: "RUNTIME_NOT_READY",
      message: "运行依赖未就绪",
      requestId: "3d4c8eb3-2b92-4d91-aad4-2b92f4c6f77a",
      dependencies,
    }).success).toBe(false);
    expect(RuntimeNotReadyProblemSchema.safeParse({
      code: "RUNTIME_NOT_READY",
      message: "运行依赖未就绪",
      requestId: "3d4c8eb3-2b92-4d91-aad4-2b92f4c6f77a",
      dependencies: { ...dependencies, secret: "must-not-escape" },
    }).success).toBe(false);
  });
});
