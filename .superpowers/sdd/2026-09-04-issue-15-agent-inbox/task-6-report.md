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

## Fix Round 1：行为与视觉验收

### Code-led 方向合同与可核验 seed

THESIS=待处理决策是首页主角；
OWN-WORLD=晨间求职内参冷白档案纸/深绿行动/琥珀边界；
STORY=先决定、再看证据与运行、最后继续资料/岗位；
FIRST VIEWPORT=标题+7项摘要+首要Inbox，桌面与390px均在首屏展示任务状态；
FORM=established Operate extension，seed 4e302c13（apps/web/app/layout.tsx 已有）。

### 补充 RED 与最小修正

- `pendingFacts` 原本按永远为 pending 的导入确认字段统计；领域集成 RED 证明已决候选事实仍被计数。现在按 owner-bound、尚无 `candidate_fact_decision` 的事实统计，并覆盖当前 owner、其他 owner 与已决事实。
- 筛选请求期间曾会展示空态，`mark_read` 卸载按钮后会让焦点落回 document body。组件 RED 后改为互斥 loading/error/empty，并将焦点恢复到同项“查看相关记录”（失效时回退待处理筛选）。
- 校准拒绝以前只比较空规则计数。现在先从公共页面批准一个非空规则，再刷新并拒绝第二个 proposal，逐字段比较最新 active rule 的 version/config。
- runner 对 source-health 与 workbench-inbox 的显式组合会漏掉 workbench phase；现在按既有相位顺序取并集。

### 视觉修正

- 首页去除 hero kicker；仅首要 Inbox 与进行中的运行任务保留 paper shadow，辅助账本改为平面档案纸。
- 标题和摘要数字 tracking 限制为不小于 `-0.04em`；390px 的第 7 项变为完整跨列 disabled row。
- 使用既有色板补齐 hover、selection、caret 与 scrollbar；未增加字体、图标、动画或设计系统。
- full-stack E2E 将在最终捕图复跑中重新验证 populated Inbox 的 axe critical/serious、44px 宽高、overflow、键盘 focus、Mobile Safari tap、offline 与 reduced motion。

### Fix Round 1 最终 GREEN

最终捕图命令的 ordinary phase 为 4 passed、2 skipped，受控来源 phase 为 2 passed、4 skipped；Desktop Chrome 与 Mobile Safari 的三条旅程合计 6 次均通过、0 失败。最终聚焦回归：`workbench-home.integration.test.ts` 为 6/6，`agent-inbox-panel.test.tsx` 与 `e2e-runner.test.ts` 合计 19/19；`pnpm typecheck`、`pnpm lint` 与 `git diff --check` 均为 exit 0。

## Fix Round 2：显式相位与即时首页摘要

### RED 与修正

- Runner 混合显式 spec 的 RED 显示 AnySearch 与 workbench、AnySearch 与来源、以及三者同传时会静默遗漏 phase。现在将每个显式特殊 spec 映射到所需 phase，并按 `anysearch-configured`、`anysearch-missing-key`、`ordinary`、`source-health`、`workbench-inbox` 的稳定顺序去重合并；4 组 mixed-spec 回归覆盖该行为。
- 首页仅在后续服务端刷新后才更新待决定/待确认事实摘要。现在 Inbox 解决动作立刻按事项种类作本地扣减（`candidate_fact` 同时扣减 `pendingFacts`），并调用 `router.refresh()`；新的 `home` prop 以其对象身份使旧调整失效，避免权威数据回来后重复扣减。
- fresh foreign owner 的列表断言收紧为 `toEqual([])`，变更请求仍验证 404。
- 定向 E2E 曾暴露渲染后对旧 locator 手动 `focus()` 的不稳定断言。Desktop 输入动作改为 locator 的键盘 Enter；候选事实 mark-read 后仍直接验证焦点已自动转移到稳定的“查看相关记录”目标。

### Fix Round 2 GREEN

```bash
pnpm --filter web exec vitest run scripts/e2e-runner.test.ts components/workbench/workbench-home-view.test.tsx components/workbench/agent-inbox-panel.test.tsx --no-file-parallelism
DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain exec vitest run src/workbench-home.integration.test.ts --no-file-parallelism
DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- workbench-inbox.spec.ts --project 'Desktop Chrome' --project 'Mobile Safari'
pnpm typecheck
pnpm lint
git diff --check
```

