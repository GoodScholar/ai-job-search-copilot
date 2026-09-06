# Issue #53 一键生成完整推荐结果设计

## 目标与边界

本设计实现 GitHub Issue #53：让目标求职者从求职工作台通过“开始今日发现”启动一次完整、持久化且可恢复的推荐运行，依次完成岗位发现、资格门槛、粗排、深度匹配和推荐结果发布。

推荐运行最终必须发布且只发布一个可信推荐结果：包含至少一项岗位的推荐清单，或者包含完整证据的“暂无推荐”。运行不会自动生成定制简历、填写外部页面、提交投递、发送邮件或联系招聘者。

本 Issue 复用现有岗位发现运行、深度匹配运行、BullMQ 队列、运行前检查、账户运行策略、Agent Inbox、审计轨迹和首次推荐旅程，不建立通用工作流引擎，也不改变每日检查计划的产品配置流程。

## 已确认假设

- 手动“开始今日发现”固定使用当前活动主求职目标，客户端不提交或切换其他目标。
- 一个发现根运行和它唯一的自动深度匹配子运行共同构成一个逻辑推荐运行；逻辑运行 ID 始终等于发现根运行 ID。
- 同一次启动请求的网络重放和并发重复点击复用同一个逻辑运行；逻辑运行到达终态后，用户可以使用新的启动命令在同一天明确重跑。
- 发现与深度匹配继续使用各自独立的冻结预算和恢复边界，不把两个预算相加为一个可互相挪用的额度。
- 自动深度匹配子运行继承逻辑运行启动时的运行前检查与账户策略快照；后续收紧的系统硬上限仍在安全检查点生效。
- 当前用户已有的手动单岗位重新评估继续使用既有深度匹配入口，不属于本设计的逻辑推荐运行。
- 每日检查计划的启动方式不在本 Issue 中改造；其现有发现与自动匹配行为继续兼容，新结果发布约束可被其自动匹配路径复用。

## 方案比较

### 方案 A：复用父子 Agent 运行并派生逻辑投影（采用）

保留现有发现运行与深度匹配子运行，以显式父子关系连接二者，在新的推荐运行领域模块中统一派生状态、阶段、预算、失败和最终结果。

该方案最大化复用已经验证的运行持久化、队列至少一次投递、claim lease、预算检查点、暂停、取消、恢复、审计和 Inbox 能力。复杂性集中在一个读取与命令 seam 后，不要求 Web、API 调用方或用户理解物理子运行。

### 方案 B：一条 Agent 运行执行全部阶段

使用一个新 workflow version 和一条 `agent_runs` 记录执行完整流程。该方案具有最直接的单运行身份，但需要拆分现有发现持久化终态、重新设计阶段恢复、组合执行规格和分段预算，并扩大已经复杂的运行处理器。它会削弱当前发现与匹配之间已经验证的故障隔离，因此不采用。

### 方案 C：新增独立推荐运行生命周期表

新增一张保存逻辑状态、阶段和失败的 `recommendation_runs` 表。虽然读取简单，但它会与 `agent_runs` 重复保存生命周期状态，每次物理运行变化都需要双写或对账，并形成第二套恢复权威，因此不采用。

## 领域模块与接口

新增深模块 `RecommendationRuns`。它的 interface 隐藏父子运行、内部步骤、队列、claim、Adapter 和持久化细节。

