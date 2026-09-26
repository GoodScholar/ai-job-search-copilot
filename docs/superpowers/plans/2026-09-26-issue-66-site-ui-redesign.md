# Issue #66 整站 UI 重构实施计划

> 基线：`origin/main` 的 `fa67dd655aee9bc63eb95e61590648a15cbbdb66`（含已合并 #24）；分支：`codex/issue-66-site-ui-redesign`；范围仅限 `apps/web` UI、测试、设计说明与许可记录。不得带入未合并 #55/#56/#57 的代码、测试或产物。

## 目标与设计基线

把十个既有路由重组为面向中国中高级技术岗位求职者的明亮专业工作台。保留所有服务器读写、SSR/SSE 恢复、事实与审批约束，页面只改变信息层级、导航、组件呈现和交互反馈。

成功不以“旧纵向文本加卡片/侧栏”为准：真实岗位与个人画像证据的对照、今日的主行动和 AI 工作阶段必须成为可扫描的视觉结构与交互焦点，差异通过布局、状态结构和信息分区呈现。无数据账户只显示清晰引导与真实空态，绝不编造岗位、漏斗或结果；营销、首页、推荐、画像是桌面与移动对照的重点页面。

令牌采用冷白工作区 `#F5F7FB`、白色内容面 `#FFFFFF`、深海蓝正文与导航 `#10243A`、电蓝主行动 `#245FE5`、青色 AI 状态、琥珀待确认、红色错误；中文系统无衬线；8px 节奏、内容圆角 12px、控件圆角 8px。桌面使用 232px 侧导航及最大 1184px 主区，移动端收束为 44px 可触达的四项顶层导航。

```
桌面:  [侧栏 232px] [上下文标题 / 动作]
                       [任务主区 ..................]

移动:  [标题 + 当前动作]
       [内容单列]
       [首页 | 推荐 | 投递(未启用) | 画像]
```

营销页与登录页复用同一身份，但营销内容明确为示例，不声称自动投递、客户背书或结果数据。营销页是现代专业科技感的产品场景，展示“发现—判断—决定”；应用页采用 Operate 模式：先呈现待处理的结果，再按需展示证据、历史与技术详情。旧纸张、祖母绿、档案纸和内参类视觉表达均不沿用。

## 参考与组件选择

已读取 `/tmp/job-copilot-issue-66/reference-selection.md`。采用选择清单 winner：现有 Base UI/shadcn、语义 `nav`/`details` 与原生 CSS（94/100），复用现有 `Button` 和项目样式，不新增依赖或动画运行时。Linear、Huntr、Simplify、Careerflow、Reactive Resume、Twenty 与 Plane 仅贡献公开页面中可观察的布局模式；不复制品牌、截图、素材或代码。许可：shadcn 与 Reactive Resume 为 MIT，Plane 为 AGPL-3.0，Twenty API 为 NOASSERTION，因此后二者不复制代码。Motion Primitives（62）和 MagicUI（57）均不采用，原因是现有 CSS 可满足动效、无需新增 runtime，且前者页面无法核实。

用户补充的 NameThatUI 仅采用已核实的 Steps、Disclosure、Bottom Navigation、安全区、Inline Alert 和 Empty State 通用模式；保持项目原生 HTML/CSS，不复制其未核实许可的源码、素材或长提示词，也不添加 UI 库。移动端使用 `viewportFit: "cover"`，并必须以真实 390px 键盘与触屏验证退出入口、`safe-area-inset-bottom` 和页面留白。

## 实施切片

### 1. 盘点、基线与共享外壳

1. 阅读每个页面、关联组件和现有断言，建立十路由与关键业务行为对照表。
2. 在测试租约解锁后，从 `fa67dd6` 创建临时隔离 checkout，用既有本地真实环境采集十路由的 1440px / 390px 基线截图，明确 fixture 或空状态来源。复用 `auth-workbench` / `first-recommendation-journey` E2E helper 创建真实 API 账户、职业资料、目标和来源；截图覆盖空态和至少关键页有内容态，不能只记录十个空壳。
3. 先在 `components/workbench/workbench-navigation.test.tsx` 为导航激活态、禁用投递、移动语义与键盘可达性写失败测试；在 `components/workbench/workbench-header.test.tsx` 为侧栏主导航和移动触达结构写失败测试；不改写任何已有领域断言。
4. 更新 `globals.css` 为统一 token 与响应式规则，重写 `WorkbenchHeader` / `WorkbenchNavigation` 为桌面侧栏与移动底部导航；抽取只承载布局语义的共享页面标题、状态徽章、操作行和展开区样式。

