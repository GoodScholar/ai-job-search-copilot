# Agent 运行控制、预算与失败恢复设计

## 目标

交付 GitHub Issue #10：让目标求职者能够理解并控制岗位发现 Agent 运行，并让暂停、恢复、取消、有限重试、预算耗尽、Worker 恢复、Agent Inbox 与脱敏审计共享同一个可持久化事实源。

本切片建立后，用户可以看到一次运行使用的求职目标、来源范围、工作流或模型版本、当前步骤、预算上限及消费值；控制命令会立即留下可观察的请求状态，但只在安全检查点改变 Worker 行为。API、Worker、Redis 或队列重启不能丢失控制意图，也不能重放已经提交的岗位领域结果。

## 现状与约束

Issue #9 已交付首条持久化岗位发现纵切：

- PostgreSQL 保存 Agent Run、步骤、事件和岗位结果，是权威事实源。
- BullMQ 只负责唤醒，Worker Reconciler 恢复排队运行和租约过期运行。
- Worker 使用 claim token 和租约隔离并发执行者。
- Fake Job Discovery Adapter 通过固定公司来源发现最多五个岗位。
- SSE 从 PostgreSQL 事件回放进度，Next.js BFF 保持 Bearer Token 服务端可见。
- 来源发布记录、岗位机会和运行结果通过唯一键实现幂等持久化。

#10 延续这些边界，不把队列状态提升为业务事实，不引入通用工作流引擎，也不让模型自由选择工具。当前 Fake 流程仍不调用模型、不访问真实招聘网站、不执行外部写入。

## nanobot 借鉴边界

参考 `HKUDS/nanobot` 的以下设计思想：

- 分离运行编排与模型/工具执行，保持核心执行路径可读。
- 用不可变运行规格描述模型、工具和迭代限制，用统一运行结果描述用量和停止原因。
- 工具名称、Schema 和允许集合稳定，动态输入在拥有它的边缘解析。
- 模型用量记录只保存 provider、model、Token、耗时和稳定结果，不复制请求或响应内容。
- 进度事件属于运行事实，WebSocket、SSE 或其他交付方式只是投影。
- 运行自检和控制只暴露允许字段，不把完整内部对象交给模型或客户端。

不引入 nanobot 运行时依赖，不采用其会话文件或内存作为业务状态，不开放 Shell、MCP、动态插件或运行时自修改能力，也不使用进程内任务取消替代持久化控制意图。

## 推荐架构

继续采用“PostgreSQL 是事实源，BullMQ 是唤醒机制”，并把当前 Agent Run 领域实现深化为三个外部接口较小的模块：

```text
Workbench / Agent Inbox
        │ authenticated command
        ▼
AgentRunCommands
        │ one PostgreSQL transaction
        ▼
run state + control intent + budget usage + event + inbox + audit
        ▲
        │ checkpoint()
AgentRunProcessor ── JobDiscoveryAdapter / DiscoveryContentStore
        │
        ▼
BullMQ wakeup and bounded retry only
```

- `AgentRunCommands` 创建运行并接受暂停、恢复和取消命令。
- `AgentRunProcessor` 执行固定步骤，只通过统一检查点读取控制意图、结算预算、续租并决定下一步。
- `AgentRunQueries` 返回账户隔离的权威运行详情、事件回放和 Inbox 投影。

API Controller、BullMQ Consumer、SSE 和 React 不复制状态转换规则。复杂度集中在领域模块，调用方只处理严格结果。

现有 `packages/domain/src/agent-runs.ts` 已同时承担命令、查询、租约、执行、预算和持久化。实现时保留 `@job-copilot/domain/agent-runs` 对外入口，但将内部实现拆为控制、执行和查询文件；拆分只服务于 #10，不顺手重构岗位持久化或其他领域模块。

## 运行计划快照

运行启动时冻结下列 `AgentRunExecutionSpec`：

