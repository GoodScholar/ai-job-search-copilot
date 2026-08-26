# Dev Auth 与求职工作台基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 Issue #2 的第一条完整产品纵切：一条命令启动本地生产形态全栈，目标求职者通过 Dev Auth 获得持久求职账户、安全会话和真实空状态求职工作台。

**Architecture:** 保持模块化单体：Next.js 作为 Web/BFF，NestJS + Fastify 作为权威领域入口，NestJS standalone Worker 通过 Redis 发布运行心跳；PostgreSQL + Drizzle 保存求职账户、外部身份、会话和审计轨迹。共享 Zod 契约、数据库和领域模块位于内部 workspace packages，浏览器只持有 HttpOnly opaque session Cookie。

**Tech Stack:** Node.js `>=22.22.2`（Codex 执行使用工作区 Node `24.19.0`）、pnpm `11.5.2`、Next.js `16.3.2`、React `19.2.8`、NestJS `11.2.3`、Fastify `5.12.1`、PostgreSQL、Drizzle ORM `0.45.2`、Redis、BullMQ `6.2.2`、MinIO、Mailpit、Zod `4.4.3`、Vitest `4.1.11`、Testcontainers `12.1.0`、Playwright `1.62.1`。

**Spec:** `docs/superpowers/specs/2026-08-26-dev-auth-workbench-foundation-design.md`；父规格为 GitHub Issue #1，执行 Ticket 为 GitHub Issue #2。

## Global Constraints

- 只实现 Issue #2；不实现微信 OAuth、职业资料、求职画像、岗位、推荐、投递、SSE 或真实 Agent 任务。
- 使用根级 `CONTEXT.md` 中的领域词汇；内部主键叫 `user_id`，用户界面称“求职账户”。
- Web 采用 React Server Components 读取；Client Components 只用于确有客户端状态的交互。
- API 是账户、会话、所有权和审计的权威入口；Next.js 不直接读 PostgreSQL。
- Dev Auth 同时要求 `APP_ENV=local|test`、`AUTH_MODE=dev` 和服务端共享密钥；`APP_ENV=production + AUTH_MODE=dev` 必须拒绝启动。
- Dev Auth 页面固定使用 `local-primary` 合成身份，不允许浏览器输入任意 subject。
- 会话 Token 为 32 字节密码学随机值，数据库只保存 SHA-256 哈希；默认 TTL 为 7 天。
- Cookie 名为 `job_copilot_session`，设置 `HttpOnly`、`SameSite=Lax`、`Path=/`、明确 `Expires`；生产环境必须 `Secure`。
- 工作台默认路径为 `/home`，无效会话重定向到 `/login?returnTo=%2Fhome`。
- HTTP 错误固定返回 `{ code, message, requestId }`；不得返回堆栈、Token、Cookie、Dev subject 或数据库错误。
- 默认开发端口：Web `3020`、API `3021`、PostgreSQL `54320`、Redis `63790`、MinIO API `59000`、MinIO Console `59001`、Mailpit HTTP `58025`、Mailpit SMTP `51025`。
- 本地开发与测试均使用 PostgreSQL、Redis 和 S3-compatible object storage；不得添加 SQLite、内存队列或文件状态替代方案。
- 测试只观察已批准的 Playwright、HTTP 和领域模块 interface，不断言 Controller 私有方法、Drizzle 查询形状或内部调用次数。
- 每个任务严格执行一个行为一轮红 → 最小实现 → 绿；只在任务验收通过后提交。
- 当前主分支存在用户所有的未跟踪 `.superpowers/`，任何任务都不得添加、删除或格式化该目录。
- 实现基准提交为 `1bf0201`；最终双轴代码审查使用 `git diff 1bf0201...HEAD`。

## File Structure

### Root runtime

- `compose.yaml`：PostgreSQL、Redis、MinIO、MinIO 初始化和 Mailpit 的本地生产形态定义。
- `.env.example`：人工单进程启动时所需的非秘密配置说明。
- `scripts/local-runtime.mjs`：`pnpm dev` 的进程编排和依赖健康等待。
- `scripts/local-runtime.test.mjs`：通过注入命令执行 interface 测试编排行为。
- `tsconfig.base.json`：后端应用和内部 package 的共享 TypeScript 约束。

### Internal packages

- `packages/contracts`：Zod 契约与通过 package subpath 暴露的类型，不建立聚合 barrel。
- `packages/database`：Drizzle Schema、连接、迁移和测试数据库辅助。
- `packages/domain`：账户会话、审计、工作台摘要和运行配置策略的深模块。

### Applications

- `apps/api`：NestJS/Fastify HTTP 入口、鉴权 Guard、统一错误、OpenAPI 与就绪检查。
- `apps/worker`：NestJS standalone Worker 和 Redis 心跳 Adapter。
- `apps/web`：Next.js 登录 Server Action、server-only API Client、Cookie、求职工作台和退出操作。

---