```ts
type RecommendationRunStageKey =
  | "discovery"
  | "qualification"
  | "coarse_ranking"
  | "deep_matching"
  | "result_publication";

type RecommendationRunStage = {
  key: RecommendationRunStageKey;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
};

type RecommendationRunPreparation = {
  target: {
    targetId: string;
    targetVersion: number;
    roleFamily: string;
  };
  sourceScope: {
    trustedSourceCount: number;
    publicQueryCount: number;
  };
  accountPolicyRevisionNumber: number;
  budgets: {
    discovery: AgentRunBudget;
    deepMatch: AgentRunBudget;
  };
  preflight: RunPreflightReport;
};

type RecommendationRunFailure = {
  code: RecommendationRunFailureCode;
  stage: RecommendationRunStageKey;
  summary: string;
  impact: string;
  retryable: boolean;
  suggestedActions: RecommendationRunSuggestedAction[];
};

type RecommendationRun = {
  runId: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  currentStage: RecommendationRunStageKey | null;
  stages: RecommendationRunStage[];
  target: RecommendationRunPreparation["target"];
  sourceScope: RecommendationRunPreparation["sourceScope"];
  accountPolicyRevisionNumber: number;
  budgets: RecommendationRunPreparation["budgets"];
  preflightSnapshot: RunPreflightSnapshot;
  result: RecommendationResult | null;
  failure: RecommendationRunFailure | null;
  createdAt: string;
  updatedAt: string;
};

type RecommendationRunQueries = {
  prepare(input: { userId: string }): Promise<RecommendationRunPreparation>;
  get(input: { userId: string; runId: string }): Promise<RecommendationRun | null>;
  latest(input: { userId: string }): Promise<RecommendationRun | null>;
};

type RecommendationRunCommands = {
  start(input: {
    userId: string;
    requestId: string;
    command: {
      idempotencyKey: string;
      warningFingerprint: string | null;
    };
  }): Promise<{ run: RecommendationRun; reused: boolean }>;

  control(input: {
    userId: string;
    requestId: string;
    runId: string;
    command: {
      commandId: string;
      action: "pause" | "resume" | "cancel";
    };
  }): Promise<{ applied: boolean; run: RecommendationRun }>;
};
```

`prepare` 与 `start` 复用同一个内部准备实现；`prepare` 是当前只读投影，`start` 在账户锁和数据库事务内重新计算并冻结启动条件，不能信任页面停留期间保存的目标、来源或预算。

## 运行前检查与启动摘要

统一运行前检查增加 `recommendation` workflow。它同时验证：

- 当前存在有效画像证据；
- 当前存在活动主求职目标；
- 至少一个真实岗位来源具备主动发现和读取详情能力；
- 来源健康状态允许就绪或带警告继续；
- 模型连接可用；
- 账户未全局停止；
- 发现预算和深度匹配预算分别可用。

`prepare` 返回用户可见的活动主求职目标、来源范围、账户策略版本和两段预算摘要。带警告的手动启动必须提交与最新报告一致的 warning fingerprint；阻塞或过期警告返回最新运行前检查，不创建任何运行。

启动命令不接受 `targetId`、workflow、Adapter、模型、预算或来源列表。这些值都由服务端从当前权威状态解析并冻结。

## 逻辑运行持久化

### `agent_runs` 增量

增加以下字段：

- `run_purpose`：`job_discovery`、`recommendation` 或 `opportunity_reevaluation`。
- `parent_run_id`：自动深度匹配子运行引用发现根运行；根运行为空。

数据库约束保证：

- 父子运行属于同一账户和同一求职目标；
- 运行不能引用自身；
- 每个推荐根运行最多存在一个自动深度匹配子运行；
- 推荐根运行必须是发现 workflow；其子运行必须是自动 `deep-match-v1`；
- 手动单岗位重新评估没有推荐根运行父级。

现有 `sourceScope.discoveryRunId` 继续保留在冻结执行规格中，但父子身份不再只依赖 JSON 字段推断。

### 启动幂等记录

新增窄表 `recommendation_run_start_commands`：

- `user_id`
- `idempotency_key`
- `root_run_id`
- `command_fingerprint`
- `created_at`

`(user_id, idempotency_key)` 唯一并绑定同账户根运行。同键同命令返回原运行；同键异义返回稳定冲突。

在账户 advisory lock 内，若账户已有尚未发布结果且根运行或子运行仍活跃的逻辑推荐运行，新启动命令作为 alias 指向该运行并返回 `reused: true`。这样即使两个并发点击意外产生不同 UUID，也不会创建两条逻辑运行。已有逻辑运行到达完成、失败或取消终态后，新命令可以创建新运行。

PostgreSQL 中的排队运行继续是执行权威；BullMQ enqueue 只负责唤醒。队列提交失败不回滚已持久化运行，由现有 reconciler 恢复投递。

## 阶段映射与数据流

