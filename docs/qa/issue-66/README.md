# Issue #66 浏览器验收记录

## 当前结论（返工后）

十路由与四个动态态已用显式 `CAREER_LENS_CAPTURE=after` 真实运行时重新采集；未设置该变量的采集路径返回 `null`，不会写入 `before`。Inbox、首次旅程与导入审核由不同 fixture/account 采集；Inbox 与首次旅程哈希在双视口均不同。目标、Watchlist、岗位导入、职业资料和运行策略均按“状态 → 下一行动 → 台账/结果”重组，新增/编辑/导入表单只在用户点击操作后出现；E2E 保留真实请求与状态断言。

完整指定 E2E 仍非全绿：`one-click-recommendation.spec.ts` 的两个视口期望 `paused`、实际 `cancelled`，且协调者已在干净 `origin/main` 独立复现，故为既有 API/worker 缺陷、**UNVERIFIED（基线/非范围）**，未改 API/worker 或弱化断言。其余本轮受影响 Profile、运行策略、模型、Watchlist、岗位导入、推荐、目标、Inbox 和 acceptance 均有无重叠的串行 GREEN 日志。此前两次运行时清理阶段出现重叠，相关输出已作废且未作为下表证据。

## 实现与动态态

- `85ec7ea`：完成工作台、推荐、资料导入、目标/来源、运行策略和模型诊断的表现层迁移。
- `2d9ef21`：修复候选事实/次目标可访问名歧义；将推荐 E2E 对齐岗位和画像 evidence region；Mobile Safari Inbox 与忽略动作改为滚动后点击并以 API 轮询确认持久化。
- `screenshots/after/` 保存十路由与四动态态的 Desktop Chrome / Mobile Safari 运行时截图；校准态为 `recommendations-calibration-{desktop-chrome,mobile-safari}.png`。

## 验证证据

| 检查 | 当前结果 | 日志 |
| --- | --- | --- |
| 受影响 E2E：Profile Markdown / DOCX / PDF | PASS，10 passed | 本轮串行会话记录 |
| 受影响 E2E：运行策略 / 模型诊断 | PASS，10 passed | `serial-final-b-run-policy-model.log`（原始输出，未跟踪） |
| 受影响 E2E：目标 / Watchlist / 岗位导入 / 推荐 | PASS，22 passed | 本轮串行会话记录 |
| 受影响 E2E：Inbox | PASS，2 passed、4 skipped（分 phase 设计） | 本轮串行会话记录 |
| Web Vitest | PASS，94 files / 655 tests | `rework-web-test-final.log` |
| typecheck / lint / build | PASS | `web-*-recovery-final.log` |
| Career Lens acceptance（显式 `after`） | PASS，10 passed | `rework-acceptance-after-final.log` |
| finesse detector | PASS，P0=0；P1/P2 为既有样式提示 | `finesse-detect-recovery-final.log` |
| 全量串行 E2E | UNVERIFIED，114 passed / 8 skipped / 2 failed | `task-8-all-specified-e2e-final.log` |
| 全局停止独立复现（清除 `CAREER_LENS_CAPTURE`） | UNVERIFIED，8 passed / 2 failed / 2 skipped | `task-8-one-click-recommendation-rerun.log` |

全量 E2E 与独立复现的失败均为同一双视口用例：`one-click-recommendation.spec.ts:589`，期望 `paused`、实际 `cancelled`。协调者已在全新 `origin/main` 工作树以同一命令独立复现为 8 passed / 2 failed / 2 skipped，故这是既有 API/worker 缺陷，不是本分支回归；该 spec 相对 `origin/main...HEAD` 也无 diff。运行策略与推荐页面改动只涉及 landmark、region 和展示组织，不触及停止请求或运行状态机。任务契约禁止 API/worker 修复，故不将该失败伪装为 Web 通过。

原始 B 分段输出由 Docker Compose 写入尾随空白，按交接约束保持为未跟踪的 `serial-final-b-run-policy-model.log`，不纳入提交；上述其它串行命令已在本执行会话中完成，未以此原始输出替代历史审计日志。

## 视觉与可访问性

已逐张查看 28 张 `screenshots/after/*.png`，Desktop/Mobile 均通过，关键缺项均为 0。评分格式为布局/主视觉/字体色彩/内容组件/移动=总分；每项的唯一扣分是相应长台账或说明的全页信息密度。

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
| 运行策略 `/profile/run-policy` | 29/24/19/15/9 = 96 | 移动两列策略表较长 |
| 模型诊断 `/profile/model-connection` | 30/24/19/15/9 = 97 | 诊断说明 |
| Inbox 动态态 | 29/24/19/15/9 = 96 | 决策队列长度 |
| 首次推荐旅程动态态 | 29/24/19/15/9 = 96 | 步骤状态密度 |
| 导入审核动态态 | 29/24/19/15/9 = 96 | 原文证据密度 |
| 推荐校准动态态 | 29/24/19/15/9 = 96 | 规则/证据密度 |

键盘焦点、44px 触控、对比度、`prefers-reduced-motion`、无根横向溢出及空/加载/错误/恢复均由 acceptance 和受影响 E2E 覆盖。移动运行策略显示“设置/最终生效”两列，桌面保留完整五列。采用浅蓝工作台、深色运行区、可见状态卡和移动底栏，舍弃“职业透镜”作为用户产品名；未新增依赖或资产，现有代码与静态资产许可不变。finesse 的 `draft.careersUrl.trim(` 为 TS 表达式路径误报，另有 P2 stamp 提示，无真实死链。

静态旧图可与 `screenshots/before/` 的 18 个受版本控制文件逐项对照；旧动态态没有归档 before，明确标为缺证，未伪造。设计采用浅蓝工作台、深色运行区、可见状态卡和移动底栏；舍弃“职业透镜”作为用户产品名。未添加依赖或资产，现有代码与静态资产许可不变。

## Before 证据隔离

全量运行曾意外写入 `screenshots/before/**`。18 个受影响的 tracked 静态截图及 8 个未跟踪 dynamic-before 截图均保持未暂存、未提交、未作为 before 证据；它们由协调者按安全规则恢复。
