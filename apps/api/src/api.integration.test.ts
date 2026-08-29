import { createHash, randomUUID } from "node:crypto";
import "reflect-metadata";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, candidateFactEvidence, candidateFacts, careerDocuments, careerFactConflicts, careerImports, createDatabase, migrateDatabase, type Database } from "@job-copilot/database";
import type { CareerDocumentStore, CareerImportQueue } from "@job-copilot/domain/career-imports";
import type { JobContentStore, JobImportQueue } from "@job-copilot/domain/job-imports";
import type { AgentRunQueue } from "@job-copilot/domain/agent-runs";
import { AppModule } from "./app.module.js";
import { configureApiApplication } from "./configure-api-application.js";
import { DATABASE } from "./config/runtime-config.module.js";
import { CAREER_DOCUMENT_STORE, CAREER_IMPORT_QUEUE } from "./career-import/career-import.tokens.js";
import { JOB_CONTENT_STORE, JOB_IMPORT_QUEUE, JOB_PAGE_FETCHER } from "./job-imports/job-imports.tokens.js";
import { JobPageFetchError, type JobPageFetcher } from "./job-imports/job-page-fetcher.js";
import { createMinimalDocx } from "./career-import/minimal-docx.test-support.js";
import { CAREER_FACT_CONFLICT_REVIEW_COMMANDS, PROFILE_REVIEW_COMMANDS, type ProfileReviewCommands } from "./profile-review/profile-review.tokens.js";
import { AGENT_RUN_QUEUE_PORT } from "./agent-runs/agent-runs.tokens.js";
import { z } from "zod";

const testSecret = "test-dev-auth-shared-secret-must-be-at-least-32-characters";
const capturedLogs: unknown[][] = [];
const recordLog = (...args: unknown[]) => { capturedLogs.push(args); };
const testLogger = {
  child: () => testLogger,
  info: recordLog,
  error: recordLog,
  debug: recordLog,
  fatal: recordLog,
  warn: recordLog,
  trace: recordLog,
};