逻辑运行的五个阶段从父子运行和不可变领域记录派生，不新增第二套可变阶段状态：

1. `discovery`
   - 根运行排队或执行发现内部步骤时为运行中。
   - 根运行成功完成并持久化本次发现结果后为完成。
2. `qualification`
   - 发现完成事务只读取本次根运行的发现结果，执行确定性资格门槛。
   - 对应不可变 triage 结果写入后为完成。
3. `coarse_ranking`
   - 对通过或信息待补充的本次岗位执行现有粗排规则并保存版本。
   - 本次候选和排除摘要冻结后为完成。
4. `deep_matching`
   - 唯一子运行排队、恢复或执行模型评估时为运行中。
   - 所有冻结候选已评估或候选集合可信为空时为完成。
5. `result_publication`
   - 子运行进入发布步骤时为运行中。
   - 推荐结果、Inbox、首次推荐旅程完成和子运行终态原子提交后为完成。

发现完成事务必须在把根运行置为完成之前：

1. 保存本次来源结果、健康和发现诊断；
2. 只从本次发现结果解析岗位机会；
3. 使用根运行冻结的画像与目标版本执行资格门槛和粗排；
4. 创建或复用不可变 `jobTriageVersions`；
5. 冻结本次候选、淘汰证据和推荐规则；
6. 创建唯一深度匹配子运行；
7. 完成根运行。

任一步失败都不留下“发现已完成但无法判断是否应创建子运行”的模糊状态。处理器通过现有失败路径终结根运行并创建 Agent Inbox 项。

自动子运行不重新执行会造成逻辑运行静默中断的第二次运行前检查；它继承根运行的快照。系统硬上限、全局停止、暂停、取消和预算仍在每个安全检查点重新约束实际动作。

## 推荐结果与证据

新增不可变 `recommendation_results` 表，每个逻辑推荐运行最多一个结果：

- `id`
- `user_id`
- `target_id`
- `root_run_id`
- `producer_run_id`
- `kind`
- `recommendation_list_id`，允许为空
- `evidence`，有界 JSON 对象
- `created_at`

约束如下：

- `(user_id, root_run_id)` 和 `(user_id, producer_run_id)` 分别唯一；
- `recommendation_list` 必须引用至少包含一项岗位的推荐清单；
- `no_recommendations` 不引用推荐清单；
- 结果、根运行、生产子运行和可选清单必须属于同一账户和求职目标；
- 对推荐清单结果，`recommendation_results.id` 与 `recommendation_list_id` 使用同一个 UUID，使既有首次推荐完成事实的 `resultId` 语义保持兼容；
- 证据不得包含岗位正文、画像正文、查询正文、URL、模型原始输出、密钥或直接身份字段。

推荐结果使用显式联合；空数组不能代表结果：

```ts
type RecommendationResult =
  | {
      kind: "recommendation_list";
      resultId: string;
      recommendationListId: string;
      itemCount: number;
      evidence: RecommendationResultEvidence;
      publishedAt: string;
    }
  | {
      kind: "no_recommendations";
      resultId: string;
      evidence: RecommendationResultEvidence;
      publishedAt: string;
    };
```

`RecommendationResultEvidence` 冻结：

- 来源覆盖：计划的可信来源数和公开查询数、已检查来源数、成功或可信 clean-zero 的分支、已验证岗位数；
- 覆盖损失：稳定原因代码、影响数量与是否可重试；
- 资格门槛：评估、淘汰、信息不足和过期数量；
- 粗排：合格、低于阈值、候选上限和进入深度匹配的数量；
- 深度匹配：已评估、质量不足和最终推荐数量；
- 最多两个去重后的有限建议动作。

证据必须满足计数闭包：

```text
发现岗位数
= 资格淘汰数
+ 信息不足数
+ 已过期数
+ 粗排淘汰数
+ 候选上限数
+ 进入深度匹配数

进入深度匹配数
= 匹配质量不足数
+ 最终推荐数
```

“暂无推荐”还必须满足最终推荐数为零，并且至少一个发现分支成功或形成可信 clean-zero。全部来源失败、预算耗尽、模型失败、持久化失败、取消或未完成运行都不能发布“暂无推荐”。

