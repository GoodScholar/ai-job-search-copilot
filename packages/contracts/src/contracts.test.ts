import { describe, expect, it } from "vitest";
import { ApiProblemSchema } from "./api-problem";
import { StartDevSessionRequestSchema } from "./auth";
import { ReadinessDependenciesSchema, RuntimeNotReadyProblemSchema, WorkerHeartbeatSchema } from "./runtime";
import { WorkbenchHomeSchema } from "./workbench";
import { parseFreshWorkerHeartbeat } from "./runtime";
import { RecommendationExclusionPageSchema, RecommendationListHistoryPageSchema, RecommendationListSchema } from "./recommendations";

describe("shared contracts", () => {
  it("retains every exclusion in a historical recommendation", () => {
    const list = RecommendationListSchema.parse({
      recommendationListId: "10000000-0000-4000-8000-000000000001", targetId: "10000000-0000-4000-8000-000000000002", localDate: "2026-09-01", sequence: 1, createdAt: "2026-09-01T00:00:00.000Z", items: [],
      exclusions: Array.from({ length: 11 }, (_, index) => ({ opportunityId: `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`, reasonCode: "TRIAGE_NOT_PASS" })),
    });
    expect(list.exclusions).toHaveLength(11);
  });

  it("defines opaque cursors for complete recommendation history and exclusions", () => {
    const item = RecommendationListSchema.parse({
      recommendationListId: "10000000-0000-4000-8000-000000000001", targetId: "00000000-0000-4000-8000-000000000001", localDate: "2026-09-01", sequence: 1, createdAt: "2026-09-01T00:00:00.000Z", exclusions: [], items: [],
    });

    expect(RecommendationListHistoryPageSchema.parse({ items: [item], nextCursor: item.recommendationListId })).toMatchObject({ nextCursor: item.recommendationListId });
    expect(RecommendationExclusionPageSchema.parse({ items: [{ opportunityId: "30000000-0000-4000-8000-000000000001", reasonCode: "TRIAGE_NOT_PASS" }], nextCursor: null })).toMatchObject({ nextCursor: null });
  });

  it("rejects error payloads without a request id", () => {
    expect(ApiProblemSchema.safeParse({ code: "AUTH_REQUIRED", message: "请先登录" }).success)
      .toBe(false);
  });

  it("accepts the task-control workbench summary and rejects unsafe counts", () => {
    expect(WorkbenchHomeSchema.parse({
      account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
      summary: {
        todayRecommendations: 2,
        pendingFacts: 1,
        activeAgentRuns: 3,
        failedAgentRuns: 1,
        sourceFailures: 2,
        pendingDecisions: 2,
        applications: 0,
        applicationsAvailable: false,
      },
      firstRecommendationJourney: { status: "completed", steps: [], currentStepId: null, completedAt: "2026-09-06T12:00:00.000Z" },
    }).summary.todayRecommendations).toBe(2);

    for (const todayRecommendations of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(WorkbenchHomeSchema.safeParse({
        account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
        summary: {
          todayRecommendations,
          pendingFacts: 0,
          activeAgentRuns: 0,
          failedAgentRuns: 0,
          sourceFailures: 0,
          pendingDecisions: 0,
          applications: 0,
          applicationsAvailable: false,
        },
        firstRecommendationJourney: { status: "completed", steps: [], currentStepId: null, completedAt: "2026-09-06T12:00:00.000Z" },
      }).success).toBe(false);
    }
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
