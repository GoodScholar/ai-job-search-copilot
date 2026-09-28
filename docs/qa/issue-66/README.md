# Issue #66 浏览器验收记录

## 当前结论（返工后）

十路由与四个动态态已用显式 `CAREER_LENS_CAPTURE=after` 真实运行时重新采集；未设置该变量的 10 项 acceptance 也已通过，并确认未写入 `screenshots/before/**`。四个动态态的 before 已由恢复的独立 `origin/main` 工作树（`fa67dd655aee9bc63eb95e61590648a15cbbdb66`）真实补采；临时采证 harness 仅作为不可自动执行的 QA 复现材料保存在 `baseline-harness/`。Inbox、首次旅程与导入审核由不同 fixture/account 采集；Inbox 与首次旅程哈希在双视口均不同。目标、Watchlist、岗位导入、职业资料和运行策略均按“状态 → 下一行动 → 台账/结果”重组，新增/编辑/导入表单只在用户点击操作后出现；E2E 保留真实请求与状态断言。

完整指定 E2E 仍非全绿：`one-click-recommendation.spec.ts` 的两个视口期望 `paused`、实际 `cancelled`，且协调者已在干净 `origin/main` 独立复现，故为既有 API/worker 缺陷、**UNVERIFIED（基线/非范围）**，未改 API/worker 或弱化断言。其余本轮受影响 Profile、运行策略、模型、Watchlist、岗位导入、推荐、目标、Inbox 和 acceptance 均有无重叠的串行 GREEN 日志。此前两次运行时清理阶段出现重叠，相关输出已作废且未作为下表证据。

## 实现与动态态

- `85ec7ea`：完成工作台、推荐、资料导入、目标/来源、运行策略和模型诊断的表现层迁移。
- `2d9ef21`：修复候选事实/次目标可访问名歧义；将推荐 E2E 对齐岗位和画像 evidence region；Mobile Safari Inbox 与忽略动作改为滚动后点击并以 API 轮询确认持久化。
- `screenshots/after/` 保存十路由与四动态态的 Desktop Chrome / Mobile Safari 运行时截图；校准态为 `recommendations-calibration-{desktop-chrome,mobile-safari}.png`。

## 验证证据

| 检查 | 当前结果 | 日志 |
| --- | --- | --- |
| 受影响 E2E：Profile Markdown / DOCX / PDF | PASS，10 passed | `task-8-markdown-career-import-selector-green.log`（Markdown 4 passed）；`task-8-all-specified-e2e-final.log`（DOCX/PDF 与其余指定 spec 的完整串行输出；仅 one-click 基线缺陷失败） |
| 返工定向 E2E：运行策略 / Markdown 导入 / 推荐 | PASS，8 / 4 / 本轮推荐 12 passed | `task-8-all-specified-e2e-final.log`；`task-8-markdown-career-import-selector-green.log`；`recommendations-e2e-after-final-current.log`，均为 `--workers=1` |
| 受影响 E2E：运行策略 / 模型诊断 | PASS，10 passed | `task-8-all-specified-e2e-final.log`（完整串行输出；仅 one-click 基线缺陷失败） |
| 受影响 E2E：目标 / Watchlist / 岗位导入 / 推荐 | PASS，22 passed | `task-8-all-specified-e2e-final.log`；目标定向见 `task-8-job-targets-selector-green.log`，Watchlist 定向见 `rework-watchlist-e2e-green.log` |
| 本轮 Watchlist 空态补采 E2E | PASS，4 passed | `task-8-watchlist-empty-after-20260928.log`（本轮 `tee` 保存的完整 stdout/stderr，显式 `CAREER_LENS_CAPTURE=after`） |
| 受影响 E2E：Inbox | PASS，2 passed、4 skipped（分 phase 设计） | `task-8-workbench-inbox-mobile-fix-green.log`；完整指定 E2E 输出见 `task-8-all-specified-e2e-final.log` |
| Web Vitest | PASS，95 files / 662 tests | `web-test-final-current.log`（完整 stdout/stderr） |
| typecheck / lint / build | PASS | `web-typecheck-final-current.log`、`web-lint-final-current.log`、`web-build-final-current.log`（各自完整 stdout/stderr） |
| Career Lens acceptance（未设置 capture / 显式 `after`） | PASS，10 / 10 passed；前者未写 before | `rework-acceptance-after-fixture-final.log`、`rework-acceptance-after-final.log`（完整 stdout/stderr）；`task-8-state-matrix-after-20260928.log` 仅为索引摘要 |
| 动态态 baseline before（`fa67dd6`） | PASS：临时 `issue66-before-dynamic.spec.ts` 6 passed；Inbox 4 passed / 2 skipped、source phase 2 passed / 4 skipped | 来源与哈希：`task-0-dynamic-before-origin-main.log`；原始输出：`task-0-dynamic-before-raw.log`、`task-0-workbench-inbox-before-raw.log`；复现材料：`baseline-harness/` |
| finesse detector | PASS，P0=0；P1/P2 为既有样式提示 | `finesse-detect-recovery-final.log` |
| 全量串行 E2E | UNVERIFIED，114 passed / 8 skipped / 2 failed | `task-8-all-specified-e2e-final.log` |
| 全局停止独立复现（清除 `CAREER_LENS_CAPTURE`） | UNVERIFIED，8 passed / 2 failed / 2 skipped | `task-8-one-click-recommendation-rerun.log` |

