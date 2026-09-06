# Issue #52 首次推荐旅程设计

## 目标与边界

本设计实现 GitHub Issue #52：让首次登录的目标求职者在求职工作台看到由真实领域状态推导、可中断恢复的首次推荐旅程，并在首个可信推荐结果发布后永久完成。

本 Issue 只负责旅程投影、必要交互状态和永久完成事实，不实现 #53 的“一键生成完整推荐结果”编排，也不新增导航、通用流程引擎、分析埋点或外部行动。

## 待确认的历史兼容假设

推荐方案如下：

- 历史上至少包含一项推荐的 `recommendation_lists` 视为已经发布过真实推荐清单，在迁移时为所属账户回填一次永久完成事实。
- 历史空清单没有 #53 将补齐的完整“暂无推荐”证据，不回填完成事实。
- 新产生的非空推荐清单在原有发布事务内记录完成事实。
- #53 的可信“暂无推荐”发布器完成证据校验和持久化后，调用同一个内部完成接口；普通空数组、失败运行和未发布结果不能调用该接口。

如果用户否决历史追溯，只替换迁移中的回填 SQL 与相应迁移测试；运行时模块、接口、页面和新结果完成语义保持不变。

## 方案比较

### 方案 A：交互状态与完成事实分表（推荐）

动态步骤完全由权威领域表和统一运行前检查推导。可变的提示关闭、最后访问步骤进入交互状态表；不可逆的首次结果完成进入独立表，并用数据库触发器禁止更新或删除。

优点是不会保存易漂移的步骤布尔值，完成事实的不可变性可由数据库验证，#53 只需要复用一个小接口。代价是新增两张窄表和一个内部完成接口。

### 方案 B：把所有状态放进一张旅程表

一张表同时保存关闭状态、最后访问步骤和完成信息，实现文件较少，但可变交互与不可变历史事实共享更新路径，容易误改完成信息，也难用数据库约束表达“部分字段可更新、部分字段永不变化”。

### 方案 C：完全从现有表动态推导

不新增表，页面每次从推荐清单等记录计算进度。该方案无法保证完成后永久关闭：如果未来清理或迁移来源记录，旅程可能重新打开；也无法跨设备保存提示关闭和最后访问步骤。

## 模块与接口

新增 `first-recommendation-journey` 领域模块，外部接口保持小而明确：

```ts
type FirstRecommendationJourneyReader = {
  get(input: { userId: string }): Promise<FirstRecommendationJourney>;
};

type FirstRecommendationJourneyCommands = {
  updateInteraction(input: {
    userId: string;
    command: FirstRecommendationJourneyInteractionCommand;
  }): Promise<FirstRecommendationJourneyInteraction>;
};

type RecordFirstRecommendationJourneyCompletion = (
  transaction: DatabaseTransaction,
  input: {
    userId: string;
    result: {
      kind: "recommendation_list" | "no_recommendations";
      resultId: string;
    };
  },
) => Promise<void>;
```

`Reader` 隐藏数据库聚合、运行前检查复用、当前步骤选择和历史完成优先级。Web 与 API 不重复解释领域表。`updateInteraction` 只接受两个判别命令：访问步骤和关闭提示。`RecordFirstRecommendationJourneyCompletion` 是发布器内部接口，不暴露为 HTTP 命令。

## 持久化模型

### `first_recommendation_journey_interactions`

- `user_id`：主键并引用求职账户。
- `last_visited_step`：允许为空，只能取六个稳定步骤 ID。
- `dismissed_at`：允许为空；关闭后不自动清除。
- `version`：从 0 开始的乐观并发版本；首次写入得到 1。
- `updated_at`：交互状态更新时间。

该表不保存任一步骤完成布尔值。

### `first_recommendation_journey_completions`

- `user_id`：主键并引用求职账户，保证每账户只有首个完成事实。
- `result_kind`：`recommendation_list` 或 `no_recommendations`。
- `result_id`：可信发布结果的稳定 UUID。
- `completed_at`：首次可信结果发布时间。

插入使用 `ON CONFLICT DO NOTHING` 保留首个结果。迁移创建触发器，拒绝任何 `UPDATE` 或 `DELETE`，使后续画像、目标、来源、模型或运行策略退化都不能重开旅程。

## 动态旅程投影

未完成且未关闭时返回六个有序步骤：

1. `career_materials` — “准备可用职业资料”
   - 完成：当前账户存在至少一个 `completed` 的职业资料导入。
   - 进行中：不存在完成导入，但存在 `queued` 或 `processing` 导入。
   - 待处理：其他情况。
   - 入口：`/profile`。
2. `profile_evidence` — “建立可信求职画像”
   - 完成：运行前检查包含 `PROFILE_EVIDENCE_READY`。
   - 待处理：`PROFILE_EVIDENCE_MISSING`。
   - 入口：`/profile`。