### Task 1: 建立可启动的本地运行骨架

**Files:**
- Create: `compose.yaml`
- Create: `.env.example`
- Create: `scripts/local-runtime.mjs`
- Test: `scripts/local-runtime.test.mjs`
- Create: `tsconfig.base.json`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/tsconfig.build.json`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/tsconfig.build.json`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/app.module.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Docker Compose CLI、pnpm workspace 和环境变量。
- Produces: `pnpm dev`、`pnpm dev:down`、`pnpm test:runtime`；API liveness 地址 `http://127.0.0.1:3021/health/live`。

- [ ] **Step 1: 写本地运行编排的失败测试**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { prepareInfrastructure } from "./local-runtime.mjs";

test("starts compose and waits for healthy dependencies before applications", async () => {
  const calls = [];
  await prepareInfrastructure({
    run: async (command, args) => calls.push([command, ...args]),
  });

  assert.deepEqual(calls, [
    ["docker", "compose", "version"],
    ["docker", "compose", "up", "-d", "--wait"],
  ]);
});

test("stops before applications when compose is unavailable", async () => {
  await assert.rejects(
    prepareInfrastructure({ run: async () => { throw new Error("docker missing"); } }),
    /Docker Compose 不可用/,
  );
});
```

- [ ] **Step 2: 运行测试并确认红灯**

Run:

```bash
node --test scripts/local-runtime.test.mjs
```

Expected: FAIL，原因是 `scripts/local-runtime.mjs` 或 `prepareInfrastructure` 不存在。

- [ ] **Step 3: 实现最小编排 interface**

```js
export async function prepareInfrastructure({ run }) {
  try {
    await run("docker", ["compose", "version"]);
  } catch {
    throw new Error("Docker Compose 不可用，无法启动本地生产形态依赖");
  }

  await run("docker", ["compose", "up", "-d", "--wait"]);
}
```

主入口使用 `node:child_process.spawn`，生成一次进程组共享的 `DEV_AUTH_SHARED_SECRET`，先调用 `prepareInfrastructure`，再执行：

```text
pnpm --parallel --stream --filter web --filter api --filter worker dev
```

转发 `SIGINT`/`SIGTERM` 给 pnpm 子进程；应用异常退出时退出根进程，但不自动删除持久卷。

- [ ] **Step 4: 定义 Compose 基础设施及健康检查**

`compose.yaml` 必须包含以下公开端口和健康语义：

```yaml
services:
  postgres:
    image: postgres@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2
    environment:
      POSTGRES_DB: job_copilot
      POSTGRES_USER: job_copilot
      POSTGRES_PASSWORD: local_only_job_copilot
    ports: ["${POSTGRES_PORT:-54320}:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U job_copilot -d job_copilot"]
      interval: 2s
      timeout: 2s
      retries: 20

  redis:
    image: redis@sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576
    ports: ["${REDIS_PORT:-63790}:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 20

  minio:
    image: minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e
    command: server /data --console-address :9001
    environment:
      MINIO_ROOT_USER: job_copilot
      MINIO_ROOT_PASSWORD: local_only_job_copilot_secret
    ports:
      - "${MINIO_API_PORT:-59000}:9000"
      - "${MINIO_CONSOLE_PORT:-59001}:9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 2s
      timeout: 2s
      retries: 20

  mailpit:
    image: axllent/mailpit@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24
    ports:
      - "${MAILPIT_HTTP_PORT:-58025}:8025"
      - "${MAILPIT_SMTP_PORT:-51025}:1025"
    healthcheck:
      test: ["CMD", "/mailpit", "readyz"]
      interval: 2s
      timeout: 2s
      retries: 20
```

这些多架构 digest 已在计划编写日通过 `docker buildx imagetools inspect` 核对。MinIO 初始化容器创建私有 `career-documents` bucket，并在创建成功后退出 `0`。

- [ ] **Step 5: 建立最小 API 与 Worker 应用**

安装已核对版本：

```bash
pnpm --filter api add @nestjs/common@11.2.3 @nestjs/core@11.2.3 @nestjs/platform-fastify@11.2.3 fastify@5.12.1 reflect-metadata rxjs
pnpm --filter api add -D @nestjs/cli@11.0.24 @types/node typescript vitest
pnpm --filter worker add @nestjs/common@11.2.3 @nestjs/core@11.2.3 reflect-metadata rxjs
pnpm --filter worker add -D @nestjs/cli@11.0.24 @types/node typescript vitest
```

API `main.ts` 必须使用 `FastifyAdapter` 并监听 `API_PORT`；Worker 使用 `NestFactory.createApplicationContext`，不打开 HTTP 端口。API 先提供固定响应：

```ts
@Controller("health")
export class HealthController {
  @Get("live")
  live() {
    return { status: "ok" as const };
  }
}
```

- [ ] **Step 6: 补齐根脚本并验证绿灯**

根脚本：

```json
{
  "dev": "node scripts/local-runtime.mjs",
  "dev:down": "docker compose down",
  "test:runtime": "node --test scripts/local-runtime.test.mjs",
  "test": "pnpm test:runtime && pnpm -r --if-present test",
  "typecheck": "pnpm -r --if-present typecheck",
  "build": "pnpm -r --if-present build",
  "lint": "pnpm -r --if-present lint"
}
```

Run:

```bash
pnpm install
pnpm test:runtime
pnpm typecheck
docker compose config --quiet
```

Expected: 全部退出 `0`；系统 Node 版本不足时使用工作区 Node `24.19.0` 执行。

- [ ] **Step 7: 提交运行骨架**

```bash
git add compose.yaml .env.example scripts tsconfig.base.json package.json pnpm-lock.yaml apps/api apps/worker
git commit -m "build: add local full-stack runtime foundation (#2)"
```

---

### Task 2: 建立共享契约与数据库 Schema

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/api-problem.ts`
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/workbench.ts`
- Create: `packages/contracts/src/runtime.ts`
- Test: `packages/contracts/src/contracts.test.ts`
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/schema.ts`
- Create: `packages/database/src/migrate.ts`
- Create: `packages/database/migrations/**`
- Test: `packages/database/src/migrate.integration.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `DATABASE_URL`、Zod 和 PostgreSQL。
- Produces: package subpaths `@job-copilot/contracts/api-problem`、`/auth`、`/workbench`、`/runtime`；`createDatabase(url)`、`migrateDatabase(db)` 和 Drizzle schema。

- [ ] **Step 1: 写契约的失败测试**

```ts
import { describe, expect, it } from "vitest";
import { ApiProblemSchema } from "./api-problem";
import { WorkbenchHomeSchema } from "./workbench";

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
});
```

- [ ] **Step 2: 运行契约测试确认红灯**

Run:

```bash
pnpm --filter @job-copilot/contracts test -- contracts.test.ts
```

Expected: FAIL，原因是 package 或 Schema 尚不存在。

- [ ] **Step 3: 实现最小共享契约**

核心契约：

```ts
export const ApiProblemSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  requestId: z.string().uuid(),
}).strict();

