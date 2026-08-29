# Task 6 report — Issue #10 E2E acceptance

## Status

验收场景、桌面和移动端均已通过；除一条本任务前已存在的 targets 页面 lint 错误外，所有要求门禁均已通过。

## 固定测试场景

- `playwright.config.ts` 仅在测试运行时把 Desktop Chrome 与 Mobile Safari 各四个固定 UUID 映射到 `slow_checkpoint`、`retry_once`、`retry_until_budget`。两个项目共享真实测试用户和数据库，故使用隔离 UUID 组避免跨项目重放同一已完成运行。
- 每个场景在真实登录和目标 UI 准备完成后安装页面初始化脚本；脚本只替换该场景第一次 `crypto.randomUUID()`，以 `sessionStorage` 标记跨 reload 保持“只一次”。没有测试产品端点，也不依赖目标或用户文本。

## RED → GREEN

| 切片 | RED 证据 | 最窄修复与 GREEN 证据 |
| --- | --- | --- |
| 安全检查点 | resolver 测试要求 `slow_checkpoint` 至少 500ms，实际为 27ms。 | 有界 Fake delay 改为 750ms；`pnpm --filter worker exec vitest run src/agent-runs/job-discovery-adapter-resolver.test.ts --no-file-parallelism`：6/6 通过（760ms）。 |
| Inbox resume UI | pause 旅程中 Inbox `resume_run` 返回 200，但 AgentRunPanel 仍显示“岗位发现已暂停”。 | 先新增 Inbox 权威 snapshot callback 与 RunPanel refresh 的两条 Vitest；初始 2 fail / 30 pass，修复后 `pnpm --filter web exec vitest run components/workbench/agent-inbox-panel.test.tsx components/workbench/agent-run-panel.test.tsx --no-file-parallelism`：32/32 通过（1.73s）。 |
| 重试等待 | retry 的 `run.retry_scheduled` 已出现，但既定 BullMQ 退避是 lease 30s + scan 1s，20s E2E 窗口不足。 | 未改产品退避；同一强断言改为 45s/75s，case timeout 60s/90s，与既有真实 Worker integration 的 45s/75s 一致。 |
| 双项目重放隔离 | 精确 E2E 命令先在 Desktop 完成四条运行，Mobile 重放同一 UUID，虽 HTTP 成功但不能再验证独立真实旅程。 | Mobile Safari 使用同语义的独立四 UUID 组；最终精确命令以 48 passed / 8 项既存设备范围 skip 通过。 |

## 验收证据

| 场景 | Desktop Chrome | Mobile Safari | 关键断言 |
| --- | --- | --- | --- |
| pause → reload → Inbox resume | 1/1，7.9s | 通过，9.2s | 真实启动；paused/Inbox；reload 用持久 SSE cursor；resume 后 completed、结果来源、无 Inbox。 |
| cancel | 1/1，3.3s | 通过，2.7s | 安全终止、`results=[]`、`cancelled_by_user`、无 Inbox。 |
| retry once | 1/1，33.7s | 通过，33.1s | retry timeline、completed、attempt/usage `2 / 3`、无 Inbox。 |
| retry until budget | 1/1，1.1m | 通过，1.1m | `budget_exhausted`/稳定失败码/attempts、目标调整链接、dismiss 后 Inbox 消失。 |

Mobile Safari 全套为 4/4（2.0m）；所有场景均检查触控目标至少 44px、无横向溢出和 axe 零违规。Desktop Chrome 还检查了 select 到 action 的 Tab 键盘顺序、同样的触控尺寸和 axe。

## 全量门禁

```text
pnpm typecheck
# exit 0 — 6 workspace packages passed

pnpm test:runtime && pnpm -r --workspace-concurrency=1 --if-present test
# exit 0 — runtime 35、contracts 80、database 15、web 220、domain 175、api 300、worker 70
# 顺序 workspace 运行避免 Testcontainers/Ryuk 并发启动端口竞争；总计约 2 分钟

PLAYWRIGHT_HTML_OPEN=never pnpm --filter web test:e2e -- agent-runs.spec.ts
# exit 0 — 48 passed, 8 skipped（既存 Desktop/Mobile 设备范围测试），4.4m

pnpm build
# exit 0 — 6 workspace packages passed

git diff --check
# exit 0

pnpm lint
# exit 1 — 仅既存 apps/web/app/(workbench)/profile/targets/page.tsx:12
# react-hooks/error-boundaries（try/catch 内构造 JSX）；Task 6 新增 lint 错误已修复
```

## Concerns

- 固定安全退避让两条 retry 场景耗时约 34s/62s；这是锁定 lease 安全语义的真实验收，不是 sleep、skip 或放宽状态断言。
- lint 的剩余失败位于既有 targets 页面，不在本任务的 E2E/验收修复范围内；未为使门禁显示为绿而改动无关产品代码。

## 最终双轴审查

- **Standards：PASS。** 用户界面改为结果导向中文标签；数据库强制三个 claim 字段同空/同非空；SSE 携带 `runVersion` 并经单调投影更新；终态事件判定只有一个 contracts 来源。设计稿明确将真实 Adapter 留给 #11，因此 #10 的普通生产 Fake 是已批准的阶段边界，不是未授权的网络接入。
- **Spec：PASS。** 重试决策覆盖 attempts、active duration、tool/model calls 和 tokens；旧运行的 `usage.complete=false` 在终止时保留；checkpoint、result、claim 与 heartbeat 的消费都在原子事务中生成不可变分录、`run.budget_updated` 和脱敏审计。
- 原实现上下文已通过范围化复审关闭全部 Critical/Important findings；最终复审确认 Issue #10 七项验收标准均有实现证据。