describe("authenticated workbench HTTP API", () => {
  let app: NestFastifyApplication;
  let container: StartedPostgreSqlContainer;
  let database: Database;
  let conflictResolutionResponse: unknown = undefined;
  const conflictReviewCommands = {
    resolve: async () => conflictResolutionResponse,
  };
  const storedObjects = new Map<string, Uint8Array>();
  const queue: CareerImportQueue & { failNext: boolean; jobs: unknown[] } = {
    failNext: false,
    jobs: [],
    async enqueue(job) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("queue unavailable with resume@example.com");
      }
      this.jobs.push(job);
    },
  };
  const documentStore: CareerDocumentStore = {
    async put({ objectKey, bytes }) { storedObjects.set(objectKey, bytes); },
    async get({ objectKey }) {
      const bytes = storedObjects.get(objectKey);
      if (!bytes) throw Object.assign(new Error("not found"), { code: "CAREER_DOCUMENT_NOT_FOUND" });
      return bytes;
    },
  };
  const jobStoredObjects = new Map<string, Uint8Array>();
  const jobQueue: JobImportQueue & { jobs: unknown[]; failNext: boolean } = {
    jobs: [],
    failNext: false,
    async enqueue(job) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("job queue unavailable with private-job@example.test");
      }
      this.jobs.push(job);
    },
  };
  const agentRunQueue: AgentRunQueue & { jobs: unknown[]; failNext: boolean } = {
    jobs: [],
    failNext: false,
    async enqueue(job) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("agent queue unavailable with private-agent@example.test");
      }
      this.jobs.push(job);
    },
  };
  const jobContentStore: JobContentStore & { failNextPut: boolean } = {
    failNextPut: false,
    async put({ objectKey, bytes }) {
      if (this.failNextPut) {
        this.failNextPut = false;
        throw new Error("job storage unavailable with private-job@example.test");
      }
      jobStoredObjects.set(objectKey, bytes);
    },
    async get({ objectKey }) {
      const bytes = jobStoredObjects.get(objectKey);
      if (!bytes) throw new Error("job source not found");
      return bytes;
    },
    async delete({ objectKey }) { jobStoredObjects.delete(objectKey); },
  };
  const jobPageFetcher: JobPageFetcher & { nextError: JobPageFetchError | null } = {
    nextError: null,
    async fetch({ url }) {
      if (this.nextError) {
        const error = this.nextError;
        this.nextError = null;
        throw error;
      }
      return {
        requestedUrl: url, finalUrl: url, canonicalUrl: url, rawHtml: "<h1>URL 岗位</h1><script>never-run()</script>",
        visibleText: "URL 岗位\n公司：示例科技\n地点：上海", pageClassification: "job", sourceKind: "official",
      };
    },
  };
  const originalEnvironment = {
    APP_ENV: process.env.APP_ENV,
    AUTH_MODE: process.env.AUTH_MODE,
    DEV_AUTH_SHARED_SECRET: process.env.DEV_AUTH_SHARED_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
    Object.assign(process.env, {
      APP_ENV: "test",
      AUTH_MODE: "dev",
      DEV_AUTH_SHARED_SECRET: testSecret,
      DATABASE_URL: container.getConnectionUri(),
    });

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CAREER_DOCUMENT_STORE).useValue(documentStore)
      .overrideProvider(CAREER_IMPORT_QUEUE).useValue(queue)
      .overrideProvider(JOB_CONTENT_STORE).useValue(jobContentStore)
      .overrideProvider(JOB_IMPORT_QUEUE).useValue(jobQueue)
      .overrideProvider(JOB_PAGE_FETCHER).useValue(jobPageFetcher)
      .overrideProvider(AGENT_RUN_QUEUE_PORT).useValue(agentRunQueue)
      .overrideProvider(CAREER_FACT_CONFLICT_REVIEW_COMMANDS).useValue(conflictReviewCommands)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ loggerInstance: testLogger as never }));
    await configureApiApplication(app);
    await app.init();
    expect(app.get(CAREER_IMPORT_QUEUE)).toBe(queue);
    expect(app.get(CAREER_DOCUMENT_STORE)).toBe(documentStore);
    expect(app.get(JOB_IMPORT_QUEUE)).toBe(jobQueue);
    expect(app.get(JOB_CONTENT_STORE)).toBe(jobContentStore);
    expect(app.get(AGENT_RUN_QUEUE_PORT)).toBe(agentRunQueue);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await app?.get<Database>(DATABASE).$client.end();
    await database?.$client.end();
    await container?.stop();
    Object.assign(process.env, originalEnvironment);
  });

  it("expands Error values before checking captured logger output", () => {
    const messageSentinel = "message-sentinel";
    const stackSentinel = "stack-sentinel";
    const causeSentinel = "cause-sentinel";
    const nestedErrorSentinel = "nested-error-sentinel";
    const error = new Error(messageSentinel, { cause: new Error(causeSentinel) });
    error.stack = stackSentinel;
    const hiddenByJson = JSON.stringify([error, { err: error }]);
    expect(hiddenByJson).not.toContain(messageSentinel);
    expect(hiddenByJson).not.toContain(stackSentinel);
    expect(hiddenByJson).not.toContain(causeSentinel);

    const normalizedError = normalizedLogText([{ err: error }]);
    expect(normalizedError).toContain(messageSentinel);
    expect(normalizedError).toContain(stackSentinel);
    expect(normalizedError).toContain(causeSentinel);

    const circular: { err: Error; self?: unknown } = { err: new Error(nestedErrorSentinel) };
    circular.self = circular;
    expect(normalizedLogText([circular])).toContain(nestedErrorSentinel);
    expect(normalizedLogText([circular])).toContain("[Circular]");
  });

  it("creates and reuses an internal account through dev auth", async () => {
    const first = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/dev/sessions",
      headers: { "x-dev-auth-secret": testSecret },
      payload: { subject: "local-primary" },
    });
    const second = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/dev/sessions",
      headers: { "x-dev-auth-secret": testSecret },
      payload: { subject: "local-primary" },
    });

    expect(first.statusCode).toBe(201);
    expect(first.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.json().account.userId).toBe(first.json().account.userId);
    expect(second.json().sessionToken).not.toBe(first.json().sessionToken);
  });

  it("hides dev auth behind the server secret", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/dev/sessions",
      headers: { "x-dev-auth-secret": "wrong-secret" },
      payload: { subject: "local-primary" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      code: "DEV_AUTH_DISABLED",
      message: "Dev Auth 不可用",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  it("rejects malformed dev auth input without exposing validation details", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/auth/dev/sessions",
      headers: { "x-dev-auth-secret": testSecret },
      payload: { subject: "local-primary", extra: "untrusted" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "请求无效",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  it("通过真实 HTTP 序列化器拒绝残缺的职业事实冲突解决响应", async () => {
    const session = await createSession(app, "conflict-response-serializer");
    conflictResolutionResponse = {
      profile: { profileId: null, version: 1, facts: [] },
      // 缺少 API 契约要求的 conflict，必须由 ZodSerializerInterceptor 而非 controller 直接调用拦截。
    };

    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/career-documents/fact-conflicts/98ff2891-df0c-4e35-a95d-44f1be3fbdb7/resolutions",
      headers: bearer(session.sessionToken),
      payload: { expectedVersion: 0, resolution: "use_existing" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: "INTERNAL_ERROR",
      message: "服务暂时不可用",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
  });

  it("returns only the authenticated account workbench", async () => {
    const primary = await createSession(app, "local-primary");
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/workbench/home",
      headers: bearer(primary.sessionToken),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.json()).toEqual({
      account: { userId: primary.account.userId },
      summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
    });
  });

  it("creates one manual profile fact and rejects a stale profile version", async () => {
    const session = await createSession(app, "profile-review-manual");
    const empty = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: "/v1/profile", headers: bearer(session.sessionToken),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ profileId: null, version: 0, facts: [] });

    const created = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/profile/facts", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 0, factType: "work_eligibility", factValue: { summary: "中国大陆，可合法工作" } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ version: 1, facts: [{ factType: "work_eligibility", source: "user_confirmed" }] });

    const stale = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/profile/facts", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 0, factType: "skill", factValue: { name: "TypeScript" } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "PROFILE_VERSION_CONFLICT", requestId: expect.any(String) });
    expect(stale.body).not.toContain("TypeScript");
  });

  it("maps an invalid manual profile fact body to the standard invalid-request problem", async () => {
    const session = await createSession(app, "profile-review-invalid-body");
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/profile/facts", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 0, factType: "language", factValue: { name: "" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST", message: "请求无效", requestId: expect.any(String) });
    expect(response.body).not.toContain("ZodError");
  });

  it("维护认证账户的求职目标，并隐藏约束与跨账户资源", async () => {
    const primary = await createSession(app, "job-targets-primary");
    const other = await createSession(app, "job-targets-other");
    const profileFact = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/profile/facts", headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 0, factType: "skill", factValue: { name: "React TypeScript" } },
    });
    expect(profileFact.statusCode).toBe(201);

    const suggested = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: "/v1/job-targets", headers: bearer(primary.sessionToken),
    });
    expect(suggested.statusCode).toBe(200);
    expect(suggested.json()).toMatchObject({ suggestions: expect.arrayContaining([
      expect.objectContaining({ roleFamily: "前端工程师" }),
    ]), targets: [] });

    const primaryTarget = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-targets", headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { priority: "primary", constraints: jobTargetConstraints("前端工程师") },
    });
    expect(primaryTarget.statusCode).toBe(201);
    const targetId = primaryTarget.json().targets[0].targetId as string;

    const secondaryOne = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-targets", headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { priority: "secondary", constraints: jobTargetConstraints("全栈工程师") },
    });
    const secondaryTwo = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-targets", headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { priority: "secondary", constraints: jobTargetConstraints("AI 应用工程师") },
    });
    expect(secondaryOne.statusCode).toBe(201);
    expect(secondaryTwo.statusCode).toBe(201);

    const primaryLimit = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-targets", headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { priority: "primary", constraints: jobTargetConstraints("秘密主目标", "secret-primary-limit-company") },
    });
    const secondaryLimit = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-targets", headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { priority: "secondary", constraints: jobTargetConstraints("秘密次目标", "secret-secondary-limit-company") },
    });
    expect(primaryLimit.statusCode).toBe(409);
    expect(primaryLimit.json()).toMatchObject({ code: "JOB_TARGET_PRIMARY_LIMIT", requestId: expect.any(String) });
    expect(primaryLimit.body).not.toContain("secret-primary-limit-company");
    expect(secondaryLimit.statusCode).toBe(409);
    expect(secondaryLimit.json()).toMatchObject({ code: "JOB_TARGET_SECONDARY_LIMIT", requestId: expect.any(String) });
    expect(secondaryLimit.body).not.toContain("secret-secondary-limit-company");

    const revised = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: `/v1/job-targets/${targetId}/revisions`, headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 1, priority: "primary", constraints: jobTargetConstraints("高级前端工程师") },
    });
    expect(revised.statusCode).toBe(201);
    expect(revised.json().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId, version: 2, priority: "primary", state: "active", constraints: expect.objectContaining({ roleFamily: "高级前端工程师" }) }),
    ]));

    const versionConflict = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: `/v1/job-targets/${targetId}/revisions`, headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 1, priority: "primary", constraints: jobTargetConstraints("secret-stale-role", "secret-stale-company") },
    });
    expect(versionConflict.statusCode).toBe(409);
    expect(versionConflict.json()).toMatchObject({ code: "JOB_TARGET_VERSION_CONFLICT", requestId: expect.any(String) });
    expect(versionConflict.body).not.toContain("secret-stale-company");

    const reloaded = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: "/v1/job-targets", headers: bearer(primary.sessionToken),
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json().targets).toHaveLength(3);

    const deactivated = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: `/v1/job-targets/${targetId}/deactivations`, headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 2 },
    });
    expect(deactivated.statusCode).toBe(201);
    expect(deactivated.json().targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId, version: 3, state: "inactive" }),
    ]));

    const hidden = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: `/v1/job-targets/${targetId}/revisions`, headers: { ...bearer(other.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 3, priority: "primary", constraints: jobTargetConstraints("其他账户目标") },
    });
    const invalidPath = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-targets/not-a-uuid/revisions", headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 3, priority: "primary", constraints: jobTargetConstraints("无效路径") },
    });
    const invalidBody = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-targets", headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { priority: "primary", constraints: { roleFamily: "" } },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: "JOB_TARGET_NOT_FOUND", requestId: expect.any(String) });
    expect(invalidPath.statusCode).toBe(400);
    expect(invalidPath.json()).toMatchObject({ code: "INVALID_REQUEST", message: "请求无效", requestId: expect.any(String) });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json()).toMatchObject({ code: "INVALID_REQUEST", message: "请求无效", requestId: expect.any(String) });
    expect(invalidBody.body).not.toContain("ZodError");
  });

  it("以持久化运行提供幂等且账户隔离的岗位发现入口", async () => {
    const primary = await createSession(app, "agent-runs-primary");
    const other = await createSession(app, "agent-runs-other");
    const primaryTarget = await createActiveTarget(app, primary.sessionToken, "前端工程师");
    const otherTarget = await createActiveTarget(app, other.sessionToken, "全栈工程师");
    const inactiveTarget = await createActiveTarget(app, primary.sessionToken, "AI 应用工程师", "secondary");
    const deactivated = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: `/v1/job-targets/${inactiveTarget}/deactivations`,
      headers: { ...bearer(primary.sessionToken), "content-type": "application/json" },
      payload: { expectedVersion: 1 },
    });
    expect(deactivated.statusCode).toBe(201);

    const unauthenticated = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/agent-runs",
      payload: { targetId: primaryTarget, idempotencyKey: randomUUID() },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const invalid = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/agent-runs", headers: bearer(primary.sessionToken),
      payload: { targetId: primaryTarget, idempotencyKey: randomUUID(), rawJobDescription: "secret" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("secret");

    for (const targetId of [otherTarget, inactiveTarget]) {
      const hidden = await app.getHttpAdapter().getInstance().inject({
        method: "POST", url: "/v1/agent-runs", headers: bearer(primary.sessionToken),
        payload: { targetId, idempotencyKey: randomUUID() },
      });
      expect(hidden.statusCode).toBe(404);
    }

    const idempotencyKey = randomUUID();
    const created = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/agent-runs", headers: bearer(primary.sessionToken),
      payload: { targetId: primaryTarget, idempotencyKey },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ targetId: primaryTarget, status: "queued", reused: false });
    const runId = created.json().runId as string;

    const reused = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/agent-runs", headers: bearer(primary.sessionToken),
      payload: { targetId: otherTarget, idempotencyKey },
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json()).toMatchObject({ runId, targetId: primaryTarget, reused: true });
    expect(agentRunQueue.jobs.slice(-2)).toEqual([
      { version: 1, runId, userId: primary.account.userId },
      { version: 1, runId, userId: primary.account.userId },
    ]);
    expect(JSON.stringify(agentRunQueue.jobs.slice(-2))).not.toMatch(/targetSnapshot|description|rawPayload/);

    const [latest, detail, hiddenDetail, otherLatest] = await Promise.all([
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/agent-runs/latest", headers: bearer(primary.sessionToken) }),
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/agent-runs/${runId}`, headers: bearer(primary.sessionToken) }),
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/agent-runs/${runId}`, headers: bearer(other.sessionToken) }),
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/agent-runs/latest", headers: bearer(other.sessionToken) }),
    ]);
    expect(latest.statusCode).toBe(200);
    expect(latest.json().run.runId).toBe(runId);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ runId, events: [{ sequence: 1, eventType: "run.queued" }] });
    expect(hiddenDetail.statusCode).toBe(404);
    expect(otherLatest.statusCode).toBe(200);
    expect(otherLatest.json()).toEqual({ run: null });

    const [unauthenticatedEvents, hiddenEvents, invalidCursor] = await Promise.all([
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/agent-runs/${runId}/events` }),
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/agent-runs/${runId}/events`, headers: bearer(other.sessionToken) }),
      app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/agent-runs/${runId}/events?afterEventId=invalid`, headers: bearer(primary.sessionToken) }),
    ]);
    expect(unauthenticatedEvents.statusCode).toBe(401);
    expect(hiddenEvents.statusCode).toBe(404);
    expect(invalidCursor.statusCode).toBe(400);
    for (const response of [unauthenticatedEvents, hiddenEvents, invalidCursor]) {
      expect(response.headers["content-type"]).not.toContain("text/event-stream");
    }

    agentRunQueue.failNext = true;
    const durable = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/agent-runs", headers: bearer(primary.sessionToken),
      payload: { targetId: primaryTarget, idempotencyKey: randomUUID() },
    });
    expect(durable.statusCode).toBe(201);
    expect(durable.json()).toMatchObject({ status: "queued", reused: false });
  });

  it("keeps a command-side Zod error as an internal error rather than blaming the request", async () => {
    const session = await createSession(app, "profile-review-command-zod-error");
    const commands = app.get<ProfileReviewCommands>(PROFILE_REVIEW_COMMANDS);
    const originalCreateFact = commands.createFact;
    commands.createFact = async () => { throw new z.ZodError([]); };
    try {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: "POST", url: "/v1/profile/facts", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
        payload: { expectedVersion: 0, factType: "skill", factValue: { name: "TypeScript" } },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "INTERNAL_ERROR", message: "服务暂时不可用", requestId: expect.any(String) });
    } finally {
      commands.createFact = originalCreateFact;
    }
  });

  it("hides a different account resource", async () => {
    const primary = await createSession(app, "local-primary");
    const secondary = await createSession(app, "local-secondary");
    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: `/v1/accounts/${primary.account.userId}`,
      headers: bearer(secondary.sessionToken),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("ACCOUNT_NOT_FOUND");
    expect(response.json().requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(database.select({
      eventType: auditEvents.eventType,
      userId: auditEvents.userId,
      actorUserId: auditEvents.actorUserId,
      resourceId: auditEvents.resourceId,
      outcome: auditEvents.outcome,
    }).from(auditEvents)).resolves.toContainEqual({
      eventType: "account.access_rejected",
      userId: secondary.account.userId,
      actorUserId: secondary.account.userId,
      resourceId: primary.account.userId,
      outcome: "denied",
    });
  });

  it("keeps a revoked session unusable", async () => {
    const primary = await createSession(app, "local-primary");
    const logout = await app.getHttpAdapter().getInstance().inject({
      method: "DELETE",
      url: "/v1/auth/sessions/current",
      headers: bearer(primary.sessionToken),
    });
    const rejected = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: "/v1/workbench/home",
      headers: bearer(primary.sessionToken),
    });
    const repeatedLogout = await app.getHttpAdapter().getInstance().inject({
      method: "DELETE",
      url: "/v1/auth/sessions/current",
      headers: bearer(primary.sessionToken),
    });

    expect(logout.statusCode).toBe(204);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().code).toBe("AUTH_REQUIRED");
    expect(repeatedLogout.statusCode).toBe(401);
  });

  it("accepts one Markdown upload, reuses it, and never exposes source content in audit metadata", async () => {
    const session = await createSession(app, "career-import-primary");
    const protectedOriginal = "姓名：张三\n邮箱：resume@example.com\n## 技能\n- TypeScript";
    const source = "姓名：[姓名]\n邮箱：[邮箱]\n## 技能\n- TypeScript";
    const upload = await app.getHttpAdapter().getInstance().inject(multipartRequest(source, {
      headers: bearer(session.sessionToken), filename: "candidate.md",
      privacyMode: "retain_protected_original", protectedOriginal,
    }));
    const repeated = await app.getHttpAdapter().getInstance().inject(multipartRequest(source, {
      headers: bearer(session.sessionToken), filename: "renamed.md",
      privacyMode: "retain_protected_original", protectedOriginal,
    }));

    expect(upload.statusCode).toBe(202);
    expect(upload.json()).toMatchObject({
      status: "queued", reused: false, privacyStatus: "sanitized_with_protected_original",
      detailUrl: expect.stringMatching(/^\/v1\/career-documents\/imports\//),
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ importId: upload.json().importId, reused: true });
    const metadata = await database.select({ metadata: auditEvents.metadata }).from(auditEvents);
    expect(JSON.stringify(metadata)).not.toContain("resume@example.com");
    expect(JSON.stringify(metadata)).not.toContain("candidate.md");
    expect(JSON.stringify(metadata)).not.toContain(protectedOriginal);
    const logs = normalizedLogText(capturedLogs);
    expect(logs).not.toContain("resume@example.com");
    expect(logs).not.toContain("candidate.md");
    expect(logs).not.toContain(protectedOriginal);
  });

  it("保留含嵌入媒体的 DOCX 原件时仅保存脱敏处理副本", async () => {
    const session = await createSession(app, "career-import-media-docx");
    const rawDocx = await createMinimalDocx(["2024 AI 工程师"], { embeddedMedia: true });
    const processing = "2024 AI 工程师\n[照片或二维码]";
    const response = await app.getHttpAdapter().getInstance().inject(multipartRequest(processing, {
      headers: bearer(session.sessionToken),
      filename: "candidate.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      privacyMode: "retain_protected_original",
      protectedOriginal: rawDocx,
    }));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      sourceFormat: "docx",
      privacyStatus: "sanitized_with_protected_original",
    });
    const [processingEntry] = [...storedObjects.entries()].filter(([key]) => key.includes(response.json().documentId) && key.endsWith("/processing.txt"));
    const [protectedEntry] = [...storedObjects.entries()].filter(([key, bytes]) => key.endsWith("/original.docx") && Buffer.from(bytes).equals(Buffer.from(rawDocx)));
    expect(new TextDecoder().decode(processingEntry![1])).toBe(processing);
    expect(processingEntry![1]).not.toEqual(rawDocx);
    expect(protectedEntry![1]).toEqual(rawDocx);
  });

  it("returns 202 for a new import that reuses an owned document without an import", async () => {
    const session = await createSession(app, "career-import-document-only");
    const source = "## 技能\n- Existing document only";
    const sourceBytes = new TextEncoder().encode(source);
    const documentId = randomUUID();
    await database.insert(careerDocuments).values({
      id: documentId,
      userId: session.account.userId,
      checksumSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      objectKey: `accounts/${session.account.userId}/career-documents/${documentId}/source.md`,
      originalFilename: "existing.md",
      mediaType: "text/markdown",
      byteSize: sourceBytes.byteLength,
    });

    const response = await app.getHttpAdapter().getInstance().inject(multipartRequest(source, {
      headers: bearer(session.sessionToken), filename: "renamed.md",
    }));

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ documentId, status: "queued", reused: false });
  });

  it("在旧导入详情中返回双方职业事实冲突，供同一账户审核", async () => {
    const session = await createSession(app, "career-import-old-conflict");
    const oldDocumentId = randomUUID();
    const newDocumentId = randomUUID();
    const oldImportId = randomUUID();
    const newImportId = randomUUID();
    const existingFactId = randomUUID();
    const incomingFactId = randomUUID();
    const conflictId = randomUUID();
    const timestamp = new Date("2026-08-28T00:00:00.000Z");
    const factKey = (value: string) => createHash("sha256").update(value).digest("hex");
    await database.insert(careerDocuments).values([
      { id: oldDocumentId, userId: session.account.userId, checksumSha256: factKey(oldDocumentId), objectKey: `accounts/${session.account.userId}/career-documents/${oldDocumentId}/processing.md`, originalFilename: "career-one.md", sourceFormat: "markdown", mediaType: "text/markdown", byteSize: 20, createdAt: timestamp, updatedAt: timestamp },
      { id: newDocumentId, userId: session.account.userId, checksumSha256: factKey(newDocumentId), objectKey: `accounts/${session.account.userId}/career-documents/${newDocumentId}/processing.txt`, originalFilename: "career-two.docx", sourceFormat: "docx", mediaType: "text/plain", byteSize: 20, createdAt: timestamp, updatedAt: timestamp },
    ]);
    await database.insert(careerImports).values([
      { id: oldImportId, userId: session.account.userId, careerDocumentId: oldDocumentId, status: "completed", originatingRequestId: randomUUID(), queuedAt: timestamp, completedAt: timestamp, createdAt: timestamp, updatedAt: timestamp },
      { id: newImportId, userId: session.account.userId, careerDocumentId: newDocumentId, status: "completed", originatingRequestId: randomUUID(), queuedAt: timestamp, completedAt: timestamp, createdAt: timestamp, updatedAt: timestamp },
    ]);
    await database.insert(candidateFacts).values([
      { id: existingFactId, userId: session.account.userId, careerImportId: oldImportId, careerDocumentId: oldDocumentId, factKey: factKey(existingFactId), factType: "experience", factValue: { summary: "AI 工程师｜示例科技｜2023" }, confidenceBasisPoints: 9000, createdAt: timestamp },
      { id: incomingFactId, userId: session.account.userId, careerImportId: newImportId, careerDocumentId: newDocumentId, factKey: factKey(incomingFactId), factType: "experience", factValue: { summary: "AI 工程师｜示例科技｜2024" }, confidenceBasisPoints: 9000, createdAt: timestamp },
    ]);
    await database.insert(candidateFactEvidence).values([
      { id: randomUUID(), userId: session.account.userId, candidateFactId: existingFactId, careerDocumentId: oldDocumentId, locatorType: "markdown_lines", startLine: 2, endLine: 2, excerpt: "- AI 工程师｜示例科技｜2023", excerptSha256: factKey("old evidence"), createdAt: timestamp },
      { id: randomUUID(), userId: session.account.userId, candidateFactId: incomingFactId, careerDocumentId: newDocumentId, locatorType: "docx_paragraphs", startLine: 2, endLine: 2, excerpt: "AI 工程师｜示例科技｜2024", excerptSha256: factKey("new evidence"), createdAt: timestamp },
    ]);
    await database.insert(careerFactConflicts).values({ id: conflictId, userId: session.account.userId, existingCandidateFactId: existingFactId, incomingCandidateFactId: incomingFactId, kind: "date", status: "pending", createdAt: timestamp });

    const detail = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/career-documents/imports/${oldImportId}`, headers: bearer(session.sessionToken) });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      importId: oldImportId,
      sourceFilename: "career-one.md",
      conflicts: [{ conflictId, status: "pending", existingFact: { factId: existingFactId, evidence: { sourceFilename: "career-one.md", locatorType: "markdown_lines" } }, incomingFact: { factId: incomingFactId, evidence: { sourceFilename: "career-two.docx", locatorType: "docx_paragraphs" } } }],
    });
  });

  it.each([
    ["missing file", multipartRequest(undefined), "CAREER_DOCUMENT_REQUIRED", 400],
    ["multiple files", multipartRequest("## 技能\n- TypeScript", { extraFile: true }), "TOO_MANY_CAREER_DOCUMENTS", 400],
    ["wrong field", multipartRequest("## 技能\n- TypeScript", { fieldname: "document" }), "CAREER_DOCUMENT_REQUIRED", 400],
    ["extension", multipartRequest("## 技能\n- TypeScript", { filename: "resume.txt" }), "UNSUPPORTED_CAREER_DOCUMENT_TYPE", 400],
    ["mime", multipartRequest("## 技能\n- TypeScript", { mimetype: "application/pdf" }), "UNSUPPORTED_CAREER_DOCUMENT_TYPE", 400],
    ["too large", multipartRequest("x".repeat(524_289)), "CAREER_DOCUMENT_TOO_LARGE", 413],
    ["invalid utf8", multipartRequest(new Uint8Array([0xc3, 0x28])), "CAREER_DOCUMENT_INVALID_UTF8", 400],
    ["empty", multipartRequest(" \n\t"), "CAREER_DOCUMENT_EMPTY", 400],
    ["nul", multipartRequest(new Uint8Array([0x61, 0x00])), "CAREER_DOCUMENT_EMPTY", 400],
  ])("rejects career upload %s without source disclosure", async (_label, request, code, status) => {
    const session = await createSession(app, `career-import-invalid-${_label}`);
    const response = await app.getHttpAdapter().getInstance().inject({ ...request, headers: {
      ...request.headers, ...bearer(session.sessionToken),
    } });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code, requestId: expect.any(String) });
    expect(response.body).not.toContain("resume@example.com");
  });

  it("maps a multipart text field to a stable upload problem without plugin disclosure", async () => {
    const session = await createSession(app, "career-import-field-only");
    const response = await app.getHttpAdapter().getInstance().inject(multipartRequest("resume@example.com", {
      headers: bearer(session.sessionToken), fieldOnly: true,
    }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "CAREER_PRIVACY_DECISION_REQUIRED", requestId: expect.any(String) });
    expect(response.body).not.toContain("FST_FIELDS_LIMIT");
    expect(response.body).not.toContain("resume@example.com");
  });

  it("maps the multipart plugin field limit to a complete Chinese PDF upload message", async () => {
    const session = await createSession(app, "career-import-plugin-field-limit");
    const response = await app.getHttpAdapter().getInstance().inject(multipartRequest("## 技能\n- TypeScript", {
      headers: bearer(session.sessionToken), extraField: true,
    }));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "CAREER_DOCUMENT_REQUIRED",
      message: "请选择一份 Markdown、DOCX 或 PDF 职业资料",
      requestId: expect.any(String),
    });
  });

  it("protects import queries, limits list results, and hides cross-account details", async () => {
    const owner = await createSession(app, "career-import-owner");
    const other = await createSession(app, "career-import-other");
    const created = await app.getHttpAdapter().getInstance().inject(multipartRequest("## 技能\n- Owner", {
      headers: bearer(owner.sessionToken), filename: "owner.md",
    }));
    const importId = created.json().importId;
    for (let index = 0; index < 20; index += 1) {
      const upload = await app.getHttpAdapter().getInstance().inject(multipartRequest(`## 技能\n- Owner ${index}`, {
        headers: bearer(owner.sessionToken), filename: `owner-${index}.md`,
      }));
      expect(upload.statusCode).toBe(202);
    }
    const list = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/career-documents/imports", headers: bearer(owner.sessionToken) });
    const detail = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/career-documents/imports/${importId}`, headers: bearer(owner.sessionToken) });
    const malformed = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/career-documents/imports/not-a-uuid", headers: bearer(owner.sessionToken) });
    const hidden = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: `/v1/career-documents/imports/${importId}`, headers: bearer(other.sessionToken) });
    const anonymous = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/v1/career-documents/imports" });

    expect(list.statusCode).toBe(200);
    expect(list.json().imports).toHaveLength(20);
    expect(list.json().imports).toEqual(expect.arrayContaining([expect.objectContaining({ candidateFactCount: 0 })]));
    expect(list.json().imports.map((item: { createdAt: string }) => item.createdAt)).toEqual([
      ...list.json().imports.map((item: { createdAt: string }) => item.createdAt),
    ].sort().reverse());
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ importId, facts: [] });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "INVALID_REQUEST", requestId: expect.any(String) });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().code).toBe("CAREER_IMPORT_NOT_FOUND");
    expect(anonymous.statusCode).toBe(401);
  });

  it("maps an enqueue outage to a retryable 503 without leaking the underlying error", async () => {
    const session = await createSession(app, "career-import-queue-failure");
    capturedLogs.length = 0;
    const source = "## 技能\n- Retryable";
    queue.failNext = true;
    const response = await app.getHttpAdapter().getInstance().inject(multipartRequest(source, {
      headers: bearer(session.sessionToken), filename: "secret-resume.md",
    }));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "CAREER_IMPORT_QUEUE_UNAVAILABLE" });
    expect(response.body).not.toContain("resume@example.com");
    expect(response.body).not.toContain("queue unavailable");
    const requestLogs = [...capturedLogs];
    expect(requestLogs.length).toBeGreaterThan(0);
    const logs = normalizedLogText(requestLogs);
    expect(logs).not.toContain("secret-resume.md");
    expect(logs).not.toContain(source);
    expect(logs).not.toContain("queue unavailable with resume@example.com");
    const retry = await app.getHttpAdapter().getInstance().inject(multipartRequest(source, {
      headers: bearer(session.sessionToken), filename: "secret-resume.md",
    }));
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ status: "queued", reused: true });
  });

  it("为 owner 创建、复用并读取岗位导入，且不向其他账户暴露原文", async () => {
    capturedLogs.length = 0;
    const owner = await createSession(app, "job-import-owner");
    const other = await createSession(app, "job-import-other");
    const source = "\uFEFF  ＃ 高级前端工程师  \r\n公司：示例科技  \r\n地点：上海\r\n秘密正文  \r\n";
    const create = () => app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/job-imports",
      headers: { ...bearer(owner.sessionToken), "content-type": "application/json" },
      payload: { inputType: "pasted_text", content: source },
    });

    const created = await create();
    const repeated = await create();
    const importId = created.json().importId as string;
    await database.execute(`update job_imports set status = 'failed', failure_code = 'JOB_NORMALIZER_OUTPUT_INVALID' where id = '${importId}'`);
    const listed = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: "/v1/job-imports", headers: bearer(owner.sessionToken),
    });
    const detail = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: `/v1/job-imports/${importId}`, headers: bearer(owner.sessionToken),
    });
    const raw = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: `/v1/job-imports/${importId}/raw`, headers: bearer(owner.sessionToken),
    });
    const hidden = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: `/v1/job-imports/${importId}`, headers: bearer(other.sessionToken),
    });
    const hiddenRaw = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: `/v1/job-imports/${importId}/raw`, headers: bearer(other.sessionToken),
    });
    const invalid = await app.getHttpAdapter().getInstance().inject({
      method: "POST",
      url: "/v1/job-imports",
      headers: { ...bearer(owner.sessionToken), "content-type": "application/json" },
      payload: { inputType: "pasted_text", content: source, unexpected: "must be rejected" },
    });
    const anonymous = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-imports", payload: { inputType: "pasted_text", content: source },
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ importId: expect.any(String), status: "imported", failureCode: null });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ importId, status: "imported" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ imports: [expect.objectContaining({ importId, status: "failed", failureCode: "JOB_NORMALIZER_OUTPUT_INVALID" })] });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ importId, opportunity: null });
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(raw.body).toBe(source);
    await expect(database.execute<{ user_id: string; raw_object_reference: { objectKey: string } }>(
      `select user_id, raw_object_reference from job_source_posting_versions where user_id = '${owner.account.userId}'`,
    )).resolves.toEqual(expect.arrayContaining([{ user_id: owner.account.userId, raw_object_reference: { objectKey: `accounts/${owner.account.userId}/job-imports/${importId}/source.md` } }]));
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: "JOB_IMPORT_NOT_FOUND", requestId: expect.any(String) });
    expect(hiddenRaw.statusCode).toBe(404);
    expect(hiddenRaw.body).not.toContain("秘密正文");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "INVALID_REQUEST", requestId: expect.any(String) });
    expect(anonymous.statusCode).toBe(401);
    expect(JSON.stringify(jobQueue.jobs)).not.toContain(source);
    expect(JSON.stringify(await database.select({ metadata: auditEvents.metadata }).from(auditEvents))).not.toContain(source);
    expect(normalizedLogText(capturedLogs)).not.toContain(source);
  });

  it("不向 owner 返回 canonical 等价但已被替换的岗位原文", async () => {
    const owner = await createSession(app, "job-import-raw-integrity");
    const source = "\uFEFF  ＃ 工程师  \r\n公司：示例科技  \r\n";
    const altered = "\uFEFF  # 工程师\n公司:示例科技\n";
    const created = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-imports", headers: { ...bearer(owner.sessionToken), "content-type": "application/json" },
      payload: { inputType: "pasted_text", content: source },
    });
    const importId = created.json().importId as string;
    jobStoredObjects.set(`accounts/${owner.account.userId}/job-imports/${importId}/source.md`, new TextEncoder().encode(altered));

    const raw = await app.getHttpAdapter().getInstance().inject({
      method: "GET", url: `/v1/job-imports/${importId}/raw`, headers: bearer(owner.sessionToken),
    });

    expect(raw.statusCode).toBe(503);
    expect(raw.json()).toMatchObject({ code: "JOB_IMPORT_OBJECT_STORAGE_FAILED", requestId: expect.any(String) });
    expect(raw.body).not.toContain(altered);
  });

  it("认证用户可以通过 URL 导入受验证岗位页，并获得稳定的页面拒绝错误", async () => {
    const session = await createSession(app, "url-job-import-owner");
    const url = `https://jobs.example.com/roles/${randomUUID()}`;
    const created = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-imports", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
      payload: { inputType: "url", url },
    });
    const importId = created.json().importId as string;
    jobPageFetcher.nextError = new JobPageFetchError("JOB_PAGE_LISTING");
    const listing = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-imports", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
      payload: { inputType: "url", url: `https://jobs.example.com/list/${randomUUID()}` },
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ inputType: "url", status: "imported" });
    expect(jobStoredObjects.has(`accounts/${session.account.userId}/job-imports/${importId}/raw.html`)).toBe(true);
    expect(jobStoredObjects.has(`accounts/${session.account.userId}/job-imports/${importId}/visible.txt`)).toBe(true);
    expect(listing.statusCode).toBe(422);
    expect(listing.json()).toMatchObject({ code: "JOB_PAGE_LISTING", requestId: expect.any(String) });
  });

  it("按 UTF-8 字节限制岗位正文，并将存储与队列故障映射为不泄漏正文的 503", async () => {
    const session = await createSession(app, "job-import-runtime-failures");
    const source = "# 私密岗位\nprivate-job@example.test";
    const request = () => app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-imports", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
      payload: { inputType: "pasted_text", content: source },
    });

    capturedLogs.length = 0;
    jobContentStore.failNextPut = true;
    const storageFailure = await request();
    jobQueue.failNext = true;
    const queueFailure = await request();
    const oversized = "😀".repeat(131_073);
    const oversizedFailure = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-imports", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
      payload: { inputType: "pasted_text", content: oversized },
    });

    expect(storageFailure.statusCode).toBe(503);
    expect(storageFailure.json()).toMatchObject({ code: "JOB_IMPORT_OBJECT_STORAGE_FAILED", requestId: expect.any(String) });
    expect(queueFailure.statusCode).toBe(503);
    expect(queueFailure.json()).toMatchObject({ code: "JOB_IMPORT_QUEUE_UNAVAILABLE", requestId: expect.any(String) });
    expect(oversizedFailure.statusCode).toBe(400);
    expect(oversizedFailure.json()).toMatchObject({ code: "JOB_IMPORT_CONTENT_INVALID", requestId: expect.any(String) });
    const publicOutput = `${storageFailure.body}${queueFailure.body}${oversizedFailure.body}`;
    expect(publicOutput).not.toContain(source);
    expect(publicOutput).not.toContain("private-job@example.test");
    expect(publicOutput).not.toContain(oversized);
    const audit = JSON.stringify(await database.select({ metadata: auditEvents.metadata }).from(auditEvents));
    const logs = normalizedLogText(capturedLogs);
    expect(audit).not.toContain(source);
    expect(audit).not.toContain(oversized);
    expect(logs).not.toContain(source);
    expect(logs).not.toContain(oversized);
    expect(logs).not.toContain("job queue unavailable");
    expect(logs).not.toContain("job storage unavailable");
  });

  it("接受恰好 524288 UTF-8 bytes 的岗位正文", async () => {
    const session = await createSession(app, "job-import-byte-boundary");
    const content = "😀".repeat(131_072);
    expect(Buffer.byteLength(content, "utf8")).toBe(524_288);

    const response = await app.getHttpAdapter().getInstance().inject({
      method: "POST", url: "/v1/job-imports", headers: { ...bearer(session.sessionToken), "content-type": "application/json" },
      payload: { inputType: "pasted_text", content },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body).toEqual({
      importId: expect.any(String),
      inputType: "pasted_text",
      originalFilename: null,
      status: "imported",
      failureCode: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      detailUrl: expect.stringMatching(/^\/v1\/job-imports\//),
    });
    expect(JSON.stringify(body)).not.toContain(content);
  });

  it("publishes the protected contract and standard problem schema", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/openapi.json" });
    const document = response.json();

    expect(response.statusCode).toBe(200);
    expect(document.paths).toEqual(expect.objectContaining({
      "/v1/auth/dev/sessions": expect.anything(),
      "/v1/auth/sessions/current": expect.anything(),
      "/v1/accounts/{userId}": expect.anything(),
      "/v1/workbench/home": expect.anything(),
      "/v1/job-targets": expect.anything(),
      "/v1/job-targets/{targetId}/revisions": expect.anything(),
      "/v1/job-targets/{targetId}/deactivations": expect.anything(),
      "/v1/career-documents/imports": expect.anything(),
      "/v1/career-documents/imports/{importId}": expect.anything(),
      "/health/live": expect.anything(),
    }));
    expect(document.components.schemas.ApiProblem).toBeDefined();
    expect(document.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "opaque-session-token",
    });
    expect(document.paths["/v1/auth/dev/sessions"].post.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        in: "header",
        name: "x-dev-auth-secret",
        required: true,
      }),
    ]));
    for (const [path, method] of [
      ["/v1/auth/sessions/current", "delete"],
      ["/v1/accounts/{userId}", "get"],
      ["/v1/workbench/home", "get"],
      ["/v1/job-targets", "get"],
      ["/v1/job-targets", "post"],
      ["/v1/job-targets/{targetId}/revisions", "post"],
      ["/v1/job-targets/{targetId}/deactivations", "post"],
      ["/v1/career-documents/imports", "get"],
      ["/v1/career-documents/imports", "post"],
      ["/v1/career-documents/imports/{importId}", "get"],
    ] as const) {
      expect(document.paths[path][method].security).toEqual([{ bearerAuth: [] }]);
    }
    expect(document.paths["/v1/career-documents/imports"].post.requestBody.content["multipart/form-data"].schema)
      .toMatchObject({
        required: ["file", "privacyMode"],
        properties: {
          file: { format: "binary" },
          privacyMode: { enum: ["sanitized_only", "retain_protected_original"] },
          protectedOriginal: { format: "binary" },
        },
      });
    const responses = document.paths["/v1/career-documents/imports"].post.responses;
    expect(responses["200"].content["application/json"].schema).toEqual(responses["202"].content["application/json"].schema);
    const jobTargetResponseSchema = document.paths["/v1/job-targets"].get.responses["200"].content["application/json"].schema;
    expect(document.paths["/v1/job-targets"].post.responses["201"].content["application/json"].schema).toEqual(jobTargetResponseSchema);
    expect(document.paths["/v1/job-targets/{targetId}/revisions"].post.responses["201"].content["application/json"].schema).toEqual(jobTargetResponseSchema);
    expect(document.paths["/v1/job-targets/{targetId}/deactivations"].post.responses["201"].content["application/json"].schema).toEqual(jobTargetResponseSchema);
    expect(document.paths["/v1/career-documents/imports/{importId}"].get.responses["400"])
      .toEqual(expect.objectContaining({ description: expect.any(String) }));
  });

  it("refuses to bootstrap Dev Auth in production", async () => {
    const environment = {
      APP_ENV: process.env.APP_ENV,
      AUTH_MODE: process.env.AUTH_MODE,
      DEV_AUTH_SHARED_SECRET: process.env.DEV_AUTH_SHARED_SECRET,
    };
    Object.assign(process.env, { APP_ENV: "production", AUTH_MODE: "dev" });

    await expect(Test.createTestingModule({ imports: [AppModule] }).compile())
      .rejects.toThrow(/正式环境不能启用 Dev Auth/);

    Object.assign(process.env, environment);
  });
});