验证：逐文件执行 `pnpm --filter web exec vitest run components/workbench/workbench-navigation.test.tsx components/workbench/workbench-header.test.tsx --no-file-parallelism`，记录 RED 的断言失败、实现后的 GREEN 输出；更新 `e2e/auth-workbench.spec.ts` 中因二级导航变化的键盘序列，但继续断言真实焦点位置与退出行为，不能删除断言。浏览器检查焦点、激活态和 390px 无横向溢出。

### 2. 首页、推荐与运行状态

1. 在 `components/workbench/workbench-home-view.test.tsx` 与 `recommendation-run-panel.test.tsx` 为首页“首次推荐准备、启动、阻塞解释和刷新恢复”补行为测试，保留 `home/recommendation-run-ssr-reload.test.tsx` 与 SSE 恢复路径。
2. 将 `WorkbenchHomeView` 重组为今日行动主区、真实摘要、AI 工作状态、待决定事项和可展开的运行设置/技术信息；不移除准备阻塞或可用的启动操作。
3. 将推荐页重组为岗位主体、公司/地点、匹配结论与证据优先的列表/详情结构；收藏、忽略、重评紧邻相应岗位。证据展开中以“岗位要求”“画像证据”并列结构呈现已有 `jobEvidence` / `profileEvidence`，并用已有 dimension 标签组织优势与缺口，同时保留全版本 ID 和原值；不得从未解析结构猜测匹配分数。历史、校准和详细评估保留为渐进展开。
4. 调整与首页相关的 Agent Inbox、Agent Run、Recommendation Run 组件，使不可用、加载、离线与错误文本仍可识别且操作边界不变。

验证：逐文件执行 `pnpm --filter web exec vitest run components/workbench/workbench-home-view.test.tsx components/workbench/recommendation-run-panel.test.tsx app/(workbench)/home/recommendation-run-ssr-reload.test.tsx app/(workbench)/recommendations/page.test.tsx app/(workbench)/recommendations/recommendation-decision.test.tsx app/(workbench)/recommendations/reevaluate-button.test.tsx --no-file-parallelism`；记录每片 RED/GREEN。手工检查推荐操作、折叠证据、首次运行准备和恢复。

### 3. 画像与设置工作流

1. 在 `components/workbench/profile-import-view.test.tsx` 为事实确认/拒绝、冲突、手工添加/导入进入编辑态及保存结果补充行为覆盖；目标、Watchlist、设置、模型连接和岗位导入沿用并补充各自 `*.test.tsx` 的保存/错误/恢复行为断言。
2. 将画像页改为按 `factType` 分组、已确认事实优先的可扫描阅读页，把导入与手工添加收束为聚焦编辑区；候选事实、冲突和来源说明保留独立、明确的决定入口，导入入口保持 44px 可触达。
3. 重组目标、Watchlist、运行策略、模型连接和岗位导入页面：每页只保留一个明确主行动，表单分组并把错误就近呈现；设置的必要对照表采用局部横向滚动，页面本身不得横向溢出。Watchlist 先呈现真实公司来源列表和当前状态，再按需展开编辑、能力与诊断；保留原来的 server action、字段名称、可访问标签和保存状态。

验证：逐文件执行 `pnpm --filter web exec vitest run components/workbench/profile-import-view.test.tsx components/workbench/job-targets-view.test.tsx components/workbench/company-watchlist-view.test.tsx components/workbench/account-run-policy-view.test.tsx components/workbench/model-connection-view.test.tsx components/workbench/job-import-view.test.tsx --no-file-parallelism`，再在已有 E2E 中串行覆盖目标/Watchlist、模型诊断、岗位导入和画像事实决定。新增视觉结构只由行为断言覆盖，不做颜色快照。

### 4. 营销与登录

1. 重构营销组件、布局和登录页的共享 token、排版和动作层级。
2. 营销首屏展示“发现—判断—决定”的示例简报，并保留示例标识、外部行动边界和真实登录入口。
3. 保留 Dev Auth 与微信 OAuth 的既有分支、表单和错误恢复；确保营销示例 tab 顺序与键盘操作可用。