export const StartDevSessionRequestSchema = z.object({
  subject: z.string().min(1).max(80),
}).strict();

export const WorkbenchHomeSchema = z.object({
  account: z.object({ userId: z.string().uuid() }).strict(),
  summary: z.object({
    recommendations: z.literal(0),
    pendingFacts: z.literal(0),
    runningAgentRuns: z.literal(0),
    applications: z.literal(0),
  }).strict(),
}).strict();
```

`WorkerHeartbeatSchema` 包含 `workerId`、`recordedAt` ISO 时间和固定 `contractVersion: 1`。

- [ ] **Step 4: 写数据库迁移的失败集成测试**

```ts
it("migrates the identity and audit tables on PostgreSQL", async () => {
  const tables = await listPublicTables(migratedDatabase);
  expect(tables).toEqual(expect.arrayContaining([
    "job_accounts", "external_identities", "sessions", "audit_events",
  ]));
});
```

测试使用 `PostgreSqlContainer`，不连接开发数据库。

- [ ] **Step 5: 运行数据库测试确认红灯**

Run:

```bash
pnpm --filter @job-copilot/database test -- migrate.integration.test.ts
```

Expected: FAIL，原因是迁移和表不存在。

- [ ] **Step 6: 实现 Drizzle Schema 与迁移**

安装：

```bash
pnpm --filter @job-copilot/contracts add zod@4.4.3
pnpm --filter @job-copilot/contracts add -D typescript vitest
pnpm --filter @job-copilot/database add drizzle-orm@0.45.2 postgres@3.4.9
pnpm --filter @job-copilot/database add -D drizzle-kit@0.31.10 @testcontainers/postgresql@12.1.0 typescript vitest
```

Schema 约束：

```ts
export const externalIdentities = pgTable("external_identities", {
  provider: varchar("provider", { length: 32 }).notNull(),
  subject: varchar("subject", { length: 128 }).notNull(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.provider, table.subject] })]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => jobAccounts.id),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

`audit_events` 的 `metadata` 使用 JSONB，但写入只能经过领域审计模块。

- [ ] **Step 7: 运行并提交**

```bash
pnpm --filter @job-copilot/contracts test
pnpm --filter @job-copilot/database test
pnpm typecheck
git add packages pnpm-lock.yaml
git commit -m "feat: add identity contracts and database schema (#2)"
```

---

### Task 3: 实现账户会话与审计深模块

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/runtime-config.ts`
- Create: `packages/domain/src/audit-trail.ts`
- Create: `packages/domain/src/account-sessions.ts`
- Create: `packages/domain/src/workbench-home.ts`
- Test: `packages/domain/src/runtime-config.test.ts`
- Test: `packages/domain/src/account-sessions.integration.test.ts`
- Test: `packages/domain/src/audit-trail.integration.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Drizzle database、Clock 和 SessionTokenSource。
- Produces: `parseRuntimeConfig`、`createAuditTrail`、`createAccountSessions`、`getWorkbenchHome`。