```ts
type AgentRunExecutionSpec = {
  targetSnapshot: AgentRunTargetSnapshot;
  sourceScope: AgentRunSourceScope;
  workflowVersion: "job-discovery-workflow-v1";
  ruleVersion: "fake-job-discovery-rules-v1";
  adapter: "fake";
  adapterVersion: "fake-job-discovery-v1";
  outputSchemaVersion: "job-discovery-result-v1";
  toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"];
  model: null;
  budget: AgentRunBudget;
};
```

当前 Fake 工作流不调用模型，所以模型快照为 `null`，模型调用和 Token 上限及消费值均为零。界面明确显示“本流程未使用模型”，同时显示工作流、规则、Adapter 和输出结构版本。

现有 #9 字段仍是快照的存储事实。迁移新增显式规则版本、工具白名单和模型快照，并从已有固定工作流常量确定性回填；不修改旧运行的目标、来源、预算、Adapter 或输出版本。旧运行的历史消费没有可靠明细时标记为不完整，不伪造精确值；#10 创建的新运行必须具有完整消费账本。

## 生命周期与控制状态

运行生命周期和控制意图分开保存：

```text
status:
queued -> running -> paused
                  -> completed
                  -> failed
                  -> cancelled

control_state:
none | pause_requested | cancel_requested
```

新增终态 `cancelled`，新增非终态 `paused`。`control_state` 表达已经接受、但尚未到达安全检查点的命令，因此不需要制造 `pause_requested` 和 `cancel_requested` 生命周期组合状态。

`current_step` 在暂停时保留最后一个安全步骤，便于用户理解停在哪里；排队后尚未开始时仍为 `queued`。恢复重新排队时把 `current_step` 设回 `queued`，历史步骤和事件继续保留。取消后设为 `cancelled`，因此公共 `AgentRunCurrentStep` 增加 `cancelled`。工作台把 `queued`、`running` 和 `paused` 都视为尚未结束的运行；用户必须恢复或取消暂停运行后，才能从该卡片启动新的发现运行。

### 暂停

- `queued + pause`：排队本身是安全检查点，事务内直接进入 `paused`。
- `running + pause`：保持 `running`，写入 `pause_requested` 和 `run.pause_requested`。
- `pause_requested + pause` 或 `paused + pause`：返回当前状态，不新增事件、Inbox 项或审计。
- Worker 在下一个检查点把运行原子转为 `paused`、清除 claim 和控制意图、写入 `run.paused`，并创建一个 `decision_required` Inbox 项。

### 恢复

- `paused + resume`：进入 `queued`、清除控制意图、写入 `run.resumed`，提交后 best-effort 重新入队。
- `running + pause_requested + resume`：在 Worker 尚未停下时撤销暂停意图，保持 `running` 并写入 `run.resume_requested`。
- 已经 `queued` 或 `running` 且没有暂停意图时重复恢复是无变化成功。
- 恢复解决对应 `decision_required` Inbox 项。

只读发现步骤可以在恢复后安全重做；来源发布记录、岗位机会和运行结果继续依赖唯一键与终态提交事务，不重放已提交领域结果。

### 取消

- `queued|paused + cancel`：当前即为安全检查点，直接进入 `cancelled`。
- `running + cancel`：保持 `running`，写入 `cancel_requested` 和 `run.cancel_requested`。
- 取消优先于暂停；已经接受取消后，暂停和恢复不能撤销取消。
- Worker 在检查点清理当前 claim 写入但尚未提交的对象，然后进入 `cancelled`、清除 claim 和控制意图、写入 `run.cancelled`。
- `cancelled + cancel` 是无变化成功；`completed|failed + cancel` 返回稳定冲突。
- `cancelled` 不可恢复。用户若仍希望运行，必须创建新运行。

### 控制命令幂等

每个控制命令带客户端生成的 UUID `commandId`。数据库保存运行、命令 ID、动作、首次结果版本和时间，唯一约束 `(user_id, run_id, command_id)`。

- 相同 `commandId` 重放同一动作时返回首次结果，不重复事件或审计。
- 相同 `commandId` 重放不同动作时返回稳定冲突。
- 使用不同 `commandId` 重复提交已达到的动作，基于当前状态返回 `applied: false`。
- 所有状态判断和控制记录位于同一个账户级事务中。

## 安全检查点

