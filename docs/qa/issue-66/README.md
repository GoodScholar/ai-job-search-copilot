# Issue #66 浏览器验收记录

## 当前结论（返工后）

十路由与四个动态态已用显式 `CAREER_LENS_CAPTURE=after` 真实运行时重新采集；未设置该变量的采集路径返回 `null`，不会写入 `before`。Inbox、首次旅程与导入审核由不同 fixture/account 采集；Inbox 与首次旅程哈希在双视口均不同。目标、Watchlist、岗位导入和推荐空态已经按“状态 → 下一行动 → 台账/结果”重组，新增/编辑表单只在用户点击操作后出现；E2E 保留真实请求与状态断言。职业资料的上传与运行策略仍保留既有配置表单，因此不把它们误报为已完成“默认隐藏表单”的重构。

完整指定 E2E 仍非全绿：`one-click-recommendation.spec.ts` 的两个视口期望 `paused`、实际 `cancelled`，且协调者已在干净 `origin/main` 独立复现，故为既有 API/worker 缺陷、**UNVERIFIED（基线/非范围）**，未改 API/worker 或弱化断言。其余本轮受影响 Watchlist、岗位导入、推荐、目标和 acceptance 均有串行 GREEN 日志。

## 实现与动态态

- `85ec7ea`：完成工作台、推荐、资料导入、目标/来源、运行策略和模型诊断的表现层迁移。
- `2d9ef21`：修复候选事实/次目标可访问名歧义；将推荐 E2E 对齐岗位和画像 evidence region；Mobile Safari Inbox 与忽略动作改为滚动后点击并以 API 轮询确认持久化。
- `screenshots/after/` 保存十路由与四动态态的 Desktop Chrome / Mobile Safari 运行时截图；校准态为 `recommendations-calibration-{desktop-chrome,mobile-safari}.png`。

## 验证证据

| 检查 | 当前结果 | 日志 |
| --- | --- | --- |
| 受影响 Inbox / Markdown / 目标 / 推荐回归 | PASS | `task-8-*-selector-green.log`、`task-8-workbench-inbox-mobile-fix-green.log` |
| Web Vitest | PASS，93 files / 651 tests | `web-test-recovery-final.log` |
| typecheck / lint / build | PASS | `web-*-recovery-final.log` |
| Career Lens acceptance | PASS，6 passed | `task-8-acceptance-recovery-final.log` |
| finesse detector | PASS，P0=0；P1/P2 为既有样式提示 | `finesse-detect-recovery-final.log` |
| 全量串行 E2E | UNVERIFIED，114 passed / 8 skipped / 2 failed | `task-8-all-specified-e2e-final.log` |
| 全局停止独立复现（清除 `CAREER_LENS_CAPTURE`） | UNVERIFIED，8 passed / 2 failed / 2 skipped | `task-8-one-click-recommendation-rerun.log` |

全量 E2E 与独立复现的失败均为同一双视口用例：`one-click-recommendation.spec.ts:589`，期望 `paused`、实际 `cancelled`。协调者已在全新 `origin/main` 工作树以同一命令独立复现为 8 passed / 2 failed / 2 skipped，故这是既有 API/worker 缺陷，不是本分支回归；该 spec 相对 `origin/main...HEAD` 也无 diff。运行策略与推荐页面改动只涉及 landmark、region 和展示组织，不触及停止请求或运行状态机。任务契约禁止 API/worker 修复，故不将该失败伪装为 Web 通过。

## 视觉与可访问性

已逐张查看 `screenshots/after/*.png`。目标、Watchlist、岗位导入和推荐空态达到 96–97；营销/登录为 98，首页与三个首页动态态为 96，模型诊断为 97。职业资料、导入审核与运行策略因默认可见的长表单仅评为 93–94，尚未满足本轮“表单仅在明确编辑模式出现”的视觉 AC；不得据此勾选全面视觉通过。无横向溢出、键盘/焦点、44px 触控、对比度、reduced-motion、空/加载/错误/恢复均有 acceptance/受影响 E2E 证据。finesse 本轮报告一个 `draft.careersUrl.trim(` 的误报 P0（把 TS 表达式误识别为路径）及 P2 stamp 提示，未发现真实死链。

静态旧图可与 `screenshots/before/` 的 18 个受版本控制文件逐项对照；旧动态态没有归档 before，明确标为缺证，未伪造。设计采用浅蓝工作台、深色运行区、可见状态卡和移动底栏；舍弃“职业透镜”作为用户产品名。未添加依赖或资产，现有代码与静态资产许可不变。

## Before 证据隔离

全量运行曾意外写入 `screenshots/before/**`。18 个受影响的 tracked 静态截图及 8 个未跟踪 dynamic-before 截图均保持未暂存、未提交、未作为 before 证据；它们由协调者按安全规则恢复。