- [ ] **Step 1: 写正式环境拒绝 Dev Auth 的失败测试**

```ts
it("rejects dev auth in production", () => {
  expect(() => parseRuntimeConfig({
    APP_ENV: "production",
    AUTH_MODE: "dev",
    DEV_AUTH_SHARED_SECRET: "01234567890123456789012345678901",
  })).toThrow(/正式环境不能启用 Dev Auth/);
});
```

- [ ] **Step 2: 运行测试确认红灯并实现配置策略**

Run:

```bash
pnpm --filter @job-copilot/domain test -- runtime-config.test.ts
```

Expected: FAIL，原因是 `parseRuntimeConfig` 不存在。

实现严格 Zod 配置：`APP_ENV` 为 `local | test | production`，`AUTH_MODE` 为 `dev | wechat`，Dev Auth 共享密钥至少 32 字符；production + dev 通过 `superRefine` 失败。

- [ ] **Step 3: 写账户复用、会话和过期的失败集成测试**

```ts
it("reuses the account but creates independently revocable sessions", async () => {
  const first = await sessions.startDevSession({ subject: "local-primary", now });
  const second = await sessions.startDevSession({ subject: "local-primary", now });

  expect(second.account.userId).toBe(first.account.userId);
  expect(second.sessionToken).not.toBe(first.sessionToken);
  expect(await sessions.authenticateSession({ sessionToken: first.sessionToken, now }))
    .toEqual({ userId: first.account.userId });

  await sessions.endSession({ sessionToken: first.sessionToken, now });
  expect(await sessions.authenticateSession({ sessionToken: first.sessionToken, now })).toBeNull();
  expect(await sessions.authenticateSession({ sessionToken: second.sessionToken, now }))
    .toEqual({ userId: first.account.userId });
});
```

另写一个 `now > expiresAt` 返回 `null` 的行为测试。

- [ ] **Step 4: 运行账户测试确认红灯并实现最小模块**

Run:

```bash
pnpm --filter @job-copilot/domain test -- account-sessions.integration.test.ts
```

Expected: FAIL，原因是账户会话模块不存在。

公开构造 interface：

```ts
export function createAccountSessions(input: {
  db: Database;
  tokenSource: () => string;
  sessionTtlMs: number;
  auditTrail: AuditTrail;
}): {
  startDevSession(input: { subject: string; now: Date; requestId: string }): Promise<StartedSession>;
  authenticateSession(input: { sessionToken: string; now: Date; requestId: string }): Promise<AuthenticatedAccount | null>;
  endSession(input: { sessionToken: string; now: Date; requestId: string }): Promise<void>;
}
```

生产 TokenSource 使用 `randomBytes(32).toString("base64url")`，哈希使用 SHA-256 十六进制；账户身份 upsert 与会话插入在同一事务完成。

- [ ] **Step 5: 写审计敏感字段失败测试**

```ts
it("rejects sensitive metadata instead of storing it", async () => {
  await expect(auditTrail.append({
    eventType: "auth.session_started",
    outcome: "success",
    requestId,
    metadata: { sessionToken: "must-not-be-stored" },
  })).rejects.toThrow(/敏感审计字段/);
});
```

- [ ] **Step 6: 实现审计 append/query 与真实空工作台**

允许的审计元数据值只有长度不超过 128 的字符串、有限数值和布尔值；键名匹配 `token|cookie|secret|subject|resume|document` 时拒绝写入。

`getWorkbenchHome({ userId })` 先确认账户存在且活动，再返回四项真实 0 值。找不到账户返回领域 `ACCOUNT_NOT_FOUND`，不返回数据库错误。

- [ ] **Step 7: 运行并提交**

```bash
pnpm --filter @job-copilot/domain test
pnpm typecheck
git add packages/domain pnpm-lock.yaml
git commit -m "feat: add account sessions and redacted audit trail (#2)"
```

---

### Task 4: 暴露受保护的 NestJS HTTP 契约

**Files:**
- Create: `apps/api/src/config/runtime-config.module.ts`
- Create: `apps/api/src/common/request-id.hook.ts`
- Create: `apps/api/src/common/api-problem.filter.ts`
- Create: `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/session.guard.ts`
- Create: `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/src/accounts/accounts.controller.ts`
- Create: `apps/api/src/workbench/workbench.controller.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Create: `apps/api/src/health/health.module.ts`
- Test: `apps/api/src/api.integration.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: 共享 Zod 契约、账户会话/审计/工作台领域接口和数据库。
- Produces: `/v1/auth/dev/sessions`、`/v1/auth/sessions/current`、`/v1/accounts/:userId`、`/v1/workbench/home`、`/health/live`、`/openapi.json`。

- [ ] **Step 1: 写 Dev Auth HTTP 失败测试**