建议动作使用稳定枚举，并按证据以固定优先级选择：

- 存在可重试覆盖损失：重新开始今日发现；
- 来源覆盖明显受损：查看来源健康；
- 信息不足：完善求职画像；
- 资格或粗排大量淘汰：检查主求职目标。

## 原子发布与首次推荐旅程

深度匹配发布器在一个 fenced PostgreSQL 事务中：

1. 校验 claim、租约、控制状态和全部暂存结果；
2. 创建或复用不可变匹配版本；
3. 计算推荐规则并冻结完整证据；
4. 有推荐时创建非空推荐清单、项目和排除记录；
5. 无推荐时不创建伪装为空清单的记录；
6. 创建唯一推荐结果；
7. 创建推荐交付或需要关注的 Agent Inbox 项；
8. 调用 `recordFirstRecommendationJourneyCompletion`；
9. 完成子运行与最终事件。

任一步失败全部回滚。claim fence、候选唯一键、模型 usage key 和推荐结果唯一键共同保证 Worker 恢复或重复投递不会重复模型调用、匹配版本、清单、Inbox 或最终结果。

首次推荐旅程对两种可信结果都永久完成。新发布的推荐清单结果继续使用与清单相同的结果 UUID；“暂无推荐”使用自身结果 UUID。历史完成记录无需改写。

## 失败、部分成功与 Agent Inbox

物理运行失败继续使用稳定 `AgentRunFailureCode`，逻辑模块将失败映射到当前用户阶段。Inbox 投影补充或明确：

- 稳定中文摘要；
- 失败依据；
- 对本次推荐结果的影响；
- `retryable`；
- 与原因匹配的有限动作。

不可重试失败不显示无条件“重新运行”。模型鉴权或配置失败建议先检查模型连接；来源配置或能力问题建议查看来源；预算耗尽建议检查账户运行策略；暂时性来源或模型故障才允许直接重试。

部分来源失败但至少一个分支成功时，根运行使用现有 `completed_with_source_issues` 语义，保留有效岗位并继续资格、粗排和深度匹配。最终推荐清单或“暂无推荐”都必须在证据中显示覆盖损失；相关 discovery attention 可以继续独立进入 Inbox。

若发现与匹配之间的资格/粗排 handoff 失败，根运行保持失败而不是完成；若子运行失败，逻辑运行投影为失败。两种情况都进入 Agent Inbox，且不会发布推荐结果或完成首次推荐旅程。

## 逻辑控制与恢复

`control` 在账户锁内解析当前活动物理运行：

- 发现阶段控制根运行；
- 根运行完成且子运行活动时控制子运行；
- 阶段切换竞争返回稳定冲突，客户端刷新权威投影后重试。

逻辑控制命令需要以 `(user_id, root_run_id, command_id)` 保持幂等，并记录命令实际作用的物理运行。相同命令在阶段切换后重放不得错误作用于另一个物理运行。

页面离开不影响后台运行。工作台返回时使用 `latest`，带 `runId` 的链接使用 `get`；两者都从 PostgreSQL 当前状态派生五阶段投影。UI 不把本地状态当作业务权威。

本 Issue 不要求新增第二套逻辑事件表。工作台使用有界轮询刷新逻辑投影；现有物理运行 SSE 继续服务已有详情与兼容入口。轮询只在逻辑运行非终态且页面可见时执行，页面隐藏或运行终态时停止。

## HTTP 与 Web 适配

新增认证接口：

- `GET /v1/recommendation-runs/preparation`
- `POST /v1/recommendation-runs`
- `GET /v1/recommendation-runs/latest`
- `GET /v1/recommendation-runs/:runId`
- `POST /v1/recommendation-runs/:runId/controls`

Web BFF 提供同源对应路由，只从会话读取账户身份，严格拒绝客户端提交 `userId`、`targetId`、预算、workflow 或来源配置。所有读取和错误响应使用 `Cache-Control: no-store`，上游原始错误正文不会回显。

工作台新增或重构为一个统一推荐运行面板：

