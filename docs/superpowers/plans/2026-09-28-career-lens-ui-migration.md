# Career Lens UI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Issue #66 已批准的“职业透镜”视觉系统迁移到现有十个 Alpha 路由与四个既有任务态，同时完整保留真实产品行为。

**Architecture:** 保留 Next.js App Router 的服务器组合与现有 client view 接缝，只重组页面语义、共用壳层和视觉表达。以 `globals.css` 的语义 token 与少量可复用视觉原语统领页面；各领域视图继续消费现有 contracts/API，不新增后台能力。

**Tech Stack:** pnpm workspace、Next.js 16 App Router、React 19、TypeScript、Tailwind CSS v4、Base UI/shadcn、Vitest/Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-27-career-lens-ui-migration.md`（以 Issue #66、`PRODUCT.md`、`CONTEXT.md`、ADR 和根 `DESIGN.md` 为上位约束）

## 执行状态（2026-09-28）

Task 1–8 的实现、状态覆盖与视觉 AC 已完成。全量指定 E2E 仅保留一个 `UNVERIFIED`：`one-click-recommendation.spec.ts` 的“全局停止后为 paused”断言在本分支与全新 `origin/main` 均稳定得到 `cancelled`；该 API/worker 既有行为不在本计划的 Web UI 修改范围内，未被改写为通过。Profile 明确编辑模式切片只保留 GREEN 回归，历史恢复轮未保存 RED 输出。

## Global Constraints

- 只修改任务契约允许路径；不修改 API、contracts、database、domain、Worker 或 schema。
- 不新增未来材料、投递、面试、分享、账户删除后台；静态原型只作视觉基线。
- 不虚构数据、分数、进度、客户证据或能力；所有 UI 状态来自现有 contracts/fixtures。
- 保留 SSR 并行、SSE/轮询、身份/权限、版本/幂等、错误恢复和外部行动审批边界。
- 复用 Base UI/shadcn 与原生 CSS；不引入第二套组件或重动画 runtime，不修改依赖与 lockfile。
- 主要触控目标至少 44px，状态不只靠颜色，WCAG AA、可见焦点、语义 landmark、aria-live 与 `prefers-reduced-motion` 为完成条件。
- 所有测试命令单进程串行；执行前确认无遗留 Vitest/Playwright/Next 测试进程。

## Review Focus

- 无真实数据：所有页面显示明确空态和下一动作，不把原型样例渲染为用户数据；由各页面/视图测试和 `career-lens-acceptance.spec.ts` 覆盖。
- 局部 API 失败或版本冲突：错误停留在对应对象附近，已有恢复动作仍可用；由 home/profile/targets/watchlist/import/settings 现有测试补充覆盖。
- 运行中刷新与恢复：SSR/SSE/轮询状态、用户展开区域和 URL identity 不丢失；由现有 reload/agent-run/recommendation E2E 覆盖。
- 390px 与 reduced motion：无横向溢出、底栏不遮挡、44px 控件、动效静止；由 Playwright 移动项目和浏览器 media emulation 覆盖。
- 未来能力误显：投递/材料/面试仅标明规划或未启用，不出现可执行后台承诺；由导航测试和全路由截图审查覆盖。

---

### Task 0: 固定真实旧产品截图与验收入口

**Files:**
- Create: `apps/web/e2e/career-lens-acceptance.spec.ts`
- Create: `docs/qa/issue-66/screenshots/before/**`

**Interfaces:**
- Consumes: `fa67dd6` 上的真实产品、现有 Dev Auth/E2E fixtures 和 1440×900/390×844 Playwright projects。
- Produces: 可重复访问十路由与四任务态的验收入口、真实旧产品桌面/手机截图；不使用静态原型代替。

- [x] **Step 1: 建立只采证的浏览器 spec**：复用现有 fixture/API 初始化路径访问十路由与四任务态，先只断言路由可读和截图成功，不断言尚未实现的新视觉。
- [x] **Step 2: 串行采集 before**：静态十路由旧图来自真实 runtime；AC-012 四动态态旧图已由独立恢复的 `origin/main`（`fa67dd6`）真实运行时补采并复制，临时采证 harness 未进入本产品分支。来源、命令、结果与 SHA 见 `docs/qa/issue-66/logs/task-0-dynamic-before-origin-main.log`。
- [x] **Step 3: 审核截图清单**：逐张确认来自真实 Web runtime、画幅正确、没有横向裁切，并在后续各任务中逐步为对应页面加入会先失败的新视觉/可访问行为断言。

### Task 1: 冻结设计基线与共用视觉骨架

**Files:**
- Modify: `DESIGN.md`
- Create: `docs/superpowers/specs/2026-09-27-career-lens-ui-migration.md`
- Create: `docs/superpowers/specs/2026-09-27-career-lens-ticket-map.md`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/(workbench)/layout.tsx`
- Modify: `apps/web/components/workbench/workbench-header.tsx`
- Modify: `apps/web/components/workbench/workbench-navigation.tsx`
- Test: `apps/web/components/workbench/workbench-header.test.tsx`
- Test: `apps/web/components/workbench/workbench-navigation.test.tsx`
- Test: `apps/web/app/globals.test.ts`

**Interfaces:**
- Consumes: 已批准外部 DESIGN/spec、当前四项顶层导航和画像上下文入口。
- Produces: 统一语义 tokens、232px 桌面侧栏/移动底栏、页面容器、状态/焦点/触控/减动效基础类。

- [x] **Step 1: 写失败测试**：断言桌面壳层具有侧栏 landmark、四项顶层语义、未启用投递的真实状态、画像次级入口和移动导航；`globals.test.ts` 只验证可观察的可访问/布局契约，不镜像 CSS 源文本。
- [x] **Step 2: 验证 RED**：运行 `pnpm --filter web exec vitest run components/workbench/workbench-header.test.tsx components/workbench/workbench-navigation.test.tsx app/globals.test.ts`，确认因新壳层/语义缺失而失败。
- [x] **Step 3: 最小实现**：正式纳入三份设计文档，替换旧纸张 tokens，重组 header/navigation/layout；共用 CSS 只承载可复用语法，不用页面特例堆叠覆盖。
- [x] **Step 4: 验证 GREEN**：重复 Step 2 命令并确认通过。
- [x] **Step 5: Commit**：`git commit -m "feat(web): establish career lens product shell"`。

### Task 2: 迁移营销页与登录边界

**Files:**
- Modify: `apps/web/app/(marketing)/page.tsx`
- Modify: `apps/web/app/(marketing)/page-content.test.tsx`
- Modify: `apps/web/app/(marketing)/page.test.tsx`
- Modify: `apps/web/components/landing/marketing-header.tsx`
- Modify: `apps/web/components/landing/hero-section.tsx`
- Create: `apps/web/components/landing/career-lens-journey.tsx`
- Modify/Delete only if no longer referenced: `apps/web/components/landing/*`
- Modify: `apps/web/app/login/page.tsx`
- Modify: `apps/web/app/login/page.test.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/e2e/landing.spec.ts`

**Interfaces:**
- Consumes: `resolveLoginReturnTo`, `startDevSessionAction`,真实 auth mode、A01 权威图。
- Produces: 同比缩放的 A01 内板、机会→事实→决定关系、六步旅程、移动前置登录面板。

- [x] **Step 1: 写失败测试**：营销测试断言单一主 CTA、完整三对象关系和六步旅程；登录测试断言 safe return path 与真实 action 不变、移动阅读顺序可由 DOM 语义确认。
- [x] **Step 2: 验证 RED**：运行相应 Vitest 文件，确认旧英雄/纸张结构失败。
- [x] **Step 3: 最小实现**：按 1160×638 统一内板实现 A01；登录页使用低对比透镜和紧凑访问面板，不改变 action/returnTo。
- [x] **Step 4: 验证 GREEN**：运行定向 Vitest 与 `pnpm --filter web test:e2e -- landing.spec.ts --workers=1`。
- [x] **Step 5: Commit**：`git commit -m "feat(web): migrate marketing and login surfaces"`。

### Task 3: 迁移今日决策台与四个既有任务态

**Files:**
- Modify: `apps/web/components/workbench/workbench-home-view.tsx`
- Modify: `apps/web/components/workbench/recommendation-run-panel.tsx`
- Modify: `apps/web/components/workbench/agent-run-panel.tsx`
- Modify: `apps/web/components/workbench/agent-inbox-panel.tsx`
- Modify: `apps/web/components/workbench/first-recommendation-journey.tsx`
- Modify: 对应 `*.test.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/app/(workbench)/home/page.test.tsx`
- Test: `apps/web/app/(workbench)/home/recommendation-run-ssr-reload.test.tsx`
- Test: `apps/web/e2e/auth-workbench.spec.ts`
- Test: `apps/web/e2e/first-recommendation-journey.spec.ts`
- Test: `apps/web/e2e/workbench-inbox.spec.ts`
- Test: `apps/web/e2e/agent-runs.spec.ts`

**Interfaces:**
- Consumes: 现有 `WorkbenchHome`、targets、preflight、Inbox、Agent/recommendation run props 和 action/fetch 接缝。
- Produces: 状态带、真实下一行动主对象、深色 AI 运行区、决策队列和六步准备轨道。

- [x] **Step 1: 写失败测试**：按空账户、准备中、运行中、失败/阻塞、Inbox 决策、刷新恢复逐个添加行为测试；每个测试先命名它能捕获的生产回归。
- [x] **Step 2: 逐个验证 RED**：每次只运行对应测试文件，确认因新信息层级或状态语义缺失失败。
- [x] **Step 3: 逐个 GREEN**：最小重组现有组件与 CSS；不得重写数据获取或 SSE/轮询逻辑。
- [x] **Step 4: 串行回归**：运行上述全部定向 Vitest，再依次运行四个 E2E spec，确保无测试进程重叠。
- [x] **Step 5: Commit**：`git commit -m "feat(web): reshape the daily decision workbench"`。

### Task 4: 迁移推荐清单、证据对照、校准与历史

**Files:**
- Modify: `apps/web/app/(workbench)/recommendations/page.tsx`
- Modify: `apps/web/app/(workbench)/recommendations/recommendation-decision.tsx`
- Modify: `apps/web/app/(workbench)/recommendations/reevaluate-button.tsx`
- Modify: `apps/web/app/(workbench)/recommendations/recommendation-result-summary.tsx`
- Modify: `apps/web/app/(workbench)/recommendations/calibration-proposals.tsx`
- Modify: `apps/web/app/(workbench)/recommendations/latest-exclusions.tsx`
- Modify: `apps/web/app/(workbench)/recommendations/recommendation-history.tsx`
- Modify: 对应 `*.test.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/e2e/recommendations.spec.ts`

**Interfaces:**
- Consumes: 当前 recommendation list/result/history/calibration contracts、server actions 与 URL identity 规则。
- Produces: 机会对象、紧邻决定动作、岗位/画像证据透镜、渐进历史/排除/校准区。

- [x] **Step 1: 写失败测试**：覆盖岗位对象主信息、决定操作邻接、证据展开、无效 identity、空/运行/失败态、校准冲突/重算、历史分页错误恢复。
- [x] **Step 2: 验证 RED**：运行相关 Vitest，确认新结构断言在旧页面失败且现有业务断言仍保留。
- [x] **Step 3: 最小实现**：只重组表现和语义，继续使用现有 formatters、actions 和不可变版本字段；不推断百分比。
- [x] **Step 4: 验证 GREEN**：定向 Vitest 后运行 `pnpm --filter web test:e2e -- recommendations.spec.ts --workers=1`。
- [x] **Step 5: Commit**：`git commit -m "feat(web): present recommendations as evidence-backed decisions"`。

### Task 5: 迁移职业资料与导入审核

**Files:**
- Modify: `apps/web/components/workbench/profile-import-view.tsx`
- Modify: `apps/web/components/workbench/profile-import-view.test.tsx`
- Modify: `apps/web/app/(workbench)/profile/page.test.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/e2e/markdown-career-import.spec.ts`
- Test: `apps/web/e2e/docx-career-import.spec.ts`
- Test: `apps/web/e2e/pdf-career-import.spec.ts`

**Interfaces:**
- Consumes: 现有 imports/profile/candidate facts/conflicts 与全部确认、纠正、拒绝、取消、轮询 action。
- Produces: 可信画像主对象、候选审核队列、两源冲突对照、最近导入和显式编辑/导入模式。

- [x] **Step 1: 写失败测试**：覆盖事实分区、空态导入路径、候选事实决定、冲突、隐私检查、导入排队/失败/取消和焦点回归。
- [x] **Step 2: 验证 RED**：运行 profile 定向 Vitest，确认结构/交互缺失导致预期失败。
- [x] **Step 3: 最小实现**：保留单一 client state 与现有请求语义，把常驻长表单改为明确编辑模式并加入语义区块。（返工完成；仅保留 GREEN 回归。）
- [x] **Step 4: 验证 GREEN**：定向 Vitest 后串行运行三种导入 E2E。（最终串行回归：Markdown / DOCX / PDF 共 10 passed；Profile 明确编辑模式的历史恢复切片仅保留 GREEN 输出。）
- [x] **Step 5: Commit**：`git commit -m "feat(web): organize the evidence-backed career profile"`。

### Task 6: 迁移求职目标、来源台账与岗位导入

**Files:**
- Modify: `apps/web/components/workbench/job-targets-view.tsx`
- Modify: `apps/web/components/workbench/company-watchlist-view.tsx`
- Modify: `apps/web/components/workbench/discovery-schedule-panel.tsx`
- Modify: `apps/web/components/workbench/job-import-view.tsx`
- Modify: 对应 `*.test.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/e2e/job-targets.spec.ts`
- Test: `apps/web/e2e/company-watchlist.spec.ts`
- Test: `apps/web/e2e/job-imports.spec.ts`
- Test: `apps/web/e2e/source-health.spec.ts`

**Interfaces:**
- Consumes: 现有 targets/watchlist/capabilities/health/import contracts 与全部 action/fetch 接缝。
- Produces: 主/次目标对象、约束摘要、候选方向、公司来源对象、能力/健康区、三模式导入和真实阶段轨道。

- [x] **Step 1: 写失败测试**：按目标空/容量满/冲突、watchlist 未检查/失败/停用/排序、导入三模式/轮询/原文/失败分别写行为测试。
- [x] **Step 2: 逐个验证 RED**：使用单文件 Vitest，确认目标行为尚未满足。
- [x] **Step 3: 逐个 GREEN**：保持 action/API 不动，只改变内容组织、编辑模式和可见状态。
- [x] **Step 4: 串行回归**：运行定向 Vitest 和四个 E2E spec；`source-health` 使用 runner 的独立 phase，不与其他 Playwright 进程重叠。
- [x] **Step 5: Commit**：`git commit -m "feat(web): migrate targets sources and job imports"`。

### Task 7: 迁移运行护栏与模型诊断

**Files:**
- Modify: `apps/web/components/workbench/account-run-policy-view.tsx`
- Modify: `apps/web/components/workbench/model-connection-view.tsx`
- Modify: 对应 `*.test.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/e2e/account-run-policy.spec.ts`
- Test: `apps/web/e2e/model-diagnostics.spec.ts`

**Interfaces:**
- Consumes: `default/hardLimit/userSettings/effective`、revision/control state、四项 diagnostics 和现有轮询/abort/retryAt。
- Produces: 可扫描的策略对照、全局停止对象、历史区和深色模型诊断对象。

- [x] **Step 1: 写失败测试**：覆盖 effective/hard limit 不虚构剩余额度、停止/解除、保存冲突、四项检查、checking/failed/temporary、retryAt 和 aria-live。
- [x] **Step 2: 验证 RED**：运行两个组件测试并确认新结构断言失败。
- [x] **Step 3: 最小实现**：保持表单字段、请求、最多 25 次轮询、abort 与禁用逻辑；仅重组对象与状态。
- [x] **Step 4: 验证 GREEN**：定向 Vitest 后串行运行两个 E2E spec。
- [x] **Step 5: Commit**：`git commit -m "feat(web): clarify run policy and model diagnostics"`。

### Task 8: 真实浏览器逐页验收与完整验证

**Files:**
- Modify: `apps/web/e2e/career-lens-acceptance.spec.ts`
- Create: `docs/qa/issue-66/README.md`
- Create: `docs/qa/issue-66/screenshots/after/**`
- Modify: 仅修复本 Issue 验收发现的问题对应的 `apps/web/**` 文件和测试。

**Interfaces:**
- Consumes: 前七个任务的生产 UI、现有 E2E fixtures、静态 reference-112/A01 视觉基线。
- Produces: 十路由+四任务态的桌面/移动新旧对照、可访问性/响应式证据、逐页评分和最终命令日志。

- [x] **Step 1: 完成验收 spec**：用真实浏览器和现有 fixture 访问十路由与四任务态，断言 landmark、主对象、真实状态、无横向溢出、44px 命中、键盘焦点、reduced-motion、空/错误恢复；复核各切片已经真实经历 RED，未覆盖项先补失败断言再修复。
- [x] **Step 2: 复核 before 证据**：静态十路由及 AC-012 四动态态截图均来自 `fa67dd6` 真实 runtime；动态态由独立基线工作树串行补采，未在实现后重建、未以静态原型冒充旧产品截图。
- [x] **Step 3: 验证 GREEN 与保存 after**：在当前 HEAD 运行 `pnpm --filter web test:e2e -- career-lens-acceptance.spec.ts --workers=1`；逐页查看全部 after 截图并与权威图/原型对照，记录布局30/主视觉25/字体色彩20/内容组件15/移动10、具体扣分和关键缺项。
- [x] **Step 4: 视觉修正闭环**：任何页面低于 95 或关键缺项>0，先补能捕获行为回归的测试，再最小修复并重跑受影响页面；不以平均分放行。（职业资料/运行策略已改为明确操作后展开；Mobile Policy 已经 RED→GREEN 验证五列以局部横滚保留。）
- [x] **Step 5: 全量串行验证**：确认无遗留测试进程后，依次运行 `pnpm --filter web test`、`pnpm --filter web typecheck`、`pnpm --filter web lint`、`pnpm --filter web build`，再依次运行 Issue 指定的全部现有 E2E specs；记录退出码与完整日志位置；全局停止状态以 UNVERIFIED 记录。
- [x] **Step 6: UI 静态检测**：运行 `node /Users/shen/.codex/skills/vibe-ui-orchestrator/scripts/finesse-detect.mjs --json <changed-web-files>` 作为补充，`notCovered` 必须转入人工浏览器检查，不用它替代截图验收。
- [x] **Step 7: 完成 QA 报告**：`docs/qa/issue-66/README.md` 已写入参考采用/舍弃、依赖与许可、每页评分、截图清单、键盘/焦点/触控/对比度/reduced-motion/溢出/状态证据、既有 API 失败和未决风险；14 项 after 均 >=95、关键缺项 0；AC-012 动态态旧版 before 已由 `fa67dd6` 独立基线运行时补证，只有 one-click API/worker 保持 UNVERIFIED。
- [x] **Step 8: Commit**：`git commit -m "test(web): verify the career lens migration"`。

## Plan Self-Review

- Spec coverage：Issue #66 的八项验收标准与补充规格 24 个用户故事已映射到 Task 1–8；未来后台明确排除。
- Step scan：每项先 RED、再最小实现、再 GREEN；视觉事实由浏览器验收，不用 CSS 文本镜像测试。
- Type consistency：不新增领域接口；现有 component props、server actions、contracts 和 API 调用保持原名原型。
- Review Focus：五类高风险输入分别落入对应组件测试和最终 Playwright 验收。
- Proportion：计划锁定文件、行为与验证边界，不预写组件实现细节。
