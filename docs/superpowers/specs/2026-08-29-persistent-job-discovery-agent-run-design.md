# 持久化岗位发现 Agent Run 设计

## 目标

交付 GitHub Issue #9 的首条岗位发现 Agent 纵切：登录用户从一个活动求职目标启动运行，独立 Worker 通过统一岗位发现端口和确定性 Fake Adapter 发现岗位，将来源发布记录、来源版本和岗位机会写入 PostgreSQL，并在工作台通过可回放的认证 SSE 展示排队、运行和完成进度。

本切片建立后续真实招聘来源、批量匹配和材料生成共同复用的持久化运行骨架。它不接入模型，不访问真实招聘网站，也不执行表单填写、投递、邮件或招聘者联系。

## 范围

本切片包含：

- 从一个当前活动求职目标启动岗位发现运行。
- 用户级幂等键，重复提交复用同一运行。
- 目标版本、目标快照、来源范围、工作流版本、预算、状态、步骤、版本和时间戳持久化。
- 统一 `JobDiscoveryAdapter` 端口，以及支持单次搜索、批量搜索、详情读取和类型化错误的 Fake Adapter v1。
- PostgreSQL 权威运行状态、BullMQ 唤醒、Worker 租约和数据库恢复扫描。
- 来源原文写入 MinIO，来源发布记录、不可变版本和岗位机会写入 PostgreSQL。
- 运行结果与岗位机会的显式关联和幂等去重。
- 账户隔离的运行查询和可回放 SSE。
- Next.js BFF 代理 HttpOnly 会话认证，工作台启动、进度、刷新恢复和结果展示。
- Vitest、Testcontainers 和 Playwright 纵切验证。

本切片不包含：

- 真实公司 Watchlist 管理界面、真实 ATS、聚合搜索或浏览器自动化。
- 岗位匹配分数、今日推荐、简历、求职信、面试准备或自动投递。
- LLM 调用、动态规划、自由工具选择或多 Agent 协作。
- 运行取消、人工审批暂停或通用工作流 DSL。
- PostgreSQL `LISTEN/NOTIFY`、Temporal、Kafka 或事务 Outbox。

## Agent 必要性与自治边界

产品领域把该过程称为“Agent 运行”，因为它是面向一个求职目标、可追踪且可恢复的后台过程。当前三个步骤完全确定，不需要模型推理或动态选择，因此实现为持久化工作流执行器，而不是引入 Agent 框架。

本切片的自治等级为受约束的内部写入：允许读取用户已确认的活动求职目标、调用 Fake 只读来源 Adapter，以及写入当前账户的运行、来源和岗位机会记录。它不能访问真实网站、付费服务、个人通信或执行外部写入。资源预算固定包含零模型调用和零 Token。

## 推荐架构

采用“PostgreSQL 是事实源，BullMQ 是唤醒机制”的方案：

```text
Workbench
  -> Next.js BFF
  -> authenticated API command
  -> PostgreSQL agent_runs + agent_run_events
  -> best-effort BullMQ enqueue
  -> Worker claim lease
  -> Fake JobDiscoveryAdapter
  -> MinIO raw source object
  -> source posting/version + opportunity + run result
  -> PostgreSQL event replay
  -> API SSE -> Next.js BFF -> Workbench
```

API 在 PostgreSQL 事务提交后尝试入队。入队失败不撤销已创建的运行，也不向用户谎报运行丢失；运行保持 `queued`。Worker 在启动时并按固定间隔扫描 `queued` 和租约过期的 `running` 记录，用确定性 `runId` 重新入队。Redis 丢失任务、Worker 重启或同一任务重复投递都不能丢失运行或重复岗位。

不采用 BullMQ `QueueEvents` 作为用户进度来源，因为 Redis 事件不能可靠回放。也不采用 Temporal 等通用编排系统，因为当前状态机和步骤数量不足以证明新增基础设施的成本。

## 模块边界

### 共享契约

`@job-copilot/contracts/agent-runs` 定义：

- 运行、步骤、事件和错误枚举。
- 启动命令、启动响应、运行详情、最近运行和结果 DTO。
- SSE 事件 DTO 和事件序号。
- BullMQ 队列、任务名和仅含 ID 的版本化任务载荷。
- 目标快照、来源范围和预算快照。
- 发现查询、批量查询、详情和判别式成功/错误结果 Schema。

所有边界使用严格 Zod Schema，拒绝未知字段。运行事件、队列载荷、日志和审计 metadata 不包含岗位原文。

### 数据库

`@job-copilot/database` 增加运行、步骤、事件和结果表。数据库约束负责账户所有权、幂等键、序号、状态范围、正版本、JSON 对象形状和跨表复合外键。

