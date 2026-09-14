import "reflect-metadata";
import { HttpStatus } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { AccountRunAdmissionError } from "@job-copilot/domain/account-run-control";
import { RecommendationRunError } from "@job-copilot/domain/recommendation-runs";
import { RunPreflightRejectedError } from "@job-copilot/domain/run-preflight";
import { RecommendationRunPreparationSchema, RecommendationRunSchema } from "@job-copilot/contracts/recommendation-runs";
import { RecommendationListSchema } from "@job-copilot/contracts/recommendations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodSerializerInterceptor, ZodValidationPipe } from "nestjs-zod";
import { RecommendationRunsModule } from "./recommendation-runs.module.js";
import { RecommendationsModule } from "../recommendations/recommendations.module.js";
import { configureApiApplication } from "../configure-api-application.js";
import { ApiProblemFilter } from "../common/api-problem.filter.js";
import { RequestIdHook } from "../common/request-id.hook.js";
import { DATABASE, RUNTIME_CONFIG } from "../config/runtime-config.module.js";
import { ACCOUNT_SESSIONS } from "../auth/auth.tokens.js";
import { AGENT_RUN_QUEUE_PORT, RECOMMENDATION_RUN_COMMANDS, RECOMMENDATION_RUN_QUERIES } from "../agent-runs/agent-runs.tokens.js";
import { RUN_PREFLIGHT_EVALUATOR } from "../run-preflight/run-preflight.tokens.js";
import { RECOMMENDATION_RUN_PREPARATION_QUERIES } from "./recommendation-runs.tokens.js";
import { RECOMMENDATION_FEEDBACK_COMMANDS, RECOMMENDATION_FEEDBACK_QUERIES, RECOMMENDATION_QUERIES, RECOMMENDATION_RUN_STARTER } from "../recommendations/recommendations.tokens.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const sessionToken = "a".repeat(43);
const requestHeaders = { authorization: `Bearer ${sessionToken}` };
const timestamp = "2026-09-14T00:00:00.000Z";
const budget = { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 };

const readyReport = {
  version: "run-preflight-v1" as const,
  workflow: "recommendation" as const,
  trigger: "manual" as const,
  targetId,
  status: "ready" as const,
  warningFingerprint: null,
  checkedAt: timestamp,
  items: [],
};

