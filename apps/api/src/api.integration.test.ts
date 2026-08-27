import { createHash, randomUUID } from "node:crypto";
import "reflect-metadata";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents, careerDocuments, createDatabase, migrateDatabase, type Database } from "@job-copilot/database";
import type { CareerDocumentStore, CareerImportQueue } from "@job-copilot/domain/career-imports";
import { AppModule } from "./app.module.js";
import { configureApiApplication } from "./configure-api-application.js";
import { DATABASE } from "./config/runtime-config.module.js";
import { CAREER_DOCUMENT_STORE, CAREER_IMPORT_QUEUE } from "./career-import/career-import.tokens.js";

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
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ loggerInstance: testLogger as never }));
    await configureApiApplication(app);
    await app.init();
    expect(app.get(CAREER_IMPORT_QUEUE)).toBe(queue);
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

  it("accepts one Markdown upload, reuses it, and never exposes source content in audit metadata", async () => {
    capturedLogs.length = 0;
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

  it("publishes the protected contract and standard problem schema", async () => {
    const response = await app.getHttpAdapter().getInstance().inject({ method: "GET", url: "/openapi.json" });
    const document = response.json();

    expect(response.statusCode).toBe(200);
    expect(document.paths).toEqual(expect.objectContaining({
      "/v1/auth/dev/sessions": expect.anything(),
      "/v1/auth/sessions/current": expect.anything(),
      "/v1/accounts/{userId}": expect.anything(),
      "/v1/workbench/home": expect.anything(),
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

function multipartRequest(source: string | Uint8Array | undefined, options: {
  headers?: Record<string, string>;
  filename?: string;
  fieldname?: string;
  mimetype?: string;
  extraFile?: boolean;
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