`job_opportunities.import_id` 改为可空。手动导入继续保存原关联；岗位发现不创建伪造的 `job_import`。来源证据继续通过 `source_posting_version_id` 和 `job_opportunity_sources` 表达。

### 领域模块

`@job-copilot/domain/agent-runs` 暴露三个深模块接口：

- `AgentRunCommands`：创建或复用运行，并尝试发出队列唤醒。
- `AgentRunQueries`：读取账户拥有的最近运行、详情、结果和事件回放。
- `AgentRunProcessor`：领取租约、记录步骤、调用发现端口、幂等持久化结果并进入终态。

调用方不直接拼接 Agent Run 状态转换 SQL。状态转换和对应事件在同一个 PostgreSQL 事务内写入。

### Adapter

- API 和 Worker 均可通过 `AgentRunQueue` 端口按 `runId` 幂等入队。
- Worker 的 `AgentRunReconciler` 扫描可恢复运行并补发任务。
- `FakeJobDiscoveryAdapter` 是唯一岗位来源 Adapter，无网络、Shell、浏览器或模型能力。
- `DiscoveryContentStore` 通过 MinIO 保存 Fake 来源详情的规范化原始 JSON。

## 固定版本与预算

本切片锁定：

- 队列：`agent-runs`
- 任务名：`discover-jobs`
- 任务载荷版本：`1`
- 工作流版本：`job-discovery-workflow-v1`
- Adapter：`fake`
- Adapter 版本：`fake-job-discovery-v1`
- 结果 Schema 版本：`job-discovery-result-v1`
- 最大运行时长：`60_000 ms`
- 最大 Worker 尝试：`3`
- 最大 Adapter 工具调用：`10`
- 最大岗位结果：`5`
- 最大模型调用：`0`
- 最大 Token：`0`
- 处理租约：`30_000 ms`
- 恢复扫描间隔：`1_000 ms`

来源范围固定为版本化 Fake 公司观察列表：

```json
{
  "kind": "company_watchlist",
  "adapter": "fake",
  "adapterVersion": "fake-job-discovery-v1",
  "sources": ["fake:aurora-careers", "fake:orbit-careers"]
}
```

这满足 ADR 0022 的“从公司观察列表开始”方向，但不在 #9 中提前实现 Watchlist 管理。

## 数据模型

### `agent_runs`

- `id`, `user_id`, `target_id`。
- `idempotency_key`：客户端生成 UUID；唯一约束 `(user_id, idempotency_key)`。
- `target_version`, `target_snapshot`：启动事务内复制当前活动目标。
- `source_scope`, `budget_snapshot`。
- `workflow_version`, `adapter`, `adapter_version`, `output_schema_version`。
- `status`: `queued | running | completed | failed`。
- `current_step`: `queued | batch_search | fetch_details | persist_results | completed | failed`。
- `version`：每次用户可观察的状态转换递增。
- `attempt_count`, `failure_code`, `claim_token`, `claim_expires_at`。
- `queued_at`, `started_at`, `completed_at`, `failed_at`, `created_at`, `updated_at`。

`target_id` 必须属于同一账户。只有启动瞬间仍为 `active` 的目标可以创建运行；之后目标被修改或停用不会改变已保存快照。

### `agent_run_steps`

- `id`, `user_id`, `run_id`。
- `step_key`: `batch_search | fetch_details | persist_results`。
- `ordinal`: `1..3`。
- `status`: `pending | running | completed | failed`。
- `attempt_count`, `started_at`, `completed_at`, `failed_at`, `failure_code`。

唯一约束 `(run_id, step_key)` 和 `(run_id, ordinal)`。Worker 恢复时允许安全重跑已经完成的只读步骤；步骤记录表示已观察到的进度，不作为中间业务结果的唯一存储。

### `agent_run_events`

- `id`：内部 UUID。
- `user_id`, `run_id`。
- `sequence`：每个运行从 1 开始单调递增。
- `run_version`。
- `event_type`: `run.queued | run.started | step.started | step.completed | run.retry_scheduled | run.completed | run.failed`。
- `data`：严格允许的状态、步骤、稳定失败码和结果数量，不含岗位正文。
- `created_at`。

唯一约束 `(run_id, sequence)`。SSE 的 `id` 使用十进制 `sequence`，因此断线重连可以按运行内游标回放，不依赖全局自增 ID。

### `agent_run_job_results`

- `id`, `user_id`, `run_id`, `opportunity_id`, `source_posting_version_id`。
- `ordinal`, `created_at`。

唯一约束 `(run_id, opportunity_id, source_posting_version_id)` 和 `(run_id, ordinal)`。该关联允许同一岗位在多个运行中被再次发现，同时阻止同一运行的重复处理产生重复结果。

