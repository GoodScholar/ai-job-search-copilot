# Task 7 / Slice 6 报告：已验证公开岗位来源持久化门禁

固定最终审查基线：`3a1a3940773921a1a03c3b25ea7baa378c025e83`。
开始 HEAD：`b56c3f17eb4240608ef9e82657413485b1b68252`。
初始实现提交：`04e8cfc6c419d95a0ff5f0a1b6aeb84d5f147abe`（`feat(domain): gate verified public job sources`）。

## 范围

- 新增唯一 public seam `createVerifiedJobSourceGate`：严格接收 pending Lead、candidate proof、最小 extract URL 证据、本地 `VerifiedJobPage` 和 `now`；不接收 provider title/snippet/content/credentials/rawUrl 等字段。
- 仅本地页面的 requested/final/canonical URL、raw HTML、visible text 与 `sourceKind` 可以建立 Source Posting/Version。extract 仅证明调用成功，绝不进入来源身份、raw/normalized data 或对象存储。
- 新增版本化 taxonomy `public-job-source-taxonomy-v1`，只输出 `company_careers | recruitment_platform | wechat_recruitment_h5 | public_web`。BOSS/猎聘/智联、微信 H5 和共享 verifier 已声明的 ATS host 均为固定 policy，`isOfficial` 只来自本地 page 的 `sourceKind`。
- 深化 Slice 5 repository：`verifyAndAttributeInTransaction` 复用同一状态转换逻辑，使 canonical dedup、version append、Lead verified 与 Attribution insert 处在一次 account advisory lock + DB transaction 内；没有提交后补 Attribution，也没有创建 Opportunity 或 AgentRunResult。
- raw HTML/visible text 用 owner + 新 sourceVersionId generation + content hash 的键分别写入；仅 store 明确返回 `created` 的对象可在 DB/Attribution 失败后补偿删除。
- 仅列出的 verifier terminal code 通过 `reject` 写 rejected Lead；timeout/cancelled/unreachable/rate-limited 返回稳定 `VERIFIED_JOB_SOURCE_RETRYABLE_FAILURE`，Lead 保持 pending。

## TDD 证据

1. **Red 1（公共成功门禁）**：先新增 `verified-job-source-gate.integration.test.ts`，执行
   `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain exec vitest run src/verified-job-source-gate.integration.test.ts --no-file-parallelism`。
   真实失败为 `Cannot find module './verified-job-source-gate'`，套件为 0 tests；原因是公开模块尚不存在。
2. **Green 1**：最小实现 strict gate、taxonomy、双 hash 对象/version 与 transaction-bound Lead seam 后，同一命令为 **1/1**。
3. **Red 2（terminal seam）**：暂未实现 `reject` 公共入口时，带 terminal/retryable 表驱动测试的 focused run 为 **3 tests，1 failed**，真实错误为 `TypeError: gate.reject is not a function`。
4. **Green 2**：恢复仅所需 terminal/retryable policy 后为 **3/3**。
5. **Red 3（DB 失败分类和补偿）**：用已存在 Attribution ID 强制新 Lead 在对象写入后发生 Attribution 主键冲突。focused run 为 **4 tests，1 failed**，实际得到错误的 `VERIFIED_JOB_SOURCE_STORAGE_FAILED`，而期望为 `VERIFIED_JOB_SOURCE_PERSIST_FAILED`。
6. **Green 3**：区分 store 和未知 DB/persistence failure，成功只补偿本次 `created` 对象后为 **4/4**。
7. **Red 4（ATS taxonomy）**：general query 的 `job-boards.greenhouse.io` 本地 official page 在固定名单缺失时被误分为 `public_web`。focused run 为 **8 tests，1 failed**。
8. **Green 4**：使 ATS hostname 固定 policy 与共享 verifier 的已有 official host 对齐后，最终 focused gate 为 **8/8**。

## 验收证据

均串行运行 Testcontainers，运行前检查没有活跃 Vitest/Testcontainers 进程：

