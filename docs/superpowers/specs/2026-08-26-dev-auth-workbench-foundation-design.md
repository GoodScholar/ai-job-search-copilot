# Dev Auth 与求职工作台基础设计

**Issue:** [#2 MVP 01：打通本地全栈与 Dev Auth 求职工作台](https://github.com/GoodScholar/ai-job-search-copilot/issues/2)

**状态：** 已批准

## 目标

交付 AI Job Search Copilot 的第一条可运行产品纵切：开发者通过一个入口启动生产形态的本地基础设施、Web、API 和 Worker；目标求职者通过 Dev Auth 获得内部求职账户，并进入由真实 API 和持久化状态驱动的空状态求职工作台。

本切片同时建立后续功能共用的求职账户所有权、会话、共享契约、错误结构、审计轨迹、运行就绪检查和全栈测试接缝。它不展示虚假的推荐、候选事实或投递数据。

## 非目标

- 不实现微信 OAuth，只保留可替换的外部身份 seam。
- 不导入职业资料，不创建求职画像、岗位机会、推荐清单或投递记录。
- 不执行 Agent 业务任务，不建立运行计划、SSE 或 Agent Inbox。
- 不接入 OpenTelemetry、Sentry 或真实外部服务。
- 不重新设计营销首页，只将登录入口导向真实本地登录流程。

## 已选方案

本地运行采用宿主机应用进程与容器化基础设施的混合模式：

- Docker Compose 运行 PostgreSQL、Redis、MinIO 和 Mailpit。
- pnpm 在宿主机并行运行 Next.js Web、NestJS + Fastify API 和 NestJS standalone Worker。
- `pnpm dev` 负责启动并等待基础设施健康后再启动三个应用进程。
- `pnpm dev:down` 负责关闭本地基础设施。

该方案兼顾接近生产的存储与队列语义，以及开发阶段的热更新和调试效率。拒绝所有应用均容器化，因为首个纵切会承担不必要的镜像构建与调试成本；拒绝手动分步启动，因为不满足 Issue #2 的单入口验收标准。

## 架构

### 运行单元

`apps/web` 使用 Next.js App Router、React、TypeScript、Tailwind CSS 和现有 shadcn/ui 配置。它负责营销页、登录表单、求职工作台渲染与 BFF 行为。读取型页面优先使用 React Server Components；Client Components 只承担确有交互状态的控件。

`apps/api` 使用 NestJS + Fastify。它是求职账户、外部身份、会话、工作台摘要、所有权判断和审计轨迹的权威领域入口，并发布 OpenAPI。

`apps/worker` 使用 NestJS standalone + BullMQ。此切片不执行 Agent 业务，只连接真实 Redis 并发布带 TTL 的就绪心跳，为后续持久化 Agent 运行建立部署形态。

内部 Package 分为：

- 共享契约：Zod 请求、响应、事件和错误结构，并派生 HTTP/OpenAPI 使用的类型。
- 数据：Drizzle Schema、迁移、连接与事务入口。
- 领域：求职账户、会话和审计规则；不依赖 HTTP、React 或 BullMQ。

### 深模块与接口

账户与会话模块隐藏身份复用、会话 Token 生成与哈希、过期、撤销、事务和审计细节，只暴露四个领域接口：

```ts
type StartDevSession = (input: {
  subject: string;
  now: Date;
  requestId: string;
}) => Promise<{
  account: { userId: string };
  sessionToken: string;
  expiresAt: Date;
}>;

type AuthenticateSession = (input: {
  sessionToken: string;
  now: Date;
  requestId: string;
}) => Promise<{ userId: string } | null>;

type EndSession = (input: {
  sessionToken: string;
  now: Date;
  requestId: string;
}) => Promise<void>;

type GetWorkbenchHome = (input: {
  userId: string;
}) => Promise<WorkbenchHome>;
```

工作台接口返回最小 DTO，不暴露数据库记录：

```ts
type WorkbenchHome = {
  account: { userId: string };
  summary: {
    recommendations: 0;
    pendingFacts: 0;
    runningAgentRuns: 0;
    applications: 0;
  };
};
```

审计模块通过 `append` 与受控 `query` 接口集中执行事件模式校验和敏感字段拒绝。HTTP、身份和会话模块不能直接写审计表。

Worker 与运行就绪检查通过版本化心跳契约通信。Redis 是操作就绪信号的存储，不是求职账户或其他用户可见领域状态的权威来源。

## 数据模型

### `job_accounts`

- `id`：内部 UUID，即领域中的 `user_id`。
- `status`：首版只使用活动状态，但字段允许后续安全停用。
- `created_at`、`updated_at`。

### `external_identities`

- `provider` 与 `subject` 构成唯一身份。
- `user_id` 引用求职账户。
- 本切片只写入 `provider = dev`。
- 后续微信 Adapter 新增身份记录，不替换内部 `user_id`。

### `sessions`

- `id`：内部 UUID。
- `user_id`：会话所属求职账户。
- `token_hash`：随机会话 Token 的不可逆哈希，具有唯一约束。
- `expires_at`、`revoked_at`、`created_at`。
- 数据库不保存原始 Token。

### `audit_events`

- `id`、`occurred_at`、`request_id`。
- `event_type`、`outcome`、`reason_code`。
- 可为空的 `actor_user_id`、`resource_type`、`resource_id`。
- 经过模式白名单校验的最小化元数据。

当前事件包括登录成功、退出成功、会话验证拒绝和资源访问拒绝。事件不得包含 Cookie、会话 Token、Dev 身份值或职业资料。

## HTTP 与 BFF 契约

### API 入口

- `POST /v1/auth/dev/sessions`：仅本地环境和正确服务端共享密钥可调用。根据合成 `subject` 创建或复用求职账户并创建会话。
- `DELETE /v1/auth/sessions/current`：验证 Bearer 会话 Token 后撤销当前会话。
- `GET /v1/accounts/:userId`：返回当前求职账户的最小资源投影；路径账户与会话账户不一致时统一返回 `404`，用于固化资源所有权边界。
- `GET /v1/workbench/home`：验证会话，从会话推导 `user_id`，返回当前账户的工作台摘要。
- `GET /health/live`：只表示 API 进程可响应。
- `GET /health/ready`：检查 PostgreSQL、Redis、MinIO、Mailpit 与 Worker 心跳，并为每项依赖返回明确状态。
- `GET /openapi.json`：提供版本化 HTTP 契约。

API 错误统一返回：

```ts
type ApiProblem = {
  code: string;
  message: string;
  requestId: string;
};
```

稳定状态语义为：

- `401`：会话不存在、过期或已撤销。
- `403`：Dev Auth 在当前环境不可用或共享密钥无效。
- `404`：账户所有权不匹配时隐藏资源是否存在。
- `503`：必要依赖或 Worker 未就绪。

### 登录

1. 用户在 `/login` 点击“使用本地体验账户登录”。
2. Next.js Server Action 把表单视为不可信输入，重新校验站内 `returnTo`。
3. Server Action 使用仅服务端可见的 Dev Auth 共享密钥和固定本地体验 `subject` 调用 API。
4. API 验证本地环境，创建或复用求职账户，在事务中创建会话并追加审计事件。
5. API 只在该响应返回原始会话 Token；Next.js 将其写入 Cookie。
6. Server Action 重定向到已验证的站内目标，默认 `/home`。

Cookie 使用 `HttpOnly`、`SameSite=Lax`、`Path=/` 和明确过期时间；正式环境强制 `Secure`。Cookie 不包含 `user_id` 或其他个人信息。

### 工作台读取

`/home` 是受保护的 React Server Component 页面。它读取 Cookie 后通过 server-only API Client 将 Token 作为 Bearer 凭据发送到 NestJS。API 重新验证会话并从中推导 `user_id`。页面或浏览器不能提交一个账户 ID 来改变查询范围。

无会话或无效会话被重定向到 `/login?returnTo=/home`。工作台只展示真实数据：今日推荐、待确认事实、运行中的求职代理和投递记录均为 0，并提供首页、推荐、投递和画像顶层导航。

### 退出

退出 Server Action 调用 API 撤销当前会话，再删除 Cookie 并重定向到登录页。撤销接口幂等；重复退出不会恢复或创建会话。

## 本地运行与就绪检查

`pnpm dev` 的顺序为：

1. 检查 Docker 与 Compose 可用。
2. 启动 PostgreSQL、Redis、MinIO 和 Mailpit。
3. 等待 Compose healthcheck 全部成功；失败时输出具体依赖并停止。
4. 并行启动 Web、API 和 Worker，任一应用异常退出时终止同组宿主机进程。

API `/health/ready` 检查：

- PostgreSQL 可执行简单查询。
- Redis 可完成 ping。
- MinIO 健康端点和目标 bucket 可用。
- Mailpit 健康端点可用。
- Worker 心跳存在、符合共享 Zod 契约且未过期。

`pnpm dev:down` 关闭 Compose 资源；默认保留命名卷，避免每次开发丢失数据。测试环境使用独立项目名和一次性资源，不能连接开发数据卷。

## 安全设计

- Dev Auth 必须同时满足明确本地环境和服务端共享密钥。正式环境检测到 Dev Auth 配置时拒绝启动。
- 浏览器登录表单不接受自定义 Dev 身份。自动化测试通过服务端测试配置创建第二个合成身份以验证账户隔离。
- 会话 Token 使用密码学安全随机值；数据库只保存哈希；原始值不会进入日志、审计或客户端 JavaScript。
- 每个 Server Action 都重新验证输入和授权，不能把“页面上看不到按钮”当成安全措施。
- 每个账户资源由 API 根据会话推导所有者；客户端提供的资源标识还必须与所有者条件一并查询。
- 工作台 DTO 明确列出可返回字段，不序列化完整数据库记录。
- 审计元数据使用字段白名单和长度限制；发现禁止字段时拒绝写入，而不是依赖日志清洗补救。
- `requestId` 贯穿 Web 服务端调用、API 响应和审计事件，但不编码身份或业务内容。

## 界面设计

现有营销视觉与可访问性标准保持不变。登录页从“登录尚未开放”升级为明确的本地体验入口，同时继续说明正式 Beta 使用微信登录。

工作台使用现有冷白档案纸、近黑墨色、祖母绿和琥珀批注语言，但内容全部来自工作台 DTO：

- 页首显示 AI Job Search Copilot 和退出操作。
- 顶层导航为首页、推荐、投递、画像。
- 主标题回答当前状态，而不是展示模拟岗位。
- 四项摘要均显示 0，并明确告诉用户下一步是导入职业资料。
- 未实现的顶层区域呈现诚实空状态或不可用说明，不伪装成已完成页面。

页面支持键盘操作、可见焦点、44px 移动触控高度、减少动态效果、WCAG AA 对比度和无横向溢出。

## 测试设计

测试只观察已批准 seam 上的行为，不断言 Controller 私有方法、Drizzle 查询形状或内部调用次数。

### 主接缝：Playwright 全栈行为

通过真实 Web、API、Worker、PostgreSQL、Redis、MinIO 和 Mailpit 验证：

- 首次 Dev Auth 登录创建求职账户。
- 退出后再次登录复用同一 `user_id`。
- `/home` 展示真实空状态和正确导航。
- 退出使原会话失效。
- 第二个合成账户不能读取第一个账户的资源。
- 桌面、移动、键盘、触控尺寸、减少动态效果、横向溢出和 axe 无障碍要求。

### HTTP 接缝：运行中的 NestJS

使用真实 PostgreSQL/Redis 与隔离测试资源，通过 HTTP 验证：

- Dev Auth 环境限制和身份复用。
- 会话创建、验证、过期、撤销和幂等退出。
- 工作台 DTO、账户所有权、统一错误与 `requestId`。
- OpenAPI 与共享 Zod 契约一致。
- 依赖未就绪和 Worker 心跳过期时返回 `503` 及具体状态。

### 模块接缝：纯策略与审计

- 正式环境中的 Dev Auth 配置被拒绝。
- 站内回跳、Cookie 属性和错误映射。
- 审计 `append/query` 接口拒绝敏感字段并返回脱敏记录。
- Worker 心跳契约使用 Redis Adapter 和 Fake Clock 验证过期语义。

### TDD 顺序

1. 一键启动和依赖未就绪检测。
2. Dev Auth 首次登录和求职账户复用。
3. 会话验证、退出和过期。
4. 工作台真实空状态。
5. 跨账户拒绝和审计。
6. 完整 Playwright、移动端和无障碍验收。

每个行为执行一次红、最小实现、绿；不先批量编写所有测试。默认自动化不访问真实微信、招聘网站或模型服务。

## 验收映射

| Issue #2 验收项 | 设计落点 |
|---|---|
| 一条命令启动并检测依赖 | 本地运行与 `/health/ready` |
| 首次创建、再次复用 `user_id` | `external_identities` 唯一映射与 `startDevSession` |
| 安全 Cookie、退出、站内回跳 | BFF Server Actions、数据库会话和回跳策略 |
| 真实空工作台 | `/v1/workbench/home` 与 `/home` RSC |
| 共享契约、OpenAPI、所有权 | 契约 Package、API DTO 和会话派生所有者 |
| 登录、退出、拒绝访问审计 | `audit_events` 与审计模块 |
| Playwright 全流程与可访问性 | 已批准的主测试接缝 |

## 后续演进

本设计为后续 Tickets 提供真实 seam，但不提前实现其行为：

- 微信登录新增认证 Adapter，复用求职账户和会话模块。
- 职业资料导入复用所有权、对象存储和 Worker 运行形态。
- Agent 运行复用 Redis/BullMQ、Worker 与共享契约，但其权威状态仍进入 PostgreSQL。
- 推荐、简历和投递模块复用工作台 DTO 的聚合方式，并逐步替换当前真实 0 值。