验证：逐文件执行 `pnpm --filter web exec vitest run app/(marketing)/page-content.test.tsx app/(marketing)/page.test.tsx app/login/page.test.tsx --no-file-parallelism`，再串行运行 `pnpm --filter web exec playwright test e2e/landing.spec.ts e2e/auth-workbench.spec.ts --workers=1`；真实浏览器检查示例标识、焦点与窄屏排版。

### 5. 设计记录、质量与验收

1. 更新根级 `DESIGN.md` 及必要的 `.impeccable/design.json`，记录 tokens、页面模式、响应式导航、动效和无障碍规则；补充参考研究的采用/舍弃结论、许可和新增依赖（预期不新增 UI runtime）。采用 shadcn（MIT）和 Reactive Resume（MIT）的通用模式；仅研究 Plane（AGPL-3.0）和 Twenty（NOASSERTION）模式，不复制代码；MagicUI/Motion Primitives（MIT）仅作模式参考且不新增动画 runtime。
2. #61 最终释放租约后，先执行 `pnpm install --frozen-lockfile`，再读取新安装依赖内的 Next 16 相关 guide；不复用 #61 的 `node_modules`、`.next` 或任何构建产物。随后串行运行定向 Vitest、受影响 E2E、`pnpm --filter web typecheck`、`pnpm --filter web lint`、`pnpm --filter web build`；每个命令单独输出到 `/tmp/job-copilot-issue-66/`，测试前后确认无同项目残留进程。每次均以 `ps` 查验 Vitest、Playwright、e2e-runner 与 Next build，绝不并发。`dev:test` 固定共享 composeProject/3120/3121/55420 并会 `docker down -v`，因此仅在 #61 最终释放租约后启动。
3. 真实浏览器对十路由分别生成 1440px/390px 新旧截图，检查主要操作、空/加载/错误、键盘、focus、AA 对比度、reduced-motion、overflow、hydration；最多两轮集中修复。
4. 在 `/tmp/job-copilot-issue-66/execution-report.md` 提供改动摘要、每条 AC 的证据链接、命令日志、截图、参考/许可记录与真实限制，供独立 Supervisor 审查。

## 路由与验收映射

| 路由 | 重构重点 | 关键保留行为 |
| --- | --- | --- |
| `/` | 示例行动简报与证据链 | 登录入口、示例/审批边界 |
| `/login` | 同品牌认证页 | Dev Auth / 微信 OAuth / 错误恢复 |
| `/home` | 今日行动、摘要、AI 工作与待决定事项 | 首次推荐准备、启动、SSR/SSE 恢复、Inbox 决定 |
| `/recommendations` | 岗位、结论、证据优先 | 收藏、忽略、重评、历史 |
| `/jobs/import` | 聚焦岗位导入 | 原始证据、提交/错误状态 |
| `/profile` | 已确认事实、候选事实与冲突 | 确认、拒绝、冲突解决、导入与手工添加 |
| `/profile/targets` | 目标摘要与编辑 | 创建、修改、保存 |
| `/profile/targets/[targetId]/watchlist` | 公司与来源摘要 | 来源管理、状态与保存 |
| `/profile/run-policy` | 运行策略编辑 | 上限、版本与保存 |
| `/profile/model-connection` | 连接状态与诊断 | 真实模型诊断与恢复建议 |

首页的五个真实 `run.stages` 以离散 stepper 呈现，保留 pending/running/completed 文案；六步首次推荐旅程优先当前一步并可展开查看完整旅程。相应 E2E 通过展开路径断言全部既有步骤，不删除步骤断言。

## 完成标准

- AC1–AC3：十个路由共享新外壳和 tokens，结构由行动/结果优先，详细内容按需展开。
- AC4：所有现有领域操作、恢复和权限/证据约束保留，新增测试只扩充 UI 行为。
- AC5：每路由具备 1440px / 390px 的真实浏览器截图、人工记录与可访问性/动效/溢出检查。
- AC6：每条实际运行的串行命令均有完整日志和 exit status；不得将未运行检查写为通过。
- AC7：根级 `DESIGN.md`、`.impeccable/design.json` 和 execution report 记录参考、许可、采用/舍弃与依赖。
- AC8：本计划、TDD 证据、独立 Standards/Spec/视觉审查和完整执行报告都交给 Coordinator；不由 Executor 创建 PR、合并或关闭 Issue。