## 启动与幂等语义

`POST /v1/agent-runs` 接受：

```json
{ "targetId": "uuid", "idempotencyKey": "uuid" }
```

API 从会话取得 `userId`。领域命令在账户 advisory lock 内：

1. 先按 `(user_id, idempotency_key)` 查找已有运行。
2. 已存在时忽略重复请求中的其他字段并返回同一运行，HTTP `200`。
3. 不存在时读取属于当前账户且当前为 `active` 的目标及其当前修订。
4. 原子写入运行、三个待处理步骤、`run.queued` 事件和脱敏审计事件，HTTP `201`。
5. 事务提交后 best-effort 入队；失败时运行仍为 `queued`，由 Reconciler 恢复。

稳定启动错误码：

- `AGENT_RUN_TARGET_NOT_FOUND`
- `AGENT_RUN_TARGET_INACTIVE`
- `AGENT_RUN_UNAVAILABLE`

不存在和不属于当前账户的目标都使用非披露式 `404`。幂等键不能跨账户复用运行。

## 状态机、租约与恢复

```text
queued -> running -> completed
queued -> running -> failed
running --expired lease--> running (new claim)
running --retryable failure--> queued
```

- Worker 通过条件更新领取 `queued` 或租约已过期的 `running` 记录，并设置新的 `claim_token`、租约和 `attempt_count + 1`。
- 有效租约存在时，重复 BullMQ 任务抛出可重试错误，不能把另一消费者的运行标成完成。
- 每次状态或步骤写入都要求当前 `claim_token`，旧 Worker 的迟到结果成为 `stale`。
- 可重试 Adapter/MinIO/数据库错误在仍有尝试预算时回到 `queued` 并记录 `run.retry_scheduled`；最后一次写入 `failed`。
- Worker 进程中断后，租约到期；Reconciler 扫描并补发同一个 `runId`。
- BullMQ 使用 `runId` 作为 `jobId`，任务载荷只有 `{ version, runId, userId }`。
- 来源写入、机会去重、运行结果、运行完成和终态事件位于同一个数据库事务；重复处理依赖唯一键和 upsert，不产生重复机会。

## Fake Job Discovery Adapter v1

端口定义三个操作：

```ts
interface JobDiscoveryAdapter {
  search(input: DiscoverySearchInput): Promise<DiscoverySearchResult>;
  searchBatch(input: DiscoveryBatchSearchInput): Promise<DiscoveryBatchSearchResult>;
  getDetail(input: DiscoveryDetailInput): Promise<DiscoveryDetailResult>;
}
```

所有返回值是判别联合：

```ts
type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; retryable: boolean } };
```

Fake Adapter 根据目标快照和固定来源夹具确定性返回最多 5 个摘要，再按摘要 ID 返回详情。详情包含稳定来源身份、官方来源标记、规范化岗位字段和用于对象存储的原始 JSON。测试通过构造器注入故障映射验证可重试和不可重试错误；生产本地 Fake 配置不根据用户文本触发隐藏故障。

主工作流调用 `searchBatch` 和 `getDetail`；`search` 作为统一端口的单来源能力由契约与 Adapter 单元测试覆盖，供后续真实来源逐个退化调用。

## 来源、原文与岗位机会持久化

Worker 将详情的规范 JSON 编码为 UTF-8，并保存到：

```text
accounts/{userId}/agent-runs/{runId}/sources/{sourceIdentifier}/{claimToken}/{sha256}.json
```

对象 key 只使用内部稳定标识，不使用职位名称、公司名称或用户输入。`claimToken` 隔离并发或过期领取者的对象清理，旧 claimant 永远不能删除新 claimant 的证据。`job_source_postings` 按 `(user_id, source_type, source_identifier)` 复用；规范化摘要与原始正文内容指纹均相同时复用已有来源版本，任一变化时追加版本。

岗位机会沿用现有账户内 `dedup_key`。发现运行创建机会时 `import_id = null`，并写入 `job_opportunity_sources`。已有机会被再次发现时只追加缺失的来源证据和当前运行结果；官方来源版本可以成为首选 `source_posting_version_id`。

原始来源正文、完整 Adapter 输出和对象 key不得进入 SSE、普通日志、审计 metadata 或错误响应。

## HTTP、SSE 与认证

API 新增：

- `POST /v1/agent-runs`
- `GET /v1/agent-runs/latest`
- `GET /v1/agent-runs/:runId`
- `GET /v1/agent-runs/:runId/events`

所有接口需要 Bearer 会话认证。运行和事件查询同时按 `runId + userId` 过滤；不存在与跨账户均返回 `404`。