全量 E2E 与独立复现的失败均为同一双视口用例：`one-click-recommendation.spec.ts:589`，期望 `paused`、实际 `cancelled`。协调者已在全新 `origin/main` 工作树以同一命令独立复现为 8 passed / 2 failed / 2 skipped，故这是既有 API/worker 缺陷，不是本分支回归；该 spec 相对 `origin/main...HEAD` 也无 diff。运行策略与推荐页面改动只涉及 landmark、region 和展示组织，不触及停止请求或运行状态机。任务契约禁止 API/worker 修复，故不将该失败伪装为 Web 通过。

原始 B 分段输出由 Docker Compose 写入尾随空白，按交接约束保持为未跟踪的 `serial-final-b-run-policy-model.log`，不纳入提交；上述其它串行命令已在本执行会话中完成，未以此原始输出替代历史审计日志。

## 视觉与可访问性

状态矩阵的 30 个命名状态视图、60 张本轮 `screenshots/after/*-{desktop-chrome,mobile-safari}.png` 均已逐张查看，Desktop/Mobile 均通过，关键缺项均为 0。评分格式为布局/主视觉/字体色彩/内容组件/移动=总分；每项的唯一扣分是相应长台账或说明的全页信息密度。Mobile Policy 截图只展示横滚容器的左起列；定向 Mobile Safari E2E 已验证五个表头均在可访问树、表格容器确有横滚且根页面不溢出，因此不以“裁切隐藏列”冒充通过。

| 页面或动态态 | 五维评分 | 扣分 |
| --- | --- | --- |
| 营销 `/` | 30/25/20/14/9 = 98 | 移动旅程说明密度 |
| 登录 `/login` | 30/25/20/14/9 = 98 | 移动说明密度 |
| 首页 `/home` | 29/24/19/15/9 = 96 | 状态带与台账长度 |
| 推荐 `/recommendations` | 29/24/19/15/9 = 96 | 空态证据说明密度 |
| 职业资料 `/profile` | 29/24/19/15/9 = 96 | 事实说明密度 |
| 求职目标 `/profile/targets` | 30/24/19/15/9 = 97 | 约束字段长度 |
| 公司来源 `/profile/targets/:id/watchlist` | 30/24/19/15/9 = 97 | 来源 URL/字段长度 |
| 岗位导入 `/jobs/import` | 30/24/19/15/9 = 97 | 导入模式说明 |
| 运行策略 `/profile/run-policy` | 29/24/19/15/9 = 96 | 移动五列通过容器局部横滚阅读，首次视口只显示左起列 |
| 模型诊断 `/profile/model-connection` | 30/24/19/15/9 = 97 | 诊断说明 |
| Inbox 动态态 | 29/24/19/15/9 = 96 | 决策队列长度 |
| 首次推荐旅程动态态 | 29/24/19/15/9 = 96 | 步骤状态密度 |
| 导入审核动态态 | 29/24/19/15/9 = 96 | 原文证据密度 |
| 推荐校准动态态 | 29/24/19/15/9 = 96 | 规则/证据密度 |