Worker 只在以下位置应用控制意图和预算决定：

1. 领取运行并建立 claim 后；
2. 每个来源请求前；
3. 每个来源请求返回后；
4. 每个步骤开始和完成处；
5. 对象存储写入后、领域结果事务提交前；
6. 领域结果事务提交后。

检查点返回严格判别联合：

```ts
type AgentRunCheckpointDecision =
  | { decision: "continue"; claimToken: string; usage: AgentRunUsage }
  | { decision: "pause" }
  | { decision: "cancel" }
  | { decision: "budget_exhausted"; dimension: BudgetDimension }
  | { decision: "stale" };
```

结果持久化事务必须同时验证 `claim_token` 和 `control_state = none`。如果控制命令在对象写入后、领域提交前到达，迟到提交不能成功；Worker 清理当前 claim 的未提交对象，再由检查点执行暂停或取消。

## 预算模型

沿用 #9 固定预算值，但把消费值持久化：

```ts
type AgentRunBudget = {
  maxActiveDurationMs: 60_000;
  maxAttempts: 3;
  maxToolCalls: 10;
  maxResults: 5;
  maxModelCalls: 0;
  maxTokens: 0;
};

type AgentRunUsage = {
  activeDurationMs: number;
  attempts: number;
  toolCalls: number;
  sourceRequests: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  results: number;
  complete: boolean;
};
```

`maxDurationMs` 在公共契约中迁移为语义更准确的 `maxActiveDurationMs`；迁移兼容旧快照，不把排队或暂停时间算入预算。

### 消费规则

- Worker 每次成功领取运行时消费一次 `attempts`。
- 每个来源 Adapter 方法调用前，同时预占一次 `toolCalls` 和 `sourceRequests`。
- 预占发生在外部调用之前；Worker 崩溃不会退回预占，避免通过重启绕过上限。
- 每条消费具有稳定 `usageKey`，同一检查点或调用的重复数据库提交不会重复计费。
- 活跃时间在租约心跳和安全检查点结算。只有 Worker 持有有效 claim 的执行区间计入；排队、暂停和重试退避不计。
- 当前流程不允许模型调用，因此任何非零模型调用或 Token 消费都被视为执行器错误并安全终止。
- 结果数量在领域结果事务中结算，不能超过 `maxResults`。

数据库保存不可变使用明细，并在 `agent_runs` 保存同事务更新的聚合值供详情查询。使用明细只包含运行 ID、稳定 usage key、类别、数量、步骤、尝试次数和时间，不保存目标文本、岗位正文、提示词、模型输出、异常或对象 key。

任一操作开始前发现预算不足时不执行该操作。运行进入 `failed`，终止原因使用 `budget_exhausted` 和具体预算维度，并只创建一个预算 Inbox 项。

## 持久化模型

迁移在 `agent_runs` 增加：

- `control_state`、`rule_version`、`tool_allowlist`、`model_snapshot`。
- `active_slice_started_at` 与聚合消费列 `active_duration_ms`、`tool_call_count`、`source_request_count`、`model_call_count`、`input_token_count`、`output_token_count`、`total_token_count`、`result_count`。
- `usage_complete`，用于诚实区分 #10 完整账本和缺少历史明细的旧运行。
- `termination_kind`、`termination_budget_dimension`、`retry_of_run_id`。

`attempt_count` 继续作为累计领取次数，不增加第二个重试计数事实源。所有聚合消费列为非负整数，并与使用明细在同一事务中更新。

新增 `agent_run_control_commands`：

- `id`, `user_id`, `run_id`, `command_id`, `action`。
- `applied`, `result_run_version`, `created_at`。
- 唯一约束 `(user_id, run_id, command_id)`。
- 复合外键保证命令和运行属于同一账户。

新增 `agent_run_usage_entries`：

- `id`, `user_id`, `run_id`, `usage_key`。
- `category`: `active_duration | tool_call | source_request | model_call | input_tokens | output_tokens | result`。
- `amount`, `step_key`, `attempt_count`, `created_at`。
- `amount` 必须为正整数，唯一约束 `(run_id, usage_key, category)`。
- 复合外键保证明细和运行属于同一账户。