事件端点接受 `Last-Event-ID` 请求头或 `afterEventId` 查询参数，两者均为非负整数；同时存在时从较大游标继续。服务端先回放数据库中 `sequence > cursor` 的事件，然后每 `250 ms` 查询新事件；空闲 `15_000 ms` 发送 SSE comment heartbeat。终态事件发出后关闭流。客户端重连不会重复应用小于等于当前游标的事件。

Next.js Route Handler 读取 HttpOnly 会话 Cookie，向 API 转发 Bearer、游标和取消信号，然后透传 `text/event-stream`。浏览器永远不能读取 Bearer Token。

## 工作台体验

工作台 RSC 并行读取工作台摘要、求职目标和最近 Agent Run：

- 没有活动目标时展示“先确认求职目标”并链接 `/profile/targets`。
- 有活动目标时展示目标选择和“发现岗位”按钮。
- 提交时客户端生成一次 UUID 幂等键；同一提交重试复用该键。
- 工作台显示排队、批量搜索、读取详情、保存结果、完成或失败的事件时间线。
- 浏览器把最后事件序号保存在 `sessionStorage` 的运行级键中；刷新后从服务器端最近运行详情恢复权威状态，并从该序号续传。
- 完成后重新读取运行详情并显示公司、职位、地点、发布时间和来源类型。
- 运行失败只显示稳定中文说明，不显示异常消息。

工作台 `runningAgentRuns` 从字面量 `0` 改为真实非负计数，仅统计 `queued` 和 `running`。发现到的岗位不是已匹配推荐，因此 `recommendations` 在 #9 仍保持 `0`。

为了让快速 Fake 执行也可验证进度，时间线保留已回放事件；测试不依赖人为延迟碰到瞬时状态。

## 安全、隐私与审计

- API 不接受客户端 owner 字段；Worker 不信任 Redis 中的 owner，仍按 `runId + userId` 查询。
- 目标快照只包含求职约束，不复制职业资料原文或个人联系方式。
- Fake Adapter 无网络、浏览器、模型、邮件、Shell 或写外部系统的能力。
- 岗位内容视为不可信数据，只作为数据保存和纯文本展示，不能改变工具、预算或工作流。
- 运行审计 metadata 只允许运行、目标、来源、机会 ID、版本、尝试次数、结果数量和稳定失败码。
- 新增审计事件：`agent.run_queued`、`agent.run_completed`、`agent.run_failed`。
- SSE 事件经过严格 Schema，不复制岗位描述或完整来源详情。

## 测试策略

### 契约与迁移

- 严格解析启动、运行、步骤、事件、结果、队列和发现 Adapter 契约。
- 锁定全部版本、预算和时间常量。
- 迁移验证表、唯一键、owner 外键、状态检查和 nullable `job_opportunities.import_id`。

### 领域集成

- 同账户同幂等键只创建一个运行；不同账户互不影响。
- 运行保存启动时的活动目标版本和快照。
- 不活动或跨账户目标不能启动。
- 状态转换与事件序号原子一致。
- 有效租约拒绝第二消费者；过期租约可恢复。
- 重复执行只产生一份来源版本、机会和运行结果。
- 同一岗位在不同运行中可复用机会并分别关联结果。
- Workbench 只统计当前账户的活动运行。

### Adapter 与 Worker

- Fake `search`、`searchBatch`、`getDetail` 返回确定性规范结果。
- 类型化可重试与不可重试错误不泄漏异常正文。
- API 入队失败后，Worker Reconciler 仍能发现并完成数据库中的运行。
- Worker 重启或任务重复交付不丢运行、不重复机会。
- BullMQ 载荷不包含目标快照或岗位正文。

### API 与 SSE

- 认证、参数校验、201/200 幂等语义和账户隔离。
- SSE 从 0 完整回放，从 `Last-Event-ID` 或 `afterEventId` 续传。
- 终态关闭、游标去重和事件 payload 脱敏。
- Next.js BFF 不向浏览器暴露 Bearer Token。

### Web 与 Playwright

- 从活动目标启动运行。
- 看到排队、运行步骤和完成时间线。
- 运行中刷新并从持久化状态恢复。
- 最终显示真实数据库岗位结果。
- 重复启动请求复用运行。
- 桌面 Chrome 和移动 Safari 保持键盘、44px 触控、无横向滚动和 axe 基线。

## 成功标准

- Issue #9 的每条验收标准都有对应自动化测试。
- Redis 不是运行状态或事件的唯一事实源。
- Worker 重启、任务丢失或重复任务不会丢运行或重复岗位。
- 所有运行、事件、来源和结果均按账户隔离。
- 工作台刷新后仍能恢复进度并展示最终岗位。
- 全量测试、类型检查、构建和本切片 Playwright 通过；已知无关 lint 问题单独披露，不在本切片顺手修改。
