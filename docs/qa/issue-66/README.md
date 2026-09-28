# Issue #66 浏览器验收记录

## 当前结论

Issue #66 的 Career Lens 表现层、十条路由、Watchlist 与四个动态任务态均已实施并由真实运行时覆盖。唯一未闭环项是 `one-click-recommendation.spec.ts` 的账户全局停止状态：测试期望 queued B run 为 `paused`，API/worker 实际稳定返回 `cancelled`。这不是本 Issue 的 Web 表现层修改可处理的范围，故标记为 **UNVERIFIED（基线/非范围）**；除该项外，本记录中的证据均为 PASS。

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

人工查看确认 after 截图在双视口中无根横向溢出，关键路由和四任务态均可读；acceptance 覆盖 landmark、状态对象、reduced motion 和移动无溢出。营销页保留 Axe、键盘顺序、44px CTA 和登录边界断言；其余页面由组件测试与运行时 E2E 覆盖触控及状态路径。finesse 的 P1 side-stripe、P2 palette/stamp 提示已记录，不作为视觉缺项或功能失败处理。

## Before 证据隔离

全量运行曾意外写入 `screenshots/before/**`。18 个受影响的 tracked 静态截图及 8 个未跟踪 dynamic-before 截图均保持未暂存、未提交、未作为 before 证据；它们由协调者按安全规则恢复。