键盘焦点、44px 触控、对比度、`prefers-reduced-motion`、无根横向溢出及空/加载/错误/恢复均由 acceptance 和受影响 E2E 覆盖。移动运行策略保留完整五列：设置、系统默认、硬上限、你的设置、最终生效；桌面同样保留五列。采用浅蓝工作台、深色运行区、可见状态卡和移动底栏，舍弃“职业透镜”作为用户产品名；未新增依赖或资产，现有代码与静态资产许可不变。finesse 的 `draft.careersUrl.trim(` 为 TS 表达式路径误报，另有 P2 stamp 提示，无真实死链。

静态旧图可与 `screenshots/before/` 的 18 个受版本控制文件逐项对照；**AC-012 动态态旧版 before 已补证**：协调者在恢复的独立 `origin/main` 工作树（`fa67dd6`）串行真实运行临时采证 spec/截图钩子，未改旧 UI。八张动态图的完整 SHA-256 记录在 `logs/task-0-dynamic-before-origin-main.log`；原始 stdout 与可复现 harness/hook 分别保存在 `logs/task-0-*-raw.log` 和 `baseline-harness/`。设计采用浅蓝工作台、深色运行区、可见状态卡和移动底栏；舍弃“职业透镜”作为用户产品名。未添加产品依赖或资产，现有代码与静态资产许可不变。

### 逐页可访问性、对比度与状态映射

| 页面或动态态 | 对比度检查 | 空、加载、错误与恢复检查 |
| --- | --- | --- |
| 营销、登录 | 深蓝正文/白或浅蓝背景、蓝色 CTA/白字均由 `landing.spec.ts` 与截图复核 | 无异步数据；登录安全 returnTo 和本地体验登录 action 保持可恢复 |
| 首页、首次旅程、Inbox | 深色运行区白字与浅卡深蓝字；状态卡不依赖仅颜色 | 空账户、准备中、运行/阻塞、Inbox 忽略后的 API 刷新恢复由 `workbench-inbox.spec.ts` 与 acceptance fixture 覆盖 |
| 推荐、推荐校准 | 机会标题、证据区与操作蓝色均有文字标签 | 无目标空态、已有目标零推荐下一步、运行状态、校准冲突/重算/刷新由 `recommendations.spec.ts` 覆盖 |
| 职业资料、导入审核 | 深蓝正文、琥珀待确认标签均有文本状态 | 导入等待/解析完成/失败、刷新、候选事实决定与收起导入区后 live 状态由 Markdown/DOCX/PDF E2E 覆盖 |
| 求职目标、Watchlist | 卡片和来源状态使用文本+边框，不以颜色单独表达 | 目标空态、容量/冲突，来源未检查/失败/停用/排序与刷新由对应 E2E 覆盖 |
| 岗位导入 | 信息带和规范化字段深蓝/浅蓝对比，状态有文字 | 三种导入、轮询、原文、失败与恢复由 `job-imports.spec.ts` 覆盖 |
| 运行策略 | 五列表头/数值在白卡深蓝文字中可读 | 保存、硬上限字段错误、停止/解除和历史刷新；Mobile 容器横滚/根不溢出由 `account-run-policy.spec.ts` 覆盖 |
| 模型诊断 | 深色边框/深蓝正文与显式状态文字 | checking、failed、temporary、retryAt、aria-live 与重试由 `model-diagnostics.spec.ts` 覆盖 |

## Before 证据隔离