- Gate focused：**1 file / 8 tests passed**。
- Slice 5 Lead focused regression：**1 file / 8 tests passed**。
- `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test`：**25 files / 289 tests passed**。
- `pnpm --filter @job-copilot/source-access test`：**2 files / 125 tests passed**。
- `DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/database test`：**2 files / 24 tests passed**。
- `@job-copilot/domain`、`@job-copilot/source-access`、`@job-copilot/database` typecheck：均退出 0。
- `git diff --check` 与 fixed-base diff check：通过。

首次 domain full 在 `career-imports.integration` 的 Testcontainer host-port wait（10 秒）发生环境启动期超时，已有 **24 files / 248 tests passed，41 skipped**；没有修改任何产品代码或清理活跃资源。随后检查确认异常容器已由 Testcontainers 自动回收、无测试进程；在资源空闲条件下的一次受控复验得到上面的 **25/289** fresh Green。

## 关键不变量自审

- **隐私/来源**：AnySearch 在持久层只作为 Attribution `provider`；成功 gate 的 source identifier、source id、identity、hash、objects 均由本地 page 派生。strict negative cases 验证 provider content/title 被拒绝且 Lead 仍 pending、来源/version/Attribution/object puts 均为零。
- **URL/candidate**：重算 SHA-256 fingerprint；比对 Lead 的 queryId/normalized URL/fingerprint；extract 和 requested URL 必须等于 candidate，final 与 requested、canonical 与 final 必须同 origin，三者均通过 Safe public HTTPS URL schema。
- **原子性**：account lock 与单一 transaction 覆盖 posting/version/Lead/Attribution。第一或第二个对象 put 失败不会提交 DB；Attribution 冲突会回滚 DB、删除本次新对象而保留预先存在对象。
- **dedup/replay**：同 owner + canonical + 双 hash 复用一个 version，两个 Lead 各得到独立 Attribution；任一真实 hash 变化追加 version；同 Lead replay 不再 put、不新增 version 或 Attribution。
- **范围**：未改 source-health、v1–v3 adapter/Execution Spec/recovery/runtime/UI；未创建 Opportunity、AgentRunResult 或 workflow/budget/diagnostic 行为。

下一步需要独立 `gpt-5.6-sol/high` 按 Standards 与 Spec 双轴审查至 `0/0/0`，再开始 Slice 7。

## Fix round 1：唯一门禁、来源身份与对象代际

修复提交：`7ec543e8e895923052ac06f1c27fd2c90564b14d`。

- public API enumeration 先真实 Red：consumer-visible repository 仍含 `reject`、`verifyAndAttribute`、`verifyAndAttributeInTransaction`；随后 public repository 收束为 `recordPending/getLead/getAttribution`，终态转换移到包未导出的强类型 sibling。gate 是唯一 public verified/terminal seam。
- posting 先计算 taxonomy/local identity，再以 owner + sourceType + canonical hash 查询；版本查询绑定 posting ID 与双 hash。复用时核对 local sourceId、identity、official flag 与代际 object reference；`url_import` 不会被 taxonomy posting 复用。
- object keys 改为 owner + 新 sourceVersionId generation + content hash。same-version replay 在 put 前返回；失败代际与后续事务不会共享 object key，故补偿不会断开其他已提交 version。
- only `VerifiedJobEvidenceStoreUnavailableError` 映射 storage failure；未知 store/DB/id/programming error 保持原对象。已知 Attribution primary-key constraint 映射为稳定 Lead attribution conflict。
- ATS host policy 改由 contracts 的版本化 exact-host predicate 统一供 source-access verifier 和 gate taxonomy 使用；平台/微信保留批准的子域匹配。

Fresh verification：public API focused **1/1**；internal Lead + gate focused 合计 **16/16**，后续 gate focused **8/8**；source-access **125/125**；database **24/24**；domain full **26 files / 290 tests**；contracts/domain/source-access/database typecheck 均通过。`git diff --check b56c3f17eb4240608ef9e82657413485b1b68252` fresh exit 0。

## Fix round 1 补测：失败边界与完整矩阵

补测提交：`249c5df`（`test(domain): cover verified gate failure boundaries`）。首次 round 1 已关闭实现层的唯一门禁、taxonomy/provenance 与 generation-key race，但报告也如实保留了验收矩阵未完全展开的缺口；本提交只增加该缺口的回归，不扩展 Slice 7 行为或产品代码。