```ts
it("creates and reuses an internal account through dev auth", async () => {
  const first = await api.inject({
    method: "POST",
    url: "/v1/auth/dev/sessions",
    headers: { "x-dev-auth-secret": testSecret },
    payload: { subject: "local-primary" },
  });
  const second = await api.inject({
    method: "POST",
    url: "/v1/auth/dev/sessions",
    headers: { "x-dev-auth-secret": testSecret },
    payload: { subject: "local-primary" },
  });

  expect(first.statusCode).toBe(201);
  expect(second.json().account.userId).toBe(first.json().account.userId);
  expect(second.json().sessionToken).not.toBe(first.json().sessionToken);
});
```

另写错误密钥 `403 DEV_AUTH_DISABLED` 与所有响应含 UUID `requestId` 的测试。

- [ ] **Step 2: 运行单文件测试确认红灯**

```bash
pnpm --filter api test -- api.integration.test.ts
```

Expected: FAIL，原因是 HTTP 模块和入口不存在。

- [ ] **Step 3: 实现 HTTP 入口、鉴权 Guard 和统一错误**

安装：

```bash
pnpm --filter api add @nestjs/swagger@11.4.7 nestjs-zod@5.5.0 zod@4.4.3 @job-copilot/contracts@workspace:* @job-copilot/database@workspace:* @job-copilot/domain@workspace:*
pnpm --filter api add -D @nestjs/testing@11.2.3 @testcontainers/postgresql@12.1.0
```

Guard 只接受：

```text
Authorization: Bearer <opaque-session-token>
```

Token 不匹配、过期或撤销时抛出 `AUTH_REQUIRED`。Controller 从 Guard 注入的 authenticated account 取得 `userId`，不接受浏览器提交所有者字段。

- [ ] **Step 4: 写工作台、退出和所有权失败测试**

```ts
it("returns only the authenticated account workbench", async () => {
  const response = await api.inject({
    method: "GET",
    url: "/v1/workbench/home",
    headers: bearer(primary.sessionToken),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    account: { userId: primary.account.userId },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  });
});

it("hides a different account resource", async () => {
  const response = await api.inject({
    method: "GET",
    url: `/v1/accounts/${primary.account.userId}`,
    headers: bearer(secondary.sessionToken),
  });
  expect(response.statusCode).toBe(404);
  expect(response.json().code).toBe("ACCOUNT_NOT_FOUND");
});
```

退出测试保存原 Token，调用 DELETE 后再次读取工作台必须得到 `401`；重复 DELETE 也不恢复会话。

- [ ] **Step 5: 生成并验证 OpenAPI**

使用 `nestjs-zod` 的 DTO、全局 `ZodValidationPipe` 和 `cleanupOpenApiDoc`，确保运行时校验和 Swagger 来自同一 Zod 契约。测试 `/openapi.json` 包含上述路径和 `ApiProblem` schema。

- [ ] **Step 6: 运行并提交**

```bash
pnpm --filter api test
pnpm --filter api typecheck
pnpm --filter api build
git add apps/api pnpm-lock.yaml
git commit -m "feat: expose authenticated workbench API (#2)"
```

---

### Task 5: 建立 Worker 心跳和完整就绪检查

**Files:**
- Create: `apps/worker/src/heartbeat/heartbeat.ts`
- Create: `apps/worker/src/heartbeat/redis-heartbeat.adapter.ts`
- Test: `apps/worker/src/heartbeat/heartbeat.integration.test.ts`
- Modify: `apps/worker/src/app.module.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `apps/worker/package.json`
- Create: `apps/api/src/health/readiness.ts`
- Test: `apps/api/src/health/readiness.test.ts`
- Modify: `apps/api/src/health/health.controller.ts`
- Modify: `apps/api/src/health/health.module.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Redis、PostgreSQL、MinIO/Mailpit 健康 HTTP 和共享 WorkerHeartbeat 契约。
- Produces: `writeHeartbeat`、`readFreshHeartbeat`、`checkReadiness` 与 `/health/ready`。

- [ ] **Step 1: 写 Worker 心跳过期的失败测试**

