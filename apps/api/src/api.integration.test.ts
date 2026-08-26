import "reflect-metadata";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, createDatabase, migrateDatabase, type Database } from "@job-copilot/database";
import { AppModule } from "./app.module.js";
import { configureOpenApi } from "./api-documentation.js";
import { DATABASE } from "./config/runtime-config.module.js";

const testSecret = "test-dev-auth-shared-secret-must-be-at-least-32-characters";

describe("authenticated workbench HTTP API", () => {
  let app: NestFastifyApplication;
  let container: StartedPostgreSqlContainer;
  let database: Database;
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

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureOpenApi(app);
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await app?.get<Database>(DATABASE).$client.end();
    await database?.$client.end();
    await container?.stop();
    Object.assign(process.env, originalEnvironment);
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

  it("publishes the protected contract and standard problem schema", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/openapi.json" });
    const document = response.json();

    expect(response.statusCode).toBe(200);
    expect(document.paths).toEqual(expect.objectContaining({
      "/v1/auth/dev/sessions": expect.anything(),
      "/v1/auth/sessions/current": expect.anything(),
      "/v1/accounts/{userId}": expect.anything(),
      "/v1/workbench/home": expect.anything(),
      "/health/live": expect.anything(),
    }));
    expect(document.components.schemas.ApiProblem).toBeDefined();
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