一次来源请求使用同一个基础 operation key，但分别写入 `tool_call` 和 `source_request` 类别，因此两项聚合可以独立展示，重复事务又不会重复计费。Token 输入、输出和总量由输入与输出明细确定性聚合，不单独写一条可能不一致的 `total_tokens` 明细。

## 有限重试与恢复

- 只有 Adapter 明确返回 `retryable: true` 的来源失败，以及明确分类为可重试的内容存储或数据库失败，才会安排重试。
- 每次重试先结算当前活跃时间并检查全部累计预算。
- 仍有预算时释放 claim、回到 `queued`、写入 `run.retry_scheduled`，由 BullMQ 或 Reconciler 唤醒。
- 达到次数或其他预算上限时不再入队，安全终止为预算耗尽。
- 非重试错误立即安全失败。
- 领域失败策略同时定义 `source` 和 `model` 类别的可重试语义。只有执行规格允许模型且存在剩余模型调用、Token、尝试和时间预算时，类型化模型临时错误才可重试；鉴权、内容策略、无效响应和预算错误不可重试。当前 Fake 发现规格的模型能力为 `null` 且模型预算为零，因此生产流程不能进入模型调用分支；纯领域策略测试仍锁定后续模型工作流必须遵守的有限重试规则。
- API 入队失败不撤销已提交命令；恢复扫描补偿 `queued` 运行。
- Reconciler 只扫描 `queued` 和租约过期的 `running`，不扫描 `paused` 或任何终态。
- Worker 重启后从数据库中的步骤、事件、控制意图、claim、消费账本和领域结果恢复；Redis 任务不能覆盖这些事实。

## 终止结果与稳定错误

运行详情使用结构化终止结果：

```ts
type AgentRunTermination = {
  kind:
    | "completed"
    | "cancelled_by_user"
    | "source_failed"
    | "content_storage_failed"
    | "persistence_failed"
    | "budget_exhausted";
  failureCode: AgentRunFailureCode | null;
  budgetDimension:
    | null
    | "active_duration"
    | "attempts"
    | "tool_calls"
    | "model_calls"
    | "tokens";
};
```

现有稳定失败码继续保留。预算耗尽增加具体 `budgetDimension`，用户文案由稳定枚举映射生成，不展示原始异常文本。

## Agent Inbox

#10 创建最小但完整的 Agent Run Inbox 纵切，不建设通用通知平台。

### 数据

`agent_inbox_items`：

- `id`, `user_id`, `run_id`, `trigger_event_sequence`。
- `kind`: `run_failed | budget_exhausted | decision_required`。
- `status`: `open | resolved`。
- `reason_code`, `budget_dimension`。
- `created_at`, `resolved_at`。
- 唯一约束 `(run_id, trigger_event_sequence, kind)`。

`agent_inbox_item_actions`：

- `id`, `user_id`, `item_id`, `action_id`。
- `action`: `restart_run | resume_run | cancel_run | dismiss`。
- `outcome`: `applied | no_change | failed`。
- `related_run_id`, `reason_code`, `created_at`。
- 唯一约束 `(user_id, item_id, action_id)`。

Inbox 项只存稳定原因和内部 ID。标题、说明及可用动作由严格契约和当前权威状态投影，不保存模型生成文案。

### 行为

- 安全暂停创建 `decision_required`，成功恢复或取消后自动解决。
- 普通终态失败创建 `run_failed`。`restart_run` 使用当前仍有效的求职目标版本创建新运行，保存 `retryOfRunId`；创建成功后解决旧项。
- 预算耗尽创建 `budget_exhausted`，提供“调整求职目标”和 `dismiss`。导航到目标页面不冒充已处理，只有明确 dismiss 或成功创建替代运行才解决。
- 相同触发事件只能创建一个 Inbox 项。
- Inbox 动作同样使用 UUID 幂等键；重放不重复创建运行、事件或审计。

## HTTP 与 BFF

API 新增：

```http
POST /v1/agent-runs/:runId/controls
Content-Type: application/json

{
  "commandId": "uuid",
  "action": "pause" | "resume" | "cancel"
}
```