- 不使用 sleep 的 barrier 并发回归：T1 在 Attribution 主键冲突后已经回滚并进入 outer cleanup；cleanup 首次 delete 被 barrier 暂停时，T2 取得同账户锁、提交同 canonical/content 的独立 generation。随后放开 T1，断言其只删除自己的两把 key，T2 raw/visible bytes、双 SHA-256 与 Version reference 完整保留。
- 精确预置本次可预测 generation raw/visible key，两个 put 均为 `created=false` 后强制 Attribution 冲突，断言没有 delete；delete 自身失败时仍抛原始 `JOB_DISCOVERY_LEAD_ATTRIBUTION_CONFLICT`、不提交 Posting/Version/Attribution，遗留对象没有 DB 引用。
- owner、expiresAt 精确边界、rejected、verified 的 final URL/sourceKind/本地内容/candidate facts 冲突均保持稳定结果；相同 verified replay 仍在原 dedup 回归中断言零 put。每个 terminal/retryable code 逐项断言 Posting、Version、Attribution、Opportunity、AgentRunResult 与 object puts 为零。
- provider title/snippet/extract/content/rawUrl sentinel 经 strict public input 拒绝后，扫描 Lead、Attribution、Posting、Version、source-health、audit 及对象 bytes 均不含 sentinel；本地 raw/visible 独立 sentinel 成功后精确读取对象，并核验 bytes、hash 和 reference。
- taxonomy 现在表驱动覆盖 zhipin/liepin/zhaopin 及批准子域、微信 exact/批准子域、六个 ATS exact host、evil ATS subdomain、unknown target-company、general、site-constrained；另回归预置 `url_import` 同 canonical 不会被复用。

本轮 focused public/internal/gate：**3 files / 21 tests passed**；gate 专项：**1 file / 12 tests passed**；domain full：**26 files / 294 tests passed**；source-access：**2 files / 125 tests passed**；database：**2 files / 24 tests passed**；contracts/domain/source-access/database typecheck 均退出 0。最后在报告更新前后均执行 `git diff --check b56c3f17eb4240608ef9e82657413485b1b68252..HEAD`，fresh exit 0。

## Fix round 2：Version 污染拒绝与可恢复对象补偿

实现提交：`6db2d8f`（`fix(domain): recover verified evidence cleanup`）。

1. **Red（poisoned Version）**：先预置同 owner/taxonomy/canonical/双 hash/正确 generation reference、但 `normalizedData` 含 AnySearch provider/snippet sentinel 的 Version。gate 错误地成功归因；随后将 `normalizedData` 加入 existing Version select，并精确要求 gate 唯一合法值 `{}`，Green 后返回稳定 Lead conflict、零 put、零 Attribution。
2. **Red（delete failure）**：已知对象 store 删除失败时，gate 原样抛 Attribution conflict 并遗留 orphan。改为 versioned deterministic UUIDv8 generation（owner、lead、taxonomy、canonical、双 hash），并在新的 transaction 中重取 account lock、读取全部 Version references，只删除本次 created 且未被引用的对象。已知 cleanup store failure 返回 `VERIFIED_JOB_SOURCE_CLEANUP_REQUIRED`；相同输入重试得到同一 UUIDv8/key，`created=false` 对象被正式 Version 引用而不再 orphan。未知 cleanup/put/id 错误仍保留 exact object identity。
3. generation 回归断言 UUID version nibble 为 `8`、RFC variant 为 `[89ab]`、同输入 retry 稳定、不同 Lead generation 不同；无 sleep barrier 覆盖 cleanup re-lock 后 T2 才能提交，且 T1 不删除 T2 reference。
4. 清理 round 1 产生的无用 import/hostname normalization；将 public repository 和 internal transitions 的 input parser、Lead/Attribution fact projection 收敛为未导出的 package-internal helper，公开 surface 不变。

Fresh verification：public/internal/gate focused **3 files / 23 tests**；gate **1 file / 14 tests**；domain full **26 files / 296 tests**；contracts **12 files / 108 tests**；source-access **2 files / 125 tests**；database **2 files / 24 tests**；contracts/domain/source-access/database typecheck 均退出 0。最后 `git diff --check b56c3f17eb4240608ef9e82657413485b1b68252..HEAD` fresh exit 0。