function bearer(sessionToken: string) {
  return { authorization: `Bearer ${sessionToken}` };
}

async function createSession(api: NestFastifyApplication, subject: string): Promise<{
  account: { userId: string };
  sessionToken: string;
}> {
  const response = await api.getHttpAdapter().getInstance().inject({
    method: "POST",
    url: "/v1/auth/dev/sessions",
    headers: { "x-dev-auth-secret": testSecret },
    payload: { subject },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function createActiveTarget(
  api: NestFastifyApplication,
  sessionToken: string,
  roleFamily: string,
  priority: "primary" | "secondary" = "primary",
): Promise<string> {
  const response = await api.getHttpAdapter().getInstance().inject({
    method: "POST",
    url: "/v1/job-targets",
    headers: { ...bearer(sessionToken), "content-type": "application/json" },
    payload: { priority, constraints: jobTargetConstraints(roleFamily) },
  });
  expect(response.statusCode).toBe(201);
  const target = response.json().targets.find((item: { constraints: { roleFamily: string } }) => item.constraints.roleFamily === roleFamily);
  expect(target).toBeDefined();
  return target.targetId;
}

function jobTargetConstraints(roleFamily: string, excludedCompany = "") {
  return {
    roleFamily,
    seniority: null,
    locations: [],
    workModes: [],
    relocation: "unknown",
    salary: null,
    industries: [],
    dealBreakers: {
      excludedCompanies: excludedCompany ? [excludedCompany] : [],
      excludedIndustries: [],
      excludeOutsourcing: false,
      excludeDispatch: false,
      excludeHeadhunter: false,
      other: [],
    },
  };
}

function multipartRequest(source: string | Uint8Array | undefined, options: {
  headers?: Record<string, string>;
  filename?: string;
  fieldname?: string;
  mimetype?: string;
  extraFile?: boolean;
  extraField?: boolean;
  fieldOnly?: boolean;
  privacyMode?: "sanitized_only" | "retain_protected_original";
  protectedOriginal?: string | Uint8Array;
} = {}) {
  const boundary = "career-import-test-boundary";
  const bytes = source === undefined ? new Uint8Array() : typeof source === "string" ? new TextEncoder().encode(source) : source;
  const body = source === undefined ? Buffer.concat([
    multipartField(boundary, "privacyMode", options.privacyMode ?? "sanitized_only"),
    Buffer.from(`--${boundary}--\r\n`),
  ]) : options.fieldOnly ? Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${typeof source === "string" ? source : Buffer.from(source).toString("utf8")}\r\n--${boundary}--\r\n`,
  ) : Buffer.concat([
    multipartField(boundary, "privacyMode", options.privacyMode ?? "sanitized_only"),
    ...(options.extraField ? [multipartField(boundary, "note", "extra")] : []),
    multipartPart(boundary, bytes, options),
    ...(options.protectedOriginal ? [multipartPart(
      boundary,
      typeof options.protectedOriginal === "string" ? new TextEncoder().encode(options.protectedOriginal) : options.protectedOriginal,
      { filename: options.filename, fieldname: "protectedOriginal", mimetype: options.mimetype },
    )] : []),
    ...(options.extraFile ? [multipartPart(boundary, new TextEncoder().encode("## 技能\n- Extra"), options)] : []),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return {
    method: "POST" as const,
    url: "/v1/career-documents/imports",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, ...options.headers },
    payload: body,
  };
}

function multipartField(boundary: string, name: string, value: string) {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}

function multipartPart(boundary: string, bytes: Uint8Array, options: { filename?: string; fieldname?: string; mimetype?: string }) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${options.fieldname ?? "file"}"; filename="${options.filename ?? "resume.md"}"\r\nContent-Type: ${options.mimetype ?? "text/markdown"}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from("\r\n"),
  ]);
}

function normalizedLogText(entries: unknown[]): string {
  return JSON.stringify(normalizeLogValue(entries, new Set<object>()));
}

function normalizeLogValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if ("raw" in value && "requestId" in value) {
    const request = value as { id?: unknown; method?: unknown; url?: unknown; requestId?: unknown };
    return { id: request.id, method: request.method, url: request.url, requestId: request.requestId };
  }
  if ("raw" in value) {
    const reply = value as { statusCode?: unknown };
    return { statusCode: reply.statusCode };
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: normalizeLogValue(value.cause, nextAncestors),
    };
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeLogValue(entry, nextAncestors));

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = normalizeLogValue(entry, nextAncestors);
  }
  return normalized;
}
