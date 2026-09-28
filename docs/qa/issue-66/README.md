# Issue #66 浏览器验收记录

## 状态

本记录是**部分验收**，不能作为 Issue #66 完成或合并依据。Task 1、Task 2 与共享壳层已实施；计划中的 Task 3–7（工作台、推荐、画像/导入、目标/来源、运行护栏/模型诊断的逐组件迁移）没有实施。验收脚本只访问了八个静态路由，未能使用既有 fixture 覆盖动态 watchlist 路由及四个任务态。

2026-09-28 返工追加：动态 Watchlist fixture 已完成并产出双视口 runtime 截图；移动 `/profile/run-policy` 根溢出和推荐长清单固定导航遮挡已完成 RED→GREEN 修复。四个动态任务态截图、所有页面逐张人工评分和最终完整构建验证仍未完成，本记录继续保持“部分验收”。

## 证据与运行时

- before：`screenshots/before/` 中 18 张真实 Web runtime 截图（9 个已访问路由 × Desktop Chrome / Mobile Safari）。
- after：`screenshots/after/` 中相同 18 张截图，来自本分支的串行 Playwright 运行。
- 最后截图命令：`CAREER_LENS_CAPTURE=after pnpm --filter web test:e2e -- career-lens-acceptance.spec.ts --workers=1`，退出码 0，2 passed；日志在 `logs/task-8-after-e2e-final-stable.log`。
- 每个访问路由均断言 `main` 可见、移动/桌面无根节点横向溢出，并以 reduced motion 采集。脚本没有覆盖真实任务数据、键盘焦点序列或 44px 触控目标。

## 截图清单与人工评分

评分维度为布局 30、主视觉 25、字体/色彩 20、内容组件 15、移动 10。只有营销页和首页壳层做过人工打开检查；其余截图只确认由真实运行时生成，尚未逐页评分。因此不能用平均分或“通过”替代逐页门槛。

| 路由 | Desktop/Mobile 截图 | 人工结果 | 分数 / 100 | 关键缺项 |
| --- | --- | --- | ---: | --- |
| `/` | `marketing-*.png` | 已检查 | 95 | 无已发现关键缺项 |
| `/login` | `login-*.png` | 未逐页复核 | 未评分 | 需要移动阅读顺序与焦点检查 |
| `/home` | `home-*.png` | 已检查共享侧栏与实际空账户内容 | 79 | 主内容仍是旧工作台层级，Task 3 未实施 |
| `/recommendations` | `recommendations-*.png` | 未逐页复核 | 未评分 | Task 4 未实施 |
| `/profile` | `profile-*.png` | 未逐页复核 | 未评分 | Task 5 未实施 |
| `/profile/targets` | `profile-targets-*.png` | 未逐页复核 | 未评分 | Task 6 未实施 |
| `/jobs/import` | `jobs-import-*.png` | 未逐页复核 | 未评分 | Task 6 未实施 |
| `/profile/run-policy` | `profile-run-policy-*.png` | 未逐页复核 | 未评分 | Task 7 未实施 |
| `/profile/model-connection` | `profile-model-connection-*.png` | 未逐页复核 | 未评分 | Task 7 未实施 |
| `/profile/targets/:targetId/watchlist` | 无 | UNVERIFIED | 未评分 | 缺少稳定 target fixture |
| 四个既有任务态 | 无 | UNVERIFIED | 未评分 | 缺少对应 fixture 驱动的浏览器采集 |

## 可访问性与响应式证据

- 营销页 Playwright + Axe 回归在修复 `--muted` 对比度后通过；日志：`logs/task-2-landing-e2e-green.log`。
- 共享工作台具备侧栏 landmark；移动截图及 acceptance spec 检查没有页面级横向溢出。
- 仍未逐页验证键盘焦点、44px 命中、错误恢复、运行中刷新保持与全部任务态；这些是后续 Task 3–8 的必做项。

## 静态检查与限制

- `finesse-detect` 退出码 0（`logs/finesse-detect.log`），但报告 3 个既有 P1 side-stripe 命中和若干 token/stamp 提示；该检查不替代浏览器验收。
- `pnpm dlx shadcn@latest docs button` 因当前 MCP SDK 与 Zod 的版本不兼容而未能读取文档；未修改依赖或锁文件。
- 基线 API 失败 `latest.json().run === null` 不在本任务修复范围内。
