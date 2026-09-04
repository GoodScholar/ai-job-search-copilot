# Task 10 / Slice 9 Brief：Fake AnySearch Playwright 验收

## 目标与基线

以 Slice 8 双轴 `0/0/0` 的 clean 提交 `0ed9933` 为起点，增加一个专用、版本化且仅在
`APP_ENV=test` 可启用的 Fake AnySearch 全栈阶段，并用 Desktop Chrome 与 Mobile Safari 验收
`layered-public-job-discovery-v1`。固定最终审查基线仍为
`3a1a3940773921a1a03c3b25ea7baa378c025e83`。

本 Slice 只新增测试运行时、固定外部 fixtures、Playwright 旅程和为这些旅程所需的窄 test-only 组装 seam；
不得改变生产 AnySearch、Greenhouse、URL policy、Gate、Lead/Attribution、预算或终态语义。

## 冻结运行时边界

1. `ordinary`、`source-health` 与新的 `anysearch` phase 彼此隔离；默认普通测试仍解析 Fake v1，
   source-health 仍固定 v3。只有显式、版本化的 Fake AnySearch phase 可让 test runtime 创建 v4 run。
2. phase/config 必须进入 Slice 8 的共享 runtime-config authority，严格解析固定版本/枚举；未知、空白或
   schema-invalid 值 fail closed。local/production 出现任一 Fake AnySearch test knob 必须抛稳定脱敏错误。
3. 真实边界必须包括 Web、API、Worker、PostgreSQL、Redis/BullMQ 与 MinIO。只替换外部互联网：
   - AnySearch `/v1/search`、`/v1/extract` 由本地 HTTP fixture server 提供正式 envelope；
   - 岗位页面也由受控 HTTP fixture server 提供，但仍必须经过共享 preflight、真实
     `SecureJobPageFetcher`、final/canonical 验证、DOM 分类与 Verified Gate；不得直接把 fixture 注入 Gate。
4. test-only transport/base/origin 只能由 exact phase factory 注入；不能被 provider 响应、页面链接、query
   或浏览器输入扩权。生产 base URL、匿名模式、跨 host redirect 与真实网络继续 fail closed。
5. fixture server/runner 不记录 API key、raw query、用户事实或响应 credentials；使用固定非秘密占位 key。
   anonymous 402 credentials 即使出现在恶意 fixture 中也必须被丢弃且不能落库/日志。

## 固定 fixture 契约

使用一个版本常量（例如 `fake-anysearch-public-job-v1`）和只读 fixtures。所有 URL、query/result 顺序、
canonical、HTML 与错误均为静态数据；禁止由页面返回动态生成 allowlist/capability。

主成功旅程必须覆盖并通过数据库结构性断言证明：

- 冻结 query plan 包含 `general`、四个固定 platform `site_constrained`（BOSS、猎聘、智联、微信 H5）和
  有 Watchlist 时的 `target_company`；查询/结果批次和验证候选均不超过已批准上限。
- provider 返回顺序确定；至少两个 query 返回同一 canonical 岗位，最终 Source Posting/Version、Opportunity、
  AgentRunResult 仅一份，但各自已验证 Lead/Attribution 事实保持真实且不把 provider 当来源身份。
- 至少一个 query 返回稳定 429 或 503 的局部失败；其余 query 继续完成，run 以
  `completed_with_source_issues` 结束，同根因只形成一个脱敏 run-level attention。
- 验证顺序可由 fixture server 的有界审计事实证明为 candidate preflight → `/extract` → local page fetch；
  页面正文/链接和 extract 内容不能触发额外 URL 请求。
- 登录墙、列表页、过期页、不安全 URL 与内容不足分别留下 rejected Lead 和稳定 rejection/diagnostic；
  它们没有 Source Posting/Version、Opportunity、Attribution 或 AgentRunResult。
