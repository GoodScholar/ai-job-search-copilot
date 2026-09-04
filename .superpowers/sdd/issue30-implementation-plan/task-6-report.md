# Task 6 / Slice 5 报告：Lead 与 Attribution 持久化

固定审查基线：`3a1a3940773921a1a03c3b25ea7baa378c025e83`。

实现提交：`f59e2a8500943417e9f1405997033b192eaf8511`（`feat(domain): persist job discovery leads`）。

## TDD 证据

- Red 1：新增 `job-discovery-leads.migrate.integration.test.ts` 后，`DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/database exec vitest run src/job-discovery-leads.migrate.integration.test.ts --no-file-parallelism` 真实失败：数据库没有 `job_discovery_leads`/`job_discovery_attributions`，且缺 `0024` migration。
- Green 1：由锁定的 `drizzle-kit 0.31.10` 正式生成 `0024_fat_jane_foster.sql`、`0024_snapshot.json` 与 journal entry；focused migration test 通过 `2/2`。
- Red 2：新增仓储集成测试后，公开模块 `./job-discovery-leads` 不存在，Vitest 真实报 `Cannot find module`。
- Green 2：实现深仓储 seam 后，focused repository test 通过 `6/6`。另补充“已 rejected Lead 在 expiry 后以相同 code 重试仍收敛”的 Red（实际得到 `JOB_DISCOVERY_LEAD_EXPIRED`），最小调整后 Green。

## 约束与隐私

- `job_discovery_leads` 以 DB check 强制 `pending|verified|rejected` outcome、`anysearch` provider、query kind、两类 SHA-256 指纹、URL 长度、稳定大写 rejection code 和 `expires_at = created_at + interval '30 days'`。
- Lead 使用 `(user_id, run_id, target_id)` 指向 Agent Run，并以 owner-bound Source Posting Version FK 绑定 verified version。
- Attribution 用短名复合 unique key/foreign key 绑定 Lead 的 owner/id/run/provider/query/version，并额外 owner-bound version FK；一个 Lead 只能有一个 Attribution。
- `recordPending` 严格解析 `unknown` 输入；credential URL、fragment、token/session/tracking query、`rawUrl/title/snippet/extract/content/credentials` 等 extra keys 全部拒绝。测试扫描 Lead、Attribution、audit、source-health 表，确认 sentinel secret 与 provider content 未持久化。
- 没有添加 expiry sweep，也没有触碰 source-health 运行语义或 v1-v3 adapter/Execution Spec。

## 事务、隔离与幂等

- `verifyAndAttribute` 在同一数据库 transaction 中更新 pending Lead 并插入 Attribution；版本、owner 或状态冲突会整笔回滚，无 Source Posting、Opportunity 或 AgentRunResult 创建。
- `recordPending` 和 Attribution insertion 均由数据库 unique conflict 收敛；相同 rejection code、相同 verified version 的重试返回既有事实。其他 owner 的读取返回空，写入稳定为 `JOB_DISCOVERY_LEAD_NOT_FOUND`，不泄露记录存在性。
- owner/version 跨界失败后，测试确认 Lead 仍为 pending、Attribution 为零。

## 验收命令

- `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/database test` → `2 files / 24 tests passed`。
- `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test` → `24 files / 279 tests passed`。
- `pnpm --filter @job-copilot/database typecheck` 与 `pnpm --filter @job-copilot/domain typecheck` → 均通过。
- 临时复制 migration metadata 后运行 `drizzle-kit generate` → `No schema changes, nothing to migrate`。
- `git diff --check` 通过；实现提交前 working tree 仅含本 Slice 授权文件。

待独立 Reviewer 复审达到 `Critical/Important/Minor = 0/0/0` 后，才可进入 Slice 6。

## Fix round 1（reviewed HEAD `35bd611`）

修复提交：`803728c48706a2eaab47eda8b5a4c35edacafc36`（`fix(domain): harden lead persistence retries`）。

- 真实 Red：补充 repository tests 后，focused run 真实出现两类失败：同 identity、不同 `targetId/queryId/queryKind/queryFingerprint/normalizedUrl` 的调用被静默返回旧 Lead；缺失或 owner/run/target 不匹配的 run 直接抛出含 `23503`、constraint 名和参数的 `DrizzleQueryError`。
- Green：`recordPending` 在 unique identity 回读后比较全部不可变事实，只有完全相同 facts（`now` 不参与比较）才视为 retry；其它情况返回 `JOB_DISCOVERY_LEAD_IDENTITY_CONFLICT`。仅将已知 owner/run/target FK 映射为 `JOB_DISCOVERY_LEAD_RUN_NOT_FOUND`，将已知 Lead primary/owner-id unique 映射为 `JOB_DISCOVERY_LEAD_ID_CONFLICT`，其它未知数据库错误继续原样抛出。
- Migration focused 补强并通过：显式读取 `0024` SQL/snapshot/journal 链、锁定两张表与两个索引；raw SQL 覆盖无效 stable fingerprint、同 owner 跨 run/target、Attribution 跨 run/provider/query/version。`0023` SQL/snapshot 相对 Slice 5 基线无 diff，0023 → 0024 upgrade test 继续通过。
- Repository focused 补强并通过：成功路径经公开 `getAttribution` 返回同一 Attribution；其他 owner 返回 `null`。other-owner verify 断言为 `JOB_DISCOVERY_LEAD_NOT_FOUND` 且 Lead 保持 pending、Attribution 为零。
- Fresh verification：migration focused `2/2`、repository focused `8/8`、database full `24/24`、domain full `281/281`，两个 typecheck 通过，临时 Drizzle generate 显示无 migration，`git diff --check` 通过。
