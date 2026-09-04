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

- Deferred smell：Inbox producer 必须嵌入各自现有事务以保证与来源记录同一提交的原子性；当前不抽取公共 transaction helper，避免扩大跨 producer 耦合。

- `apps/api/dist` 与 `apps/worker/dist` 已在构建后验证为 Nest build 生成物，并移出工作树；未删除或提交任何其他文件。
- `.impeccable/review/desktop.png` 与 `.impeccable/review/mobile.png` 保留为视觉验收证据，保持未跟踪且未提交。
- 未执行宽泛审查、Issue 评论、关闭 Issue、push、PR 或 merge。

提交本报告后，预期 `git status --short` 仍只显示上述未跟踪截图目录。

## Final Review Fix Round 1

基线：`9352a5516e5bd3911e97528f85aade30974e5b81`。

- RED：`pnpm --filter web exec vitest run app/api/agent-inbox/route.test.ts components/workbench/agent-inbox-panel.test.tsx components/workbench/workbench-home-view.test.tsx components/workbench/agent-run-panel.test.tsx --reporter=dot` 退出码 1；68 个测试中 8 个失败，分别复现 Inbox query 固定为 pending、mark-read 缓存没有跨筛选迁移、零待确认事实错误宣称资料未建立、targets 失败时隐藏 run-id 控制。
- GREEN：同一聚焦命令退出码 0；4 files、68 passed、1.17s。
- 修复提交：`320c83b3ef9c65b8d9659a5a018d5c2c63ee63f0`。BFF 校验并透传 pending/unread/read/resolved（无参数默认 pending、非法值 400）；已加载 Inbox 缓存会在 mark-read 时同步 pending/unread/read，resolved 保持不变且未读筛选安全回退焦点；零待确认事实改为中性文案；targets 失败只阻止新运行选择/启动，不阻止已有运行的 pause/resume/cancel；README 更新为真实任务控制范围，投递仍未启用。
- 完整复验：`DOCKER_API_VERSION=1.51 pnpm test` 退出码 0、30.2s（runtime 40/40、contracts 151/151、database 32/32、source-access 125/125、web 346/346）；`pnpm typecheck` 0、11.4s；`pnpm lint` 0、4.5s；`pnpm build` 0、12.2s；Drizzle check 0、0.7s；fixed-baseline `git diff --check` 0。
- build 后仅移出生成的 `apps/api/dist` 与 `apps/worker/dist`；最终 status 仅为未跟踪 `.impeccable/review/` 截图证据。

## Final Review Fix Round 2

本轮基线：`c4cf34b31192c7eec9dd764caaf9fee40159a84b`。

- RED：`pnpm --filter web exec vitest run components/workbench/agent-inbox-panel.test.tsx --reporter=dot` 退出码 1，16 个测试中 1 个失败、1.80s。已加载的 read 缓存把新标记项追加到末尾，违反服务端 `createdAt DESC, itemId DESC` 顺序。
- GREEN：同一组件文件退出码 0，16/16、0.80s。新增用例覆盖更旧/更新项排序、同一 `createdAt` 的 `itemId` 降序 tie-break，以及已有条目的替换无重复。
- 排序修复：`agent-inbox-panel.tsx` 以共享 `compareInboxItems`/`upsertInboxItem` 替代追加逻辑；pending、unread、read 的已加载缓存均在更新时保持服务端排序，resolved 缓存不受 mark-read 影响。
- 历史夹具兼容：完整测试依次复现并最小修正三处 Issue #15 生命周期迁移遗留断言/清理：domain 的 run_failed 状态 `open` → `unread`；API 的 unread pause item 补回 `mark_read` 动作和 `unread` 状态；worker career-import teardown 在删除 candidate facts 前先删除引用它们的 Inbox 项。生产 contracts/producers 已确认只接受并写入 `unread/read/resolved`，未修改生产行为。
- 瞬态运行时复验：一次完整运行在 `scripts/local-runtime.test.mjs` 的受控子进程 ESRCH 断言出现瞬态失败；原样重跑 `pnpm test:runtime` 退出码 0、40/40、0.47s，未改动 runtime 代码。

| 命令 | 退出码 | 耗时 / 结果 |
| --- | ---: | --- |
| Inbox 排序 RED | 1 | 16 个测试中 15 passed、1 failed，1.80s。 |
| Inbox 组件 GREEN | 0 | 16/16，0.80s。 |
| `pnpm --filter @job-copilot/domain exec vitest run src/agent-runs.integration.test.ts --no-file-parallelism` | 0 | 33/33，4.23s。 |
| `pnpm --filter api exec vitest run src/api.integration.test.ts --reporter=dot` | 0 | 52/52，3.97s。 |
| `pnpm --filter worker exec vitest run src/career-import/career-import.integration.test.ts --no-file-parallelism` | 0 | 7/7，4.51s。 |
| `DOCKER_API_VERSION=1.51 pnpm test`（最终） | 0 | runtime 40/40；contracts 151/151；database 32/32；source-access 125/125；web 347/347；domain 503/503；API 162/162；worker 301/301。 |
| `pnpm typecheck` | 0 | 8.6s。 |
| `pnpm lint` | 0 | 3.4s。 |
| `pnpm build` | 0 | 9.2s。 |
| `pnpm --filter @job-copilot/database exec drizzle-kit check --config=drizzle.config.ts` | 0 | 0.5s；`Everything's fine`。 |

本轮构建后再次验证 `apps/api/dist`、`apps/worker/dist` 为未跟踪 Nest 生成物，并移至 `/tmp/issue15-task7-build-artifacts.GwGgjj`；没有删除其他用户文件。`.impeccable/review/` 继续保留为未跟踪验收截图，不提交。