const blockedReport = {
  ...readyReport,
  status: "blocked" as const,
  items: [{
    code: "PRIMARY_JOB_TARGET_MISSING" as const,
    severity: "blocking" as const,
    summary: "缺少活动主目标",
    impact: "请先设置一个活动主求职目标。",
    retryable: false,
    suggestedActions: ["review_job_targets" as const],
    evidence: { kind: "job_target" as const, primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing" as const, checkedAt: timestamp },
  }],
};

const warningReport = {
  ...readyReport,
  status: "ready_with_warnings" as const,
  warningFingerprint: "b".repeat(64),
  items: [{
    code: "SOURCE_HEALTH_UNCHECKED" as const,
    severity: "warning" as const,
    summary: "来源尚未完成健康检查",
    impact: "运行可以继续，建议稍后查看来源健康状态。",
    retryable: true,
    suggestedActions: ["review_source_health" as const],
    evidence: { kind: "source_health" as const, checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null },
  }],
};

const run = RecommendationRunSchema.parse({
  runId,
  status: "queued",
  currentStage: "discovery",
  stages: ["discovery", "qualification", "coarse_ranking", "deep_matching", "result_publication"].map((key) => ({ key, status: "pending", startedAt: null, completedAt: null })),
  target: { targetId, targetVersion: 1, roleFamily: "后端工程师" },
  sourceScope: { trustedSourceCount: 0, publicQueryCount: 0 },
  accountPolicyRevisionNumber: 1,
  budgets: { discovery: budget, deepMatch: budget },
  preflightSnapshot: readyReport,
  result: null,
  failure: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const preparation = RecommendationRunPreparationSchema.parse({
  target: run.target,
  sourceScope: run.sourceScope,
  accountPolicyRevisionNumber: 1,
  budgets: run.budgets,
  preflight: readyReport,
});

const recommendationList = RecommendationListSchema.parse({
  recommendationListId: "00000000-0000-4000-8000-000000000020",
  targetId,
  localDate: "2026-09-14",
  sequence: 1,
  createdAt: timestamp,
  exclusions: [],
  items: [],
});

function expectNoStore(response: { headers: Record<string, unknown> }) {
  expect(response.headers["cache-control"]).toBe("no-store");
}

function apiProviders() {
  return [
    RequestIdHook,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
    { provide: APP_FILTER, useClass: ApiProblemFilter },
  ];
}

describe("RecommendationRunsModule 的真实 Fastify HTTP 边界", () => {
  let app: NestFastifyApplication;
  let startFailure: Error | null = null;
  let controlFailure: Error | null = null;
  let reused = false;
  let startCalls = 0;
  const originalAppEnv = process.env.APP_ENV;

  beforeAll(async () => {
    process.env.APP_ENV = "test";
    const commands = {
      async start() {
        startCalls += 1;
        if (startFailure) throw startFailure;
        return { run, reused };
      },
      async control() {
        if (controlFailure) throw controlFailure;
        return { applied: true, run };
      },
    };
    const module = await Test.createTestingModule({ imports: [RecommendationRunsModule], providers: apiProviders() })
      .overrideProvider(DATABASE).useValue({})
      .overrideProvider(RUNTIME_CONFIG).useValue({ APP_ENV: "test", AUTH_MODE: "dev", DEV_AUTH_SHARED_SECRET: "x".repeat(32), openAi: { lowCostModel: "test", highQualityModel: "test" } })
      .overrideProvider(ACCOUNT_SESSIONS).useValue({ authenticateSession: async ({ sessionToken: token }: { sessionToken: string }) => token === sessionToken ? { userId: ownerId } : null })
      .overrideProvider(AGENT_RUN_QUEUE_PORT).useValue({ enqueue: async () => {} })
      .overrideProvider(RUN_PREFLIGHT_EVALUATOR).useValue({ evaluate: async () => ({ report: readyReport }) })
      .overrideProvider(RECOMMENDATION_RUN_COMMANDS).useValue(commands)
      .overrideProvider(RECOMMENDATION_RUN_QUERIES).useValue({ latest: async () => run, latestPublished: async () => run, get: async ({ runId: requestedRunId }: { runId: string }) => requestedRunId === runId ? run : null })
      .overrideProvider(RECOMMENDATION_RUN_PREPARATION_QUERIES).useValue({ prepare: async () => preparation })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApiApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  });

  it("装配真实模块后，静态 preparation/latest/latest-result 路由在动态 runId 前返回严格响应", async () => {
    const [preparationResponse, latestResponse, latestResultResponse] = await Promise.all([
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/recommendation-runs/preparation", headers: requestHeaders }),
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/recommendation-runs/latest", headers: requestHeaders }),
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/recommendation-runs/latest-result", headers: requestHeaders }),
    ]);

    expect(preparationResponse.statusCode).toBe(200);
    expect(preparationResponse.json()).toEqual({ preparation });
    expect(latestResponse.statusCode).toBe(200);
    expect(latestResponse.json()).toEqual({ run });
    expect(latestResultResponse.statusCode).toBe(200);
    expect(latestResultResponse.json()).toEqual({ run });
    for (const response of [preparationResponse, latestResponse, latestResultResponse]) expectNoStore(response);
  });

  it("启动首次创建为 201，重放或活动复用为 200，且严格拒绝浏览器越权字段", async () => {
    const command = { idempotencyKey: "00000000-0000-4000-8000-000000000010", warningFingerprint: null };
    reused = false;
    const created = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/v1/recommendation-runs", headers: { ...requestHeaders, "content-type": "application/json" }, payload: command });
    reused = true;
    const replayed = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/v1/recommendation-runs", headers: { ...requestHeaders, "content-type": "application/json" }, payload: command });
    const callsBeforeInvalid = startCalls;
    const invalid = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/v1/recommendation-runs", headers: { ...requestHeaders, "content-type": "application/json" }, payload: { ...command, userId: "00000000-0000-4000-8000-000000000011", targetId } });

    expect(created.statusCode).toBe(HttpStatus.CREATED);
    expect(created.json()).toEqual({ run, reused: false });
    expect(replayed.statusCode).toBe(HttpStatus.OK);
    expect(replayed.json()).toEqual({ run, reused: true });
    expect(invalid.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(startCalls).toBe(callsBeforeInvalid);
    for (const response of [created, replayed, invalid]) expectNoStore(response);
  });

  it("将隐藏读取、控制冲突、账户停止和预检拒绝投影为安全的 404/409，并保留最新合法报告", async () => {
    const missing = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/recommendation-runs/00000000-0000-4000-8000-000000000099", headers: requestHeaders });
    controlFailure = new RecommendationRunError("RECOMMENDATION_RUN_CONTROL_CONFLICT");
    const controlConflict = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: `/v1/recommendation-runs/${runId}/controls`, headers: { ...requestHeaders, "content-type": "application/json" }, payload: { commandId: "00000000-0000-4000-8000-000000000012", action: "pause" } });
    controlFailure = new RecommendationRunError("RECOMMENDATION_RUN_COMMAND_ID_CONFLICT");
    const commandIdConflict = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: `/v1/recommendation-runs/${runId}/controls`, headers: { ...requestHeaders, "content-type": "application/json" }, payload: { commandId: "00000000-0000-4000-8000-000000000018", action: "pause" } });
    controlFailure = new AccountRunAdmissionError("ACCOUNT_RUN_STOPPED");
    const stopped = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: `/v1/recommendation-runs/${runId}/controls`, headers: { ...requestHeaders, "content-type": "application/json" }, payload: { commandId: "00000000-0000-4000-8000-000000000013", action: "pause" } });
    startFailure = new RunPreflightRejectedError("RUN_PREFLIGHT_BLOCKED", blockedReport);
    const blocked = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/v1/recommendation-runs", headers: { ...requestHeaders, "content-type": "application/json" }, payload: { idempotencyKey: "00000000-0000-4000-8000-000000000014", warningFingerprint: null } });
    startFailure = new RunPreflightRejectedError("RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", warningReport);
    const warning = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/v1/recommendation-runs", headers: { ...requestHeaders, "content-type": "application/json" }, payload: { idempotencyKey: "00000000-0000-4000-8000-000000000015", warningFingerprint: null } });
    startFailure = null;
    controlFailure = null;

    expect(missing.json()).toMatchObject({ code: "RECOMMENDATION_RUN_NOT_FOUND", message: "推荐运行不存在" });
    expect(missing.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(controlConflict.json()).toMatchObject({ code: "RECOMMENDATION_RUN_CONTROL_CONFLICT", message: expect.stringMatching(/推荐运行状态/) });
    expect(controlConflict.statusCode).toBe(HttpStatus.CONFLICT);
    expect(commandIdConflict.json()).toMatchObject({ code: "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT", message: expect.stringMatching(/推荐运行状态/) });
    expect(commandIdConflict.statusCode).toBe(HttpStatus.CONFLICT);
    expect(stopped.json()).toMatchObject({ code: "ACCOUNT_RUN_STOPPED", message: "账户已停止全部运行，请先解除全局停止" });
    expect(stopped.statusCode).toBe(HttpStatus.CONFLICT);
    expect(blocked.json()).toMatchObject({ code: "RUN_PREFLIGHT_BLOCKED", preflight: blockedReport });
    expect(blocked.statusCode).toBe(HttpStatus.CONFLICT);
    expect(warning.json()).toMatchObject({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", preflight: warningReport });
    expect(warning.statusCode).toBe(HttpStatus.CONFLICT);
    for (const response of [missing, controlConflict, commandIdConflict, stopped, blocked, warning]) expectNoStore(response);
  });

  it("控制成功、未认证和未知异常均经真实 HTTP 边界处理且不泄露异常内容", async () => {
    const success = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: `/v1/recommendation-runs/${runId}/controls`, headers: { ...requestHeaders, "content-type": "application/json" }, payload: { commandId: "00000000-0000-4000-8000-000000000016", action: "resume" } });
    const unauthorized = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/recommendation-runs/latest" });
    const sentinel = "recommendation-run-secret-sentinel";
    startFailure = new Error(sentinel);
    const unknown = await app.getHttpAdapter().getInstance().inject({ method: "POST", url: "/v1/recommendation-runs", headers: { ...requestHeaders, "content-type": "application/json" }, payload: { idempotencyKey: "00000000-0000-4000-8000-000000000017", warningFingerprint: null } });
    startFailure = null;

    expect(success.statusCode).toBe(HttpStatus.OK);
    expect(success.json()).toEqual({ applied: true, run });
    expect(unauthorized.statusCode).toBe(HttpStatus.UNAUTHORIZED);
    expect(unknown.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(unknown.json()).toMatchObject({ code: "INTERNAL_ERROR", message: "服务暂时不可用" });
    expect(unknown.body).not.toContain(sentinel);
    for (const response of [success, unauthorized, unknown]) expectNoStore(response);
  });
});