历史全量运行曾意外写入 `screenshots/before/**`；那批污染文件不作为证据。当前提交的八张动态 before 则由协调者从恢复的独立基线工作树复制而来，来源、命令、结果与 SHA-256 均在 `logs/task-0-dynamic-before-origin-main.log` 可核对。

## After 状态矩阵（本轮显式运行时采图）

下表逐一闭合十路由及 Inbox、首次推荐旅程、导入审核、推荐校准四个任务态的空、内容和关键失败证据。每个文件模式的 `{desktop-chrome,mobile-safari}` 都展开为同一真实 E2E fixture 在两个视口采得的两张图，且已逐张目视；同一页面的父路由与任务子态可共用该真实截图时会在“理由”中明确说明，绝不复制或以静态 mock 冒充状态。评分沿用上表对应页面的五维分数，并额外复核主对象、状态文案、下一行动和无根横向溢出。

| 路由/任务态 | 空态（双视口文件） | 内容态（双视口文件） | 关键失败态（双视口文件） | 真实 fixture、理由与评分 |
| --- | --- | --- | --- | --- |
| `/` 营销 | N/A | `marketing-empty-{desktop-chrome,mobile-safari}.png`（文件名沿用旧 capture 命名，画面为静态落地内容） | N/A | 没有账户读取、异步请求或可失败的营销数据源；故不存在产品意义的空/失败态。98，关键缺项 0。 |
| `/login` | N/A | `login-empty-{desktop-chrome,mobile-safari}.png`（静态登录/returnTo 内容） | N/A | Beta 登录边界未读取远端身份数据，失败由提交登录后的恢复路径处理，不能伪造静态失败图。98，关键缺项 0。 |
| `/home` | `home-empty-{desktop-chrome,mobile-safari}.png` | `home-inbox-content-{desktop-chrome,mobile-safari}.png`、`home-first-recommendation-journey-content-{desktop-chrome,mobile-safari}.png` | `home-inbox-failure-{desktop-chrome,mobile-safari}.png`、`home-first-recommendation-journey-failure-{desktop-chrome,mobile-safari}.png` | 同一路由的两项真实动态 fixture 分别覆盖待确认事实和首次旅程；空账户图覆盖无任务队列。96，关键缺项 0。 |
| `/recommendations` | `recommendations-empty-{desktop-chrome,mobile-safari}.png` | `recommendations-content-{desktop-chrome,mobile-safari}.png`、`recommendations-calibration-content-{desktop-chrome,mobile-safari}.png` | `recommendations-failure-{desktop-chrome,mobile-safari}.png` | 无目标、真实推荐列表和真实校准审核均在该路由；过期校准规则冲突给出重新计算行动。96，关键缺项 0。 |
| `/profile` | `profile-empty-{desktop-chrome,mobile-safari}.png` | `profile-import-review-content-{desktop-chrome,mobile-safari}.png` | `profile-import-review-failure-{desktop-chrome,mobile-safari}.png` | 导入审核在 `/profile#candidate-facts` 真实呈现，是该父路由的内容/并发失败子态；空画像图没有当前导入。96，关键缺项 0。 |
| `/profile/targets` | `profile-targets-empty-{desktop-chrome,mobile-safari}.png` | `profile-targets-content-{desktop-chrome,mobile-safari}.png` | `profile-targets-failure-{desktop-chrome,mobile-safari}.png` | 真实保存主目标及版本冲突 fixture。97，关键缺项 0。 |
| `/profile/targets/:id/watchlist` | `profile-targets-watchlist-empty-{desktop-chrome,mobile-safari}.png` | `profile-targets-watchlist-content-{desktop-chrome,mobile-safari}.png` | `profile-targets-watchlist-failure-{desktop-chrome,mobile-safari}.png` | 本轮由既有 Watchlist E2E 在“尚未登记目标公司”断言后补采空台账；随后同一真实 API fixture 添加来源并触发版本冲突。97，关键缺项 0。 |
| `/jobs/import` | `jobs-import-empty-{desktop-chrome,mobile-safari}.png` | `jobs-import-content-{desktop-chrome,mobile-safari}.png` | `jobs-import-failure-{desktop-chrome,mobile-safari}.png` | 三种真实导入入口、完成岗位和规范化失败恢复。97，关键缺项 0。 |
| `/profile/run-policy` | `profile-run-policy-empty-{desktop-chrome,mobile-safari}.png` | `profile-run-policy-content-{desktop-chrome,mobile-safari}.png` | `profile-run-policy-failure-{desktop-chrome,mobile-safari}.png` | 无保存策略、保存后台账及本地硬上限校验；Mobile 的五列仍在 DOM 且只在容器局部横滚。96，关键缺项 0。 |
| `/profile/model-connection` | `profile-model-connection-empty-{desktop-chrome,mobile-safari}.png` | `profile-model-connection-content-{desktop-chrome,mobile-safari}.png` | `profile-model-connection-failure-{desktop-chrome,mobile-safari}.png` | 真实受控诊断的 available/authentication_failed fixture；checking/temporary 是不可稳定截留的真实轮询动态断言，而非 mock 截图。97，关键缺项 0。 |
| Inbox 任务态（`/home`） | `home-empty-{desktop-chrome,mobile-safari}.png` | `home-inbox-content-{desktop-chrome,mobile-safari}.png` | `home-inbox-failure-{desktop-chrome,mobile-safari}.png` | 无候选事实时队列不渲染；独立导入审核 fixture 产生 Inbox，离线动作失败后可重试并由轮询确认恢复。96，关键缺项 0。 |
| 首次推荐旅程（`/home`） | `home-empty-{desktop-chrome,mobile-safari}.png` | `home-first-recommendation-journey-content-{desktop-chrome,mobile-safari}.png` | `home-first-recommendation-journey-failure-{desktop-chrome,mobile-safari}.png` | 空账户尚未满足目标/来源前置条件；独立准备账户显示旅程，物理发现失败图保留下一待办。96，关键缺项 0。 |
| 导入审核（`/profile#candidate-facts`） | `profile-empty-{desktop-chrome,mobile-safari}.png` | `profile-import-review-content-{desktop-chrome,mobile-safari}.png` | `profile-import-review-failure-{desktop-chrome,mobile-safari}.png` | 无当前/最近导入时为空；解析完成候选事实和并发版本冲突均为真实职业资料导入链路，任务状态持续 `aria-live`。96，关键缺项 0。 |
| 推荐校准（`/recommendations`） | `recommendations-calibration-empty-{desktop-chrome,mobile-safari}.png` | `recommendations-calibration-content-{desktop-chrome,mobile-safari}.png` | `recommendations-failure-{desktop-chrome,mobile-safari}.png` | 真实质量不足 fixture 产生零推荐且零提案，显示“暂无待审校准建议”及继续处理推荐决定的说明；Inbox 跳转产生审核提案，过期规则冲突是该操作的关键失败并给出重新计算。96，关键缺项 0。 |

本轮新增/恢复的行为断言首先作为回归测试落地：导入编辑区的真实 `Tab` 顺序到文件输入、Watchlist 的公司名/招聘入口/允许域/来源备注与保存按钮均为 >=44px、运行策略本地超硬上限错误、推荐过期校准错误、职业资料并发冲突以及 Inbox 离线恢复。前两项为既有实现上首次运行即 GREEN 的断言恢复，未伪造 RED；首次推荐旅程曾因旧 E2E 直接操作已折叠文件控件而 RED，改为先点击“开始导入职业资料”后 GREEN。本轮校准空态先由 `calibration-proposals.test.tsx` RED（零提案无 named region）证明缺口，再以可见空态 GREEN；真实 recommendations E2E 12 passed 并采双视口图，日志为 `rework-calibration-empty-{red,green}-current.log` 与 `recommendations-e2e-after-final-current.log`。所有采图均只在 `CAREER_LENS_CAPTURE=after` 时写入 after；未设置变量的 acceptance 10 passed，且 before 路径前后无差异。
