# Task 6 验收报告：Agent Control Inbox

## 范围

- 新增三条独立、owner-scoped 的 Playwright 旅程，均从 `/home` 进入：候选事实确认、受限来源停用、校准建议拒绝。
- 通过真实 Web BFF、API、Worker、PostgreSQL、Redis 与 MinIO 测试运行时验证；没有新增测试专用生产接口或公网访问。
- 修复公共投影链路：未读 Inbox 项现在在 `availableActions` 中公开 `mark_read`，契约允许并约束未读项的该动作。

## RED 记录与修正

1. 初始桌面 RED：候选事实卡片没有“标记为已读”动作。根因是 Task 2 的领域投影和契约均遗漏 `mark_read`。以领域集成与合同测试先覆盖，再补最小投影/合同/UI fixture 修复。
2. 初始运行时 RED：遗留的本工作树 Next dev 进程占用开发锁，导致 Dev Auth 后出现 Next overlay。终止遗留进程后，完整 API/Web/Worker 运行时正常启动，后续截图无 overlay。
3. 来源旅程 RED：单个 rate-limited 来源按既有规则使运行失败；改为健康+限流的确定性来源组合，验证“部分完成”与来源处理。随后固定 UUID init script 在跨导航时复用 actionId，引发预期的幂等冲突；改为 session 内仅固定一次。
4. 校准和来源旅程还会生成 `recommendation_list` Inbox 项；显式标记已读并处理它，才正确验证 no-pending 终态。

## GREEN 证据

命令：

```bash
DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- workbench-inbox.spec.ts --project 'Desktop Chrome' --project 'Mobile Safari'
```

最终捕图复跑使用相同命令并设置 `E2E_CAPTURE_WORKBENCH_INBOX=1`。运行器分为 ordinary 与受控来源 phase：普通 phase 为 4 passed、2 skipped；来源 phase 为 2 passed、4 skipped；三条旅程在 Desktop Chrome 与 Mobile Safari 合计 6 次执行均通过、0 失败。

附加验证均为 exit 0：

```bash
pnpm --filter @job-copilot/contracts exec vitest run src/agent-inbox.test.ts
DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain exec vitest run src/agent-inbox.integration.test.ts --no-file-parallelism
pnpm --filter web exec vitest run components/workbench/agent-inbox-panel.test.tsx scripts/e2e-runner.test.ts --no-file-parallelism
pnpm typecheck
pnpm lint
git diff --check
```

结果分别为 5、17、16 个测试通过；typecheck、lint 与 diff check 通过。

## 浏览器 QA 与截图

- `/home` 旅程实际覆盖：Desktop Chrome 键盘 focus/Enter；Mobile Safari tap；离线动作失败后恢复重试；`prefers-reduced-motion`；44px 最小触控高度；无横向 overflow；axe 无 critical/serious 违规。
- 截图已打开人工检查，均非黑屏、非错误 overlay、全页内容完整：
  - `.impeccable/review/desktop.png`
  - `.impeccable/review/mobile.png`
- 未重新运行 Impeccable detector。