返回权威运行摘要和 `applied`。新应用或无变化成功均返回 `200`；不存在和跨账户返回非披露式 `404`；命令 ID 冲突或不允许的终态转换返回稳定 `409`。

运行详情扩展执行规格、控制状态、消费值、剩余值、终止原因和重试历史。现有创建、latest、detail 和 SSE 路径保持兼容。

Inbox 新增：

- `GET /v1/agent-inbox?status=open`
- `POST /v1/agent-inbox/:itemId/actions`

动作请求严格包含 `actionId`、动作和动作需要的参数；API 从认证会话取得 owner。Next.js 新增对应 same-origin BFF，浏览器不能读取 Bearer Token。

## SSE 与工作台

新增事件：

- `run.pause_requested`
- `run.paused`
- `run.resume_requested`
- `run.resumed`
- `run.cancel_requested`
- `run.cancelled`
- `run.budget_updated`

`run.budget_updated` 只携带聚合数字，不逐条复制调用 metadata。事件序号和 run version 继续单调递增。

SSE 在 `paused`、`cancelled`、`completed` 或 `failed` 事件后关闭。恢复后客户端使用相同运行级游标重新连接，因此时间线连续且不重复。

工作台运行卡增加：

- 求职目标名称与版本。
- 当前步骤、来源范围和重试次数。
- 工作流、规则、Adapter、输出结构和模型信息。
- 时间、来源请求、工具调用、模型调用、Token、结果和尝试预算的已用/上限。
- 只在允许状态显示的暂停、继续和取消按钮。
- “等待安全暂停/取消”的中间反馈。
- 稳定终止原因和下一步动作。

首页新增 Agent Inbox 区域，只显示当前账户的开放事项。所有关键控件满足 44px 触控目标、键盘操作、可见焦点、语义化状态和非颜色依赖表达；移动端不得横向溢出。

## Fake 场景与验收控制

Playwright 必须稳定验证暂停、取消、一次重试成功和预算耗尽，但普通用户文本不能触发隐藏故障。

Worker 引入 `JobDiscoveryAdapterResolver` 内部 seam：

```ts
interface JobDiscoveryAdapterResolver {
  resolve(input: {
    adapter: string;
    adapterVersion: string;
    runId: string;
    idempotencyKey: string;
    attemptCount: number;
  }): JobDiscoveryAdapter;
}
```

普通本地和生产配置始终返回正常 Fake Adapter。只有显式 E2E 运行模式可以读取启动时固定的“幂等 UUID → 场景”映射：

- `slow_checkpoint`：来源调用保持有限延迟，让测试有时间请求暂停或取消。
- `retry_once`：第一次尝试返回类型化可重试错误，第二次成功。
- `retry_until_budget`：每次返回可重试错误，直到尝试预算耗尽。

Playwright 通过页面初始化脚本固定 `crypto.randomUUID()` 的测试值；产品接口、求职目标和岗位文本都不携带场景。E2E 场景配置在非测试运行模式下被拒绝，浏览器没有修改场景的接口。

这个 resolver 同时为 #11 的真实 Adapter 选择提供正确 seam，但 #10 只实现正常 Fake 与测试 Fake 两个 Adapter，不接入网络。

## 安全与脱敏审计

新增审计事件：

- `agent.run_pause_requested`
- `agent.run_paused`
- `agent.run_resume_requested`
- `agent.run_resumed`
- `agent.run_cancel_requested`
- `agent.run_cancelled`
- `agent.run_budget_consumed`
- `agent.run_budget_exhausted`
- `agent.run_retry_scheduled`
- `agent.inbox_opened`
- `agent.inbox_action_applied`
- `agent.inbox_resolved`

审计 metadata 只允许运行、步骤、版本、Adapter、模型或规则版本、稳定错误码、预算维度、消费数量、尝试次数、Inbox ID 和内部资源 ID。

以下内容不得进入普通日志、SSE、Inbox 或审计：

- 目标自由文本和职业资料正文；
- 岗位正文、搜索结果正文或原始 Adapter payload；
- 提示词、模型输入、模型响应或推理文本；
- 对象存储 key、访问凭据或异常堆栈。

