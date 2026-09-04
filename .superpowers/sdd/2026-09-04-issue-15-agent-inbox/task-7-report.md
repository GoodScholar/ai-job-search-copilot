# Task 7 — 全量验证报告

固定基线：`5cafc4f71392d221f21cdaa035ff74f85cfaf7fa`  
任务起始 HEAD：`aaf51ab1e5805c4a6d35631a69a913e8e4d8a248`

## 失败诊断与修复

首次全量测试在两个历史数据库迁移夹具失败。根因是夹具复制迁移目录后仅从临时 journal 排除了 `0024`–`0042`，遗漏 `0043_task_control_agent_inbox`：临时旧数据库因此提前记录了 0043，正式迁移按时间戳跳过中间迁移；0024 夹具还继续以已经迁移的 `open` 生命周期断言新 schema。

- `b15f80221836a6ee4a819fde944fde7d44af99ed` — 让 0023/0024 历史夹具同时排除 0043，并同步 0043 的旧 `source_attention` → `discovery_attention` 与后迁移 `unread` 期望。
- `9bb776aca0dbd3e83287c1e103d9de1656e2d33d` — 将 Web API-client 的 unread Inbox 夹具动作更新为 `mark_read, resume_run, cancel_run`，与共享 schema 一致。

没有修改生产代码。

## 新鲜命令证据

| 命令 | 退出码 | 耗时 / 结果 |
| --- | ---: | --- |
| `DOCKER_API_VERSION=1.51 pnpm test`（首次） | 1 | 18.1s；runtime 40/40、contracts 151/151；database 30 passed、2 failed，随后停止。 |
| 数据库两文件诊断重跑 | 1 | 7.11s；7 个测试中 2 failed，稳定复现。 |
| 数据库两文件重跑（首次夹具修正后） | 1 | 7.21s；识别出剩余的 post-migration `open` 夹具。 |
| 数据库两文件定向验证 | 0 | 6.97s；2 files、7 passed。 |
| `DOCKER_API_VERSION=1.51 pnpm test`（第二次） | 1 | 27.2s；runtime 40/40、contracts 151/151、database 32/32、source-access 125/125；web 337 passed、1 failed。 |
| `pnpm --filter web exec vitest run lib/server/api-client.test.ts --reporter=dot` | 0 | 0.49s；1 file、32 passed。 |
| `DOCKER_API_VERSION=1.51 pnpm test`（最终） | 0 | 30.2s；runtime 40/40、contracts 151/151、database 32/32、source-access 125/125、web 338/338。 |
| `pnpm typecheck` | 0 | 13.9s；7 个 workspace 项目完成。 |
| `pnpm lint` | 0 | 3.7s；Web ESLint 完成。 |
| `pnpm build` | 0 | 17.5s；Web Next build 与 API/Worker Nest build 完成。 |
| `pnpm --filter @job-copilot/database exec drizzle-kit check --config=drizzle.config.ts` | 0 | 0.7s；`Everything's fine`。 |
| `git diff --check 5cafc4f71392d221f21cdaa035ff74f85cfaf7fa..HEAD` | 0 | 0.1s；无空白错误。 |
| `git status --short`（清理构建产物后） | 0 | 仅 `?? .impeccable/review/`。 |

数据库迁移测试仍输出 PostgreSQL 长约束名截断 NOTICE；命令退出码为 0，未出现测试失败。

## 工作树与证据边界

- `apps/api/dist` 与 `apps/worker/dist` 已在构建后验证为 Nest build 生成物，并移出工作树；未删除或提交任何其他文件。
- `.impeccable/review/desktop.png` 与 `.impeccable/review/mobile.png` 保留为视觉验收证据，保持未跟踪且未提交。
- 未执行宽泛审查、Issue 评论、关闭 Issue、push、PR 或 merge。

提交本报告后，预期 `git status --short` 仍只显示上述未跟踪截图目录。