- 按钮文案为“开始今日发现”；
- 启动前展示主求职目标、来源范围、账户策略版本和两段预算摘要；
- 运行前检查阻塞时禁用启动并显示现有修复入口；
- 带警告时要求明确确认；
- 运行中显示五阶段有序时间线、当前阶段和已完成阶段；
- 返回页面后恢复同一逻辑运行；
- 推荐清单结果链接到推荐页面；
- “暂无推荐”直接显示覆盖、淘汰、信息不足、降级与建议动作；
- 暂停、继续和取消通过逻辑控制接口执行。

推荐页面读取最新推荐结果。推荐清单结果继续展示现有岗位、匹配证据、风险和优先级，并增加覆盖证据摘要；“暂无推荐”显示完整证据与有限建议动作。现有推荐清单历史和单岗位重新评估继续保持原接口，本 Issue 不新增通用结果历史浏览器。

页面使用结果导向中文，不暴露 Agent、队列、Adapter、workflow、claim、模型密钥或数据库术语。

## 响应式与无障碍

- 阶段使用有序列表和文本状态，不能只依赖颜色；
- 启动、确认、暂停、继续和取消均使用语义化按钮；
- 交互控件具有可见焦点和至少 44px 触控目标；
- 移动端单列展示启动摘要、时间线和结果，不产生水平滚动；
- 状态更新使用适量 `aria-live`，不重复朗读整张页面；
- 轮询刷新不夺取焦点；
- 动画遵循 `prefers-reduced-motion`。

## 测试策略

### 契约与迁移

- 严格校验准备摘要、五阶段顺序、逻辑运行、失败和两类推荐结果；
- 未知字段、空推荐清单结果、无闭包证据和超过动作上限必须拒绝；
- 验证父子账户/目标/workflow 约束、唯一子运行、启动命令幂等和每根运行唯一结果；
- 验证推荐结果 kind 与清单引用互斥，以及历史完成事实兼容。

### 领域与 Worker

- 同键同命令重放、同键异义冲突、不同键并发重复点击复用同一活动逻辑运行；
- 本次发现范围限定，目标下历史岗位不得进入本次资格、粗排或匹配；
- 发现为零、资格全淘汰、信息不足、粗排全淘汰和深度匹配全拒绝分别发布证据闭合的“暂无推荐”；
- 全来源失败只发布失败，部分来源失败继续并冻结覆盖损失；
- 推荐清单与“暂无推荐”发布都与 Inbox、运行终态和首次推荐旅程完成保持原子；
- 队列 enqueue 失败、至少一次重复投递、过期 lease、Worker 重启和每个物理阶段崩溃恢复不重复领域副作用；
- 暂停、继续、取消、全局停止、claim 丢失和预算耗尽不能越过发布 fence；
- 所有查询、命令、父子关系和结果保持跨账户隔离。

### API 与 Web

- 认证、严格请求、201/200 幂等状态、404 账户隐藏、409 运行前检查或命令冲突；
- 准备摘要与实际启动重新检查的过期状态处理；
- 逻辑控制跨阶段解析和命令重放；
- 轮询只在页面可见且运行非终态时继续；
- 推荐清单、可信“暂无推荐”、部分成功和失败文案；
- 键盘、焦点、触控尺寸、Axe 和移动端无横向滚动。

### Playwright 验收

必须覆盖 Issue 指定的五个场景：

1. 一键启动后发布推荐清单；
2. 一键启动后发布有完整证据的“暂无推荐”；
3. 部分来源失败时保留其他来源结果并显示覆盖损失；
4. 重复点击或响应重试只产生一个逻辑运行和一个推荐结果；
5. 页面离开后运行继续，返回工作台恢复当前与已完成阶段。

同时断言运行未创建定制简历、投递准备包或投递执行记录，也未触发页面填写、外部提交、邮件或招聘者联系。

## 非目标

- 不创建通用可配置工作流、DAG、插件步骤或补偿 DSL。
- 不合并发现与深度匹配的物理运行和预算。
- 不改造每日检查计划配置或调度产品流程。
- 不改变手动单岗位重新评估语义。
- 不新增推荐结果历史浏览器、定制简历或投递功能。
- 不执行任何外部行动。