3. `primary_target` — “明确主要求职方向”
   - 完成：运行前检查包含 `PRIMARY_JOB_TARGET_READY`。
   - 待处理：`PRIMARY_JOB_TARGET_MISSING`。
   - 入口：`/profile/targets`。
4. `job_sources` — “接通真实岗位来源”
   - 完成：来源能力证据中的 `capableSourceCount > 0`；部分来源不足不抹掉已满足条件的真实来源。
   - 待处理：没有具备主动发现和详情读取能力的启用来源。
   - 入口：主目标存在时为 `/profile/targets/{targetId}/watchlist`，否则 `/profile/targets`。
5. `run_readiness` — “确认今天可以开始”
   - 完成：统一运行前检查为 `ready` 或 `ready_with_warnings`。
   - 待处理：检查为 `blocked`；影响与入口来自第一个阻塞检查项的稳定建议动作。
   - 入口映射只允许现有站内路径：画像、求职目标、来源、模型连接和账户运行策略。
6. `first_result` — “获得第一份推荐结果”
   - 完成：账户存在永久完成事实；完成后整个旅程不再显示。
   - 进行中：存在排队、运行或暂停中的发现/深度匹配运行。
   - 待处理：前置条件满足但尚无活动运行。
   - 入口：活动运行锚点或工作台的开始入口；#53 可在不改变投影契约的情况下替换为一键编排入口。

步骤状态固定为 `completed`、`in_progress`、`needs_action`、`waiting`。`currentStepId` 优先使用仍未完成的 `lastVisitedStep`；如果它已完成，则选择第一个未完成步骤。已完成旅程返回 `status: "completed"` 且不返回步骤；已关闭但未完成的旅程返回 `status: "dismissed"`，领域状态仍继续更新。

## 数据流

`GET /v1/workbench/home` 继续是工作台唯一首页读入口。工作台模块注入已有 `RunPreflightEvaluator`，以 `workflow=discovery`、`trigger=manual`、活动主求职目标计算统一报告，再把报告交给旅程模块生成投影。现有摘要、Inbox 和运行读取保持独立降级；旅程读取失败时只标记旅程区域不可用，不伪造空旅程或完成状态。

`PUT /v1/workbench/first-recommendation-journey` 接收访问步骤或关闭提示命令。Web BFF 使用会话 Cookie 转发，客户端在步骤入口点击时以 `keepalive` 保存访问步骤，但保存失败不阻止用户进入解决页面；关闭提示必须等待成功响应后隐藏，409 时刷新权威状态。

深度匹配发布事务在插入非空推荐清单项目后调用内部完成接口，使推荐结果、Inbox 项、运行完成与旅程完成位于同一事务。#53 的“暂无推荐”发布器以后在完整证据持久化事务中调用同一接口。

## 错误、并发与账户隔离

- 所有读写按 `user_id` 过滤，不接受客户端提交用户 ID。
- 交互更新使用 `expectedVersion`；并发更新只有一个成功，其他返回稳定 409。
- 完成事实插入幂等并保留第一个结果；并发发布不会覆盖来源或时间。
- 完成事实优先于关闭状态和动态条件，完成后交互命令不再改变用户可见旅程。
- 运行前检查不可读时，旅程区域显示局部错误，不把未知状态当作完成或待处理。
- 页面不显示内部 Agent、队列、Adapter、模型密钥或数据库术语。

## 响应式与无障碍

旅程卡位于工作台导语之后、摘要与 Inbox 之前。使用有序列表、文本状态和语义化按钮/链接；状态不依赖颜色。桌面显示紧凑步骤轨迹，移动端改为单列，不产生水平滚动。所有目标至少 44px，可见焦点沿用工作台全局样式；无非必要动画，继续遵守 `prefers-reduced-motion`。

## 测试策略

- 契约测试：严格 schema、稳定步骤顺序、交互命令判别与未知字段拒绝。
- 迁移测试：两张表约束、完成事实不可改删、历史非空清单回填、历史空清单不回填。
- 领域集成：每个权威状态变化对应步骤变化；交互跨读取恢复；完成幂等；空列表、失败或未发布运行不完成；完成后条件退化不重开；账户隔离。
- API/BFF：认证、严格命令、版本冲突、无用户 ID 注入、no-store 和局部错误。
- Web 模块：中文名称、状态、影响、下一动作、关闭提示、访问步骤保存失败仍可继续、完成或关闭后隐藏。
- Playwright：Desktop Chrome 与 Mobile Safari 覆盖初始状态、中断恢复、关闭后刷新/重新登录/新上下文恢复、动态步骤变化、非空推荐永久完成、后续退化不重开、键盘、触控、Axe 和无水平滚动。

## 非目标

- 不实现 #53 的完整推荐编排或“暂无推荐”证据结构。
- 不把任一步骤勾选持久化。
- 不创建通用 onboarding/流程引擎。
- 不新增顶层导航、聊天入口、自动材料生成或外部行动。
- 不把提示关闭解释为旅程完成。