组件/runner 聚焦为 30/30，领域为 6/6；最终 E2E ordinary phase 为 4 passed、2 skipped，受控来源 phase 为 2 passed、4 skipped，三条旅程在 Desktop Chrome 与 Mobile Safari 共 6 条有效执行、0 失败。视觉 CSS 未变更，既有 `.impeccable/review/desktop.png`（1440×1773）和 `.impeccable/review/mobile.png`（1170×6330）再次确认是有效 PNG；沿用此前人工检查结果（内容完整、非黑屏、无 overlay），未运行第二次 detector。

## Fix Round 3：候选事实真值与刷新焦点

### RED 与最小修正

- Fix Round 2 的候选事实 dismiss 乐观调整错误地将 `pendingFacts` 一并扣减；该动作只解决 Inbox 通知，不会创建 `candidate_fact_decision`。组件 RED 直接证明 dismiss 后应为 `pendingFacts=1`、`pendingDecisions=0`，且新权威 `home` props 到达后仍必须保持该真值。现在只乐观扣减 `pendingDecisions`；候选事实数只由 profile 的真实 confirm/correct/reject 后服务端读取决定。
- 新 Inbox props 到达时，`WorkbenchHomeContent` 和 `AgentInboxPanel` 的 `key` 会令整个内容树重挂载，丢失 mark-read 已恢复到“查看相关记录”的焦点。移除两个重挂载 key，面板内部以新 `items` props 为权威 pending 缓存基准，同时保留稳定的 DOM 节点和当前筛选状态。

### Fix Round 3 GREEN

```bash
pnpm --filter web exec vitest run components/workbench/workbench-home-view.test.tsx components/workbench/agent-inbox-panel.test.tsx --no-file-parallelism
pnpm --filter web exec vitest run scripts/e2e-runner.test.ts --no-file-parallelism
DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain exec vitest run src/workbench-home.integration.test.ts --no-file-parallelism
DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- workbench-inbox.spec.ts --project 'Desktop Chrome' --project 'Mobile Safari'
pnpm typecheck
pnpm lint
git diff --check
```

UI 为 17/17、runner 为 14/14、领域为 6/6；最终 E2E ordinary phase 为 4 passed、2 skipped，受控来源 phase 为 2 passed、4 skipped，Desktop Chrome 与 Mobile Safari 共 6 条有效旅程、0 失败。没有视觉 CSS 改动；已再次打开 `.impeccable/review/desktop.png` 与 `.impeccable/review/mobile.png` 确认内容完整、非黑屏且无 overlay，故未重生成截图，也没有运行第二次 detector。

## Fix Round 4：权威 Inbox 筛选缓存

### RED 与最小修正

- 新权威 Inbox props 到达时，当前停留在 unread/read 会因为只有 pending 缓存而错误显示空态；停留在 resolved 会继续使用旧 resolved 缓存。新增 RED 覆盖 unread、read、resolved 三种筛选：新来源直接重建 pending，并按状态精确派生 unread/read；resolved 立即失效，显示“正在读取事项…”并重新读取，期间不展示空态。
- 在途筛选请求此前只按全局版本处理，旧来源的成功或失败仍可能写入当前状态。现在每个加载/失败请求都绑定权威 props 的数组身份与内容签名；即使内容相同但数组身份改变也会淘汰旧来源状态，且新 resolved 请求递增版本，使旧成功/失败都不能写入或清除新来源状态。
- 不再使用 props key 重挂载：mark-read 和 resolve 的既有焦点恢复、pending cache 与首页摘要真值继续保留。

### Fix Round 4 GREEN

```bash
pnpm --filter web exec vitest run components/workbench/workbench-home-view.test.tsx components/workbench/agent-inbox-panel.test.tsx scripts/e2e-runner.test.ts --no-file-parallelism
DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain exec vitest run src/workbench-home.integration.test.ts --no-file-parallelism
DOCKER_API_VERSION=1.51 pnpm --filter web test:e2e -- workbench-inbox.spec.ts --project 'Desktop Chrome' --project 'Mobile Safari'
pnpm typecheck
pnpm lint
git diff --check
```

UI/runner 聚焦为 37/37，领域为 6/6；最终 E2E ordinary phase 为 4 passed、2 skipped，受控来源 phase 为 2 passed、4 skipped，Desktop Chrome 与 Mobile Safari 共 6 条有效旅程、0 失败。无 CSS 变更，因此未重截现有 `.impeccable/review/desktop.png` 与 `.impeccable/review/mobile.png`，也未运行 detector。