- 一个有效岗位页产生真实 canonical/final source identity、verified Lead、独立 Discovery Attribution、
  Opportunity 与 AgentRunResult；search title/snippet/extract 不进入真实来源原文。

缺 key 旅程必须在独立的 same-spec test phase/fixture mode 中运行：不启动 AnySearch transport、没有匿名请求；
`ANYSEARCH_NOT_CONFIGURED` 按 provider 聚合为一个 source issue/attention。若该旅程无 trusted source，则可按既有
全分支失败语义断言失败终态；“trusted 成功 + 缺 key = completed_with_source_issues”继续由 Slice 8 的真实
processor integration 作为结构性证据，不得在 E2E 中伪造 trusted 持久化。

## Playwright 旅程

1. 通过 Dev Auth/API 建立独立账户、活动 target、最小 profile 和用于 company query 的已批准 Watchlist；
   浏览器只观察正常工作台/API，fixture mode/key 不注入页面。
2. 从普通 UI 启动或启用/快进 schedule；不得直接插 Agent Run、Lead、Source、Opportunity、Result 或 Attention。
3. 等待真实 Worker/SSE 完成，断言用户可见终态、结果去重、source issue/attention，并检查 attention 链接到
   run detail 而不是 Watchlist health。
4. 使用 Node-side PostgreSQL 只读查询核对 query kinds/counts、Lead 状态、Attribution、真实来源身份和 rejected
   下游不存在；不得以浏览器私有实现或 Drizzle 查询形状作为产品断言。
5. Desktop Chrome 与 Mobile Safari 都必须通过；保留现有 44px、无横向溢出和 axe 门禁。测试账户、UUID 与
   fixture audit 必须按 project 隔离，重复 delivery/reload 不产生重复结果。

## TDD 切片

1. **Red A — phase/runner/config。** 为 `e2e-runner`、Playwright config、local runtime 与共享 runtime config
   写失败测试：专用 phase选择、环境清洗、test-only v4、非 test拒绝、fixture server lifecycle/取消/清理。
   提交真实 Red。
2. **Green A — 最小 test runtime。** 实现版本化 phase 与 fixture server，保持 ordinary/source-health 不变；
   focused runner/runtime/config tests Green 后提交。
3. **Red B — configured Playwright journey。** 新建 `anysearch-public-job-discovery.spec.ts`，先证明真实全栈尚未
   完成 fixtures/结果/Lead/Attribution/attention 验收并提交 Red。
4. **Green B — configured fixtures/wiring。** 只做验收驱动的 Worker test factory/transport/page-fixture 组装；
   不复制 workflow 或绕过真实 persistence/Gate。
5. **Red/Green C — missing key。** 先证明专用缺 key mode 没有 transport 且只产生一次聚合事实，再做最小
   runner/config wiring；不得用 Fake error 冒充真正缺 key。
6. **Refactor/报告。** 新建 tracked `task-10-report.md`，记录每个 Red/Green hash、真实失败、完整命令、两个浏览器
   计数、fixture 请求审计、已知边界和所有作废/重跑证据。

## Slice 9 验收

- 严格串行运行新增 runner/runtime/config/Worker focused tests；测试进程不得重复并发。
- 使用专用命令运行且只运行 Fake AnySearch spec：
  `DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- anysearch-public-job-discovery.spec.ts --project="Desktop Chrome" --project="Mobile Safari"`。
- 证明 phase selection 不把该 spec送入 ordinary/source-health，普通与 source-health现有 focused 回归保持 Green。
- 运行相关 packages typecheck、Drizzle check、`git diff --check 0ed9933..HEAD`，提交全部 intended diff并保持
  `git status --short` 为空。
- 完成后由 sol/high 对 Slice 9 做独立 Standards/Spec 双轴审查；所有 Critical、Important、Minor 清零后才进入
  Task 11 全量验收。不得 push、PR、merge、关闭 Issue 或启动下一个 Issue。