describe("RecommendationsModule 的精确清单 HTTP 边界", () => {
  let app: NestFastifyApplication;
  const listId = "00000000-0000-4000-8000-000000000020";
  const receivedInputs: unknown[] = [];
  const originalAppEnv = process.env.APP_ENV;

  beforeAll(async () => {
    process.env.APP_ENV = "test";
    const module = await Test.createTestingModule({ imports: [RecommendationsModule], providers: apiProviders() })
      .overrideProvider(DATABASE).useValue({})
      .overrideProvider(RUNTIME_CONFIG).useValue({ APP_ENV: "test", AUTH_MODE: "dev", DEV_AUTH_SHARED_SECRET: "x".repeat(32), openAi: { lowCostModel: "test", highQualityModel: "test" } })
      .overrideProvider(ACCOUNT_SESSIONS).useValue({ authenticateSession: async ({ sessionToken: token }: { sessionToken: string }) => token === sessionToken ? { userId: ownerId } : null })
      .overrideProvider(AGENT_RUN_QUEUE_PORT).useValue({ enqueue: async () => {} })
      .overrideProvider(RUN_PREFLIGHT_EVALUATOR).useValue({ evaluate: async () => ({ report: readyReport }) })
      .overrideProvider(RECOMMENDATION_RUN_COMMANDS).useValue({ start: async () => ({ run, reused: false }), control: async () => ({ applied: true, run }) })
      .overrideProvider(RECOMMENDATION_QUERIES).useValue({ getList: async (input: unknown) => { receivedInputs.push(input); return (input as { recommendationListId: string }).recommendationListId === listId ? recommendationList : null; }, getLatestList: async () => { throw new Error("exact-list route must not fall back to latest"); } })
      .overrideProvider(RECOMMENDATION_RUN_STARTER).useValue({ start: async () => ({}) })
      .overrideProvider(RECOMMENDATION_FEEDBACK_COMMANDS).useValue({})
      .overrideProvider(RECOMMENDATION_FEEDBACK_QUERIES).useValue({})
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApiApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  });

  it("按 owner、target 与 list id 精确读取，错配保持隐藏且认证/404 均不可缓存", async () => {
    const found = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/recommendations/lists/${listId}?targetId=${targetId}`, headers: requestHeaders });
    const hiddenListId = "00000000-0000-4000-8000-000000000021";
    const hidden = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/recommendations/lists/${hiddenListId}?targetId=${targetId}`, headers: requestHeaders });
    const unauthorized = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/recommendations/lists/${listId}?targetId=${targetId}` });

    expect(found.statusCode).toBe(HttpStatus.OK);
    expect(found.json()).toEqual(recommendationList);
    expect(hidden.statusCode).toBe(HttpStatus.NOT_FOUND);
    expect(hidden.json()).toMatchObject({ code: "RECOMMENDATION_LIST_NOT_FOUND", message: "推荐清单不存在" });
    expect(receivedInputs).toEqual([
      { userId: ownerId, targetId, recommendationListId: listId },
      { userId: ownerId, targetId, recommendationListId: hiddenListId },
    ]);
    expect(unauthorized.statusCode).toBe(HttpStatus.UNAUTHORIZED);
    expectNoStore(found);
    expectNoStore(hidden);
    expectNoStore(unauthorized);
  });
});