```ts
it("reports a heartbeat as stale after its ttl", async () => {
  await heartbeat.write({
    workerId: "worker-test",
    recordedAt: "2026-08-26T10:00:00.000Z",
    contractVersion: 1,
  });

  expect(await heartbeat.readFresh(new Date("2026-08-26T10:00:04.000Z"))).toEqual({
    workerId: "worker-test",
    recordedAt: "2026-08-26T10:00:00.000Z",
    contractVersion: 1,
  });
  expect(await heartbeat.readFresh(new Date("2026-08-26T10:00:11.000Z"))).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认红灯并实现 Redis Adapter**

```bash
pnpm --filter worker test -- heartbeat.integration.test.ts
```

Expected: FAIL，原因是心跳模块不存在。

安装并实现：

```bash
pnpm --filter worker add bullmq@6.2.2 ioredis@6.0.0 @job-copilot/contracts@workspace:* @job-copilot/domain@workspace:*
pnpm --filter worker add -D @testcontainers/redis@12.1.0
```

Redis 键固定为 `job-copilot:worker:heartbeat:v1`，Redis TTL 为 15 秒，Worker 每 5 秒刷新；读取后必须再次用 Zod 校验并根据传入 Clock 判定新鲜度。

- [ ] **Step 3: 写依赖未就绪的失败测试**

```ts
it("reports every dependency instead of hiding a partial outage", async () => {
  const result = await checkReadiness({
    postgres: async () => true,
    redis: async () => true,
    minio: async () => false,
    mailpit: async () => true,
    worker: async () => false,
  });

  expect(result).toEqual({
    status: "not_ready",
    dependencies: {
      postgres: "ready",
      redis: "ready",
      minio: "not_ready",
      mailpit: "ready",
      worker: "not_ready",
    },
  });
});
```

- [ ] **Step 4: 实现就绪检查并映射为 503**

独立检查并发执行，单项错误转换为 `not_ready`，不把连接字符串或错误堆栈返回浏览器。全部 ready 时 `/health/ready` 返回 `200`；任一 not_ready 时返回 `503 RUNTIME_NOT_READY` 和依赖状态。

- [ ] **Step 5: 运行并提交**

```bash
pnpm --filter worker test
pnpm --filter api test -- readiness.test.ts
pnpm typecheck
git add apps/api apps/worker pnpm-lock.yaml
git commit -m "feat: report worker and dependency readiness (#2)"
```

---

### Task 6: 将登录页接到真实 Dev Auth 会话

**Files:**
- Create: `apps/web/lib/server/api-client.ts`
- Create: `apps/web/lib/server/session-cookie.ts`
- Test: `apps/web/lib/server/session-cookie.test.ts`
- Create: `apps/web/app/login/actions.ts`
- Modify: `apps/web/app/login/page.tsx`
- Modify: `apps/web/app/login/page.test.tsx`
- Modify: `apps/web/lib/auth-mode.ts`
- Modify: `apps/web/lib/auth-mode.test.ts`
- Modify: `apps/web/app/(marketing)/page.tsx`
- Modify: relevant landing CTA tests
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Server-only `API_INTERNAL_URL`、Dev Auth 共享密钥和共享 Zod auth contract。
- Produces: `startDevSessionAction`、`endSessionAction`、`readSessionToken`、`writeSessionCookie`、`deleteSessionCookie`。

- [ ] **Step 1: 写 Cookie 与回跳策略失败测试**

```ts
it("uses secure cookie attributes without exposing account data", () => {
  expect(sessionCookieOptions({ appEnv: "production", expiresAt })).toEqual({
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
});

it("defaults login to the authenticated home", () => {
  expect(resolveLoginReturnTo(undefined)).toBe("/home");
  expect(resolveLoginReturnTo("https://evil.example")).toBe("/home");
  expect(resolveLoginReturnTo("/profile")).toBe("/profile");
});
```

- [ ] **Step 2: 运行测试确认红灯并实现 Server-only Cookie 模块**

```bash
pnpm --filter web test -- lib/server/session-cookie.test.ts lib/auth-mode.test.ts
```

Expected: FAIL，原因是新 interface 不存在或默认值仍为 `/`。

`api-client.ts` 每次调用生成/转发 `requestId`，用共享 Zod Schema 解析成功和失败响应；日志不包含请求 Body、Authorization 或 Cookie。

- [ ] **Step 3: 写登录页失败测试**

```tsx
it("offers the real local experience action", async () => {
  render(await LoginPage({ searchParams: Promise.resolve({ returnTo: "/home" }) }));
  expect(screen.getByRole("button", { name: "使用本地体验账户登录" })).toBeInTheDocument();
  expect(screen.getByText("正式邀请制 Beta 将使用微信登录")).toBeInTheDocument();
});
```

- [ ] **Step 4: 实现登录/退出 Server Actions**

登录 Action 固定发送：

```ts
const started = await api.startDevSession({ subject: "local-primary" });
await writeSessionCookie(started.sessionToken, new Date(started.expiresAt));
redirect(resolveLoginReturnTo(formData.get("returnTo")));
```

退出 Action 先尝试调用 API 撤销；无论撤销结果是成功还是已经无效，都删除本地 Cookie 并重定向 `/login`。网络失败时返回可重试错误，不假装服务端会话已经撤销。

营销页所有登录 CTA 改为 `/login?returnTo=%2Fhome`。微信模式仍显示“Adapter 待接入”，不显示可用登录按钮。

- [ ] **Step 5: 运行并提交**

```bash
pnpm --filter web test -- app/login/page.test.tsx lib/server/session-cookie.test.ts lib/auth-mode.test.ts
pnpm --filter web typecheck
pnpm --filter web lint
git add apps/web pnpm-lock.yaml
git commit -m "feat: enable secure local dev auth sessions (#2)"
```

---

### Task 7: 交付真实空状态求职工作台

**Files:**
- Create: `apps/web/app/(workbench)/layout.tsx`
- Create: `apps/web/app/(workbench)/home/page.tsx`
- Create: `apps/web/app/(workbench)/home/loading.tsx`
- Create: `apps/web/components/workbench/workbench-header.tsx`
- Create: `apps/web/components/workbench/workbench-home-view.tsx`
- Test: `apps/web/components/workbench/workbench-home-view.test.tsx`
- Create: `apps/web/lib/server/workbench.ts`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `WorkbenchHome` DTO 和当前会话 Cookie。
- Produces: 受保护 `/home`、首页/推荐/投递/画像导航和退出表单。

- [ ] **Step 1: 写真实空状态视图失败测试**

```tsx
it("shows only persisted empty workbench data", () => {
  render(<WorkbenchHomeView home={{
    account: { userId: "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3" },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  }} />);

  expect(screen.getByRole("heading", { name: "从真实职业资料开始" })).toBeInTheDocument();
  expect(screen.getByText("今日推荐").nextSibling).toHaveTextContent("0");
  expect(screen.queryByText("AI 应用工程师（示例）")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试确认红灯**

```bash
pnpm --filter web test -- components/workbench/workbench-home-view.test.tsx
```

Expected: FAIL，原因是工作台视图不存在。

- [ ] **Step 3: 实现 RSC 读取和受保护页面**

`getWorkbenchHome()`：

1. 读取 HttpOnly Cookie。
2. 无 Token 时 `redirect("/login?returnTo=%2Fhome")`。
3. 使用 server-only API Client 请求 `/v1/workbench/home`。
4. `401` 时重定向登录；其他错误渲染可重试错误状态。
5. 使用共享 `WorkbenchHomeSchema` 解析 DTO 后传给 Server Component 视图。

不要在顶层 workbench layout 只隐藏 children；每个受保护数据读取均经过上述 server-only DAL。

- [ ] **Step 4: 实现工作台界面**

导航文字固定为：首页、推荐、投递、画像。摘要文字固定为：今日推荐、待确认事实、运行中的求职代理、投递记录。所有数值来自 DTO；本切片均为 0。主要行动链接到后续职业资料入口的诚实占位说明，不创建虚假的可用上传流程。

复用现有色彩令牌和焦点样式；移动端触控目标至少 44px；无非必要动画。

- [ ] **Step 5: 运行并提交**

```bash
pnpm --filter web test -- components/workbench/workbench-home-view.test.tsx
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web build
git add apps/web
git commit -m "feat: add authenticated workbench home (#2)"
```

---

### Task 8: 扩展 Playwright 为生产形态全栈主接缝

**Files:**
- Create: `apps/web/e2e/auth-workbench.spec.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `scripts/local-runtime.mjs`
- Modify: `package.json`
- Test: `scripts/local-runtime.test.mjs`

**Interfaces:**
- Consumes: 根 `pnpm dev:test`、浏览器 UI 和公开 HTTP。
- Produces: 可重复、隔离、默认不访问外部服务的 Issue #2 主验收接缝。

- [ ] **Step 1: 写首次登录与真实空状态 E2E 测试**

```ts
test("首次登录创建并复用求职账户", async ({ page, request }) => {
  await page.goto("/login?returnTo=%2Fhome");
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { name: "从真实职业资料开始" })).toBeVisible();
  await expect(page.getByText("今日推荐").locator("..")).toContainText("0");

  const firstAccount = await fetchTestAccount(request, "local-primary");
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();
  const secondAccount = await fetchTestAccount(request, "local-primary");
  expect(secondAccount.userId).toBe(firstAccount.userId);
});
```

`fetchTestAccount` 只在 `APP_ENV=test` 使用 Playwright 进程持有的服务端共享密钥调用 Dev Auth HTTP；密钥不得注入浏览器页面。

- [ ] **Step 2: 运行测试确认红灯**

```bash
pnpm --filter web test:e2e -- auth-workbench.spec.ts --project="Desktop Chrome"
```

Expected: FAIL，原因是 Playwright 尚未启动根全栈或登录流程尚未接通。

- [ ] **Step 3: 实现隔离的 `dev:test` 编排**

`node scripts/local-runtime.mjs --test` 使用独立 Compose project、独立端口和固定测试共享密钥，启动前删除同名测试资源，退出时执行 `docker compose down -v`。根脚本新增：

```json
{
  "dev:test": "node scripts/local-runtime.mjs --test",
  "test:e2e": "pnpm --filter web test:e2e"
}
```

Playwright `webServer.command` 改为从根执行 `pnpm dev:test`，等待 API `/health/ready` 和 Web `/login` 都可用后开始。

- [ ] **Step 4: 增加退出失效和账户隔离 E2E**

测试保存退出前 Token，通过 API 请求确认退出后得到 `401 AUTH_REQUIRED`。创建 `local-secondary` 会话后，请求：

```text
GET /v1/accounts/<primary-user-id>
Authorization: Bearer <secondary-session-token>
```

必须得到 `404 ACCOUNT_NOT_FOUND`。随后用 secondary 请求 `/v1/workbench/home`，返回的只能是 secondary `userId`。

- [ ] **Step 5: 增加响应式与可访问性验收**

在 Desktop Chrome 和 Mobile Safari 验证：

- 顶层导航与主要行动可键盘到达。
- 登录和退出控件移动端高度至少 44px。
- 页面无横向滚动。
- `prefers-reduced-motion: reduce` 下无阻碍交互的过渡。
- `AxeBuilder` 返回零 violations。

- [ ] **Step 6: 运行并提交**

```bash
pnpm test:runtime
pnpm test:e2e
git add apps/web/e2e apps/web/playwright.config.ts scripts/local-runtime.mjs scripts/local-runtime.test.mjs package.json
git commit -m "test: cover the full dev auth workbench journey (#2)"
```

---

### Task 9: 文档化、全量验证并准备代码审查

**Files:**
- Create: `README.md`
- Modify: `apps/web/README.md`
- Modify: `.env.example`
- Modify: any files required only to fix failures found by the full verification

**Interfaces:**
- Consumes: 已完成的本地运行、API、Worker、Web 和测试命令。
- Produces: 对开发者可复现的启动/停止/验证说明和可供 `/code-review` 审查的绿色提交序列。

- [ ] **Step 1: 写运行文档**

根 README 必须包含：

```text
前置：Node >=22.22.2、pnpm 11.5.2、Docker + Compose
启动：pnpm install && pnpm dev
访问：http://127.0.0.1:3020
API：http://127.0.0.1:3021/openapi.json
邮件：http://127.0.0.1:58025
MinIO：http://127.0.0.1:59001
停止：pnpm dev:down
验证：pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build
```

明确说明 Dev Auth 仅供本地使用、正式 Beta 使用微信、当前工作台为空状态、尚无职业资料或 Agent 业务。

- [ ] **Step 2: 检查 OpenAPI、迁移和 Compose**

Run:

```bash
docker compose config --quiet
pnpm --filter @job-copilot/database db:migrate
curl --fail http://127.0.0.1:3021/openapi.json
curl --fail http://127.0.0.1:3021/health/ready
```

Expected: Compose 有效；迁移幂等；OpenAPI 可解析；全部运行单元启动时 readiness 为 `200`。

- [ ] **Step 3: 运行完整验证矩阵**

使用满足版本约束的 Node 后运行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
git diff --check
```

Expected: 所有命令退出 `0`；无 skipped 的 Issue #2 主流程测试；`.superpowers/` 仍未跟踪且未改动。

- [ ] **Step 4: 对照 Issue #2 逐项验收**

逐项记录证据：

1. `pnpm dev` 启动七个运行单元并报告依赖失败。
2. 同一 Dev 身份复用 `user_id`。
3. Cookie 属性、退出失效和回跳攻击测试通过。
4. `/home` 由 API 返回真实 0 值且无营销示例。
5. 共享 Zod、OpenAPI 和账户隔离测试通过。
6. 登录、退出和拒绝访问审计测试通过且无敏感字段。
7. Playwright 桌面、移动和 axe 通过。

- [ ] **Step 5: 提交文档和仅由验证触发的修复**

```bash
git add README.md apps/web/README.md .env.example
git commit -m "docs: document the local product runtime (#2)"
```

- [ ] **Step 6: 进入强制双轴审查**

固定点：

```bash
git rev-parse 1bf0201
git log 1bf0201..HEAD --oneline
git diff 1bf0201...HEAD
```

然后运行 `/code-review`：Standards 轴读取根 `AGENTS.md`、`apps/web/AGENTS.md`、`PRODUCT.md`、`CONTEXT.md` 和相关 ADR；Spec 轴读取 Issue #2 与本计划引用的设计文档。修复所有确认的问题后，重新运行 Step 3 的完整验证矩阵，再提交审查修复。

## Execution Notes

- 执行前使用 `using-git-worktrees` 创建隔离工作树和分支 `feature/issue-2-dev-auth-workbench`，并先运行当前基线 `pnpm lint:web && pnpm test:web && pnpm build:web && pnpm test:e2e`。
- 若基线失败，停止并报告，不把既有失败混入 Issue #2。
- 领取 Issue #2：`gh issue edit 2 --repo GoodScholar/ai-job-search-copilot --add-assignee @me`。
- 任何新失败必须先使用 `systematic-debugging` 定位，再回到当前 TDD 切片。
- 最终提交必须包含 `#2`，便于 `/code-review` 自动找到规格。
- 完成、验证和提交后，在 Issue #2 评论验收证据并关闭 Issue；不要修改或关闭父 Issue #1。