所有读取和写入继续按 `userId` 绑定所有权。控制命令和 Inbox 动作不能接受客户端 owner 字段。Worker 不能把 Redis 载荷当作 owner 事实。

## 测试策略

### 契约与迁移

- 状态、控制意图、事件、执行规格、使用量、终止结果、控制命令和 Inbox Schema 严格拒绝未知字段。
- 迁移验证新表、唯一键、owner 复合外键、状态检查、非负消费和 JSON 对象约束。
- 旧 #9 运行可读取；历史消费不完整时明确标记，不伪造精确数字。

### 领域状态机

- 暂停、恢复、取消的每个允许状态和冲突状态都有表驱动测试。
- 重复 command ID、不同 ID 的相同命令和并发暂停/取消不会重复事件或审计。
- 取消优先于暂停，迟到 claim 不能提交结果。
- 每个预算维度消费、重复 usage key、边界值和耗尽前拒绝新操作都有测试。
- 失败、预算耗尽和安全暂停分别只创建一个正确 Inbox 项。
- Inbox 动作幂等，并按账户隔离。

### Worker 与恢复

- 在每个安全检查点注入暂停和取消，验证未提交对象清理及已提交结果不重放。
- Redis 丢失任务、Worker 重启、租约过期和重复交付从 PostgreSQL 恢复。
- `retry_once` 第二次完成；`retry_until_budget` 有限终止。
- Reconciler 不唤醒暂停和终态运行。

### API、BFF 与 SSE

- 认证、严格验证、账户隔离、200/404/409、命令幂等和队列失败补偿。
- SSE 回放新控制与预算事件，暂停和终态关闭，恢复续传不重复。
- BFF 只从 HttpOnly 会话读取 Bearer，并转发取消信号和稳定错误。

### Web 与 Playwright

- 组件测试覆盖详情字段、预算展示、控制按钮、请求中间态、稳定失败文案和 Inbox 动作。
- Playwright 使用真实 Web、API、Worker、PostgreSQL、Redis 和 MinIO，验证暂停、恢复、取消、一次重试成功、预算耗尽与刷新恢复。
- 桌面 Chrome 和移动 Safari 验证键盘、触控目标、状态语义和无横向溢出。
- 默认测试不调用真实模型、AnySearch 或招聘网站。

### 完整质量门

- `pnpm typecheck`
- `pnpm test`
- Issue #10 聚焦 Playwright 场景
- `pnpm build`
- `git diff --check`
- `pnpm lint` 单独记录现有与新增问题；不顺手修改 #10 之外的旧 lint 错误。

## 验收映射

1. 运行详情显示目标、步骤、来源、版本和预算：由执行规格、使用量 DTO 与工作台详情覆盖。
2. 暂停、恢复和取消幂等且只在检查点生效：由控制命令账本、`control_state` 和 checkpoint reducer 覆盖。
3. 来源和模型失败有限重试并安全终止：由类型化失败、累计预算和终止结果覆盖；当前模型预算为零。
4. API、Worker 或队列重启不重放领域结果：由 PostgreSQL 事实源、租约、唯一键和 Worker 集成测试覆盖。
5. 失败、预算耗尽和用户决策形成可处理 Inbox：由 Inbox 数据、动作和工作台区域覆盖。
6. 控制、预算和终止原因进入脱敏审计：由固定审计事件和 metadata allowlist 覆盖。
7. Playwright 验证暂停、取消、重试成功和预算耗尽：由 E2E-only Fake 场景 resolver 覆盖。

## 不在范围内

- 通用聊天 Agent 框架或自由规划循环。
- 动态工具选择、Shell、MCP、浏览器自动化或外部写入。
- 真实模型调用、真实招聘来源、AnySearch 或 ATS Adapter。
- 调度、Watchlist 管理、资格门槛、匹配和正式推荐。
- 邮件通知、截止提醒或通用通知中心。
- Temporal、Kafka、事件溯源或新的基础设施依赖。
- nanobot 运行时依赖或其代码的直接复制。
