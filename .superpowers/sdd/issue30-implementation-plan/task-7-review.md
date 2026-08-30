# Task 7 / Slice 6 独立审查

当前结论：`CHANGES_REQUESTED`，不得进入 Slice 7。

- focused base：`b56c3f17eb4240608ef9e82657413485b1b68252`
- 初审 HEAD：`707d530cf0a9f9636cfbe4a0d97039a7702f97aa`
- Fix round 1 reviewed HEAD：`050372f8252509a3a6669b67b89dd57535c31596`
- Fix round 2 reviewed HEAD：`acbb3031b7c309b476a5fc0736b6d8801a9ec95a`
- 初始实现 SHA：`04e8cfc6c419d95a0ff5f0a1b6aeb84d5f147abe`
- 核心修复 SHA：`7ec543e8e895923052ac06f1c27fd2c90564b14d`
- 补测 SHA：`249c5df`
- Fix round 2 核心修复 SHA：`6db2d8f80bfee96caa1a7821004f74712d0c817f`
- Fix round 2 error-identity 补测 SHA：`1a239c27924b84314357762bc2303de0f33759b1`
- 固定最终审查基线仍为：`3a1a3940773921a1a03c3b25ea7baa378c025e83`

以下 Standards/Spec 为 HEAD `707d530` 的初审记录；历次复审与当前裁定见文末。

## 初审 Standards

Critical / Important / Minor：`0 / 3 / 1`。

### Important

1. `.superpowers/sdd/issue30-implementation-plan/task-7-report.md:3-4,39` 的最终提交包含行尾空格，却声称 `git diff --check` 与 fixed-base diff check 通过。Fresh `git diff --check b56c3f1..707d530` 实际退出 `2`；实现 diff `b56c3f1..04e8cfc` 单独退出 `0`，报告提交 `04e8cfc..707d530` 单独退出 `2`。这违反 `task-7-brief.md:76,78` 的最终 diff 与真实验收证据门禁。删除行尾空格，对最终 reviewed diff fresh 重跑，并按真实结果修正报告。

2. `packages/domain/src/job-discovery-leads.ts:192-195,211` 把 brief `:34` 指定的 internal transaction seam 暴露在公开 repository 返回类型中，且 transaction 参数为 `any`；结合 `packages/domain/package.json:23` 的公开 export，外部消费者可传普通 root `db`、任意或嵌套 transaction，破坏单事务原子性和 ADR 0009 的深模块边界。应把 transaction-bound helper 移入未公开 internal 模块，使用明确 transaction 类型，公开接口不能暴露该能力。

3. `packages/domain/src/verified-job-source-gate.integration.test.ts:145-255` 没有落实 `task-7-brief.md:65-67` 的完整验收矩阵：缺 other-owner、expired、rejected/verified-conflicting replay；terminal case 未断言 Version/Opportunity/Result/object 零写入；`:203,212` 所谓“既有对象保护”只是无关 key，没有覆盖目标 deterministic key 的 `put.created=false`；也没有 source-health/audit privacy scan，或对象 bytes/hash/reference 对齐断言。因此 focused `8/8` 不能支撑报告 `:45-48` 声称的全部不变量。补齐公共 seam 的表驱动负例与全表/对象扫描。

### Minor

1. Baseline smell（judgement call：Duplicated Code / Shotgun Surgery）：ATS host policy 同时硬编码于 `packages/source-access/src/job-page-fetcher.ts:224-227` 与 `packages/domain/src/verified-job-source-gate.ts:84-90`；报告 `:26-27` 已记录过一次真实漂移。应提取单一、版本化的 host policy，由 verifier 与 taxonomy 共同使用。

Scope creep：`0`。未发现 source-health、v1-v3 workflow/adapter/recovery 或 UI 的越界修改。

## 初审 Spec

Critical / Important / Minor：`3 / 1 / 2`。

### Critical

1. **公开 Lead repository 可绕过唯一验证门禁。** `task-7-brief.md:6,12-22,34` 要求 candidate → extract → locally fetched page 是 Lead 到 Source Posting Version + Attribution 的唯一成功入口；但 `packages/domain/package.json:23` 继续公开 `job-discovery-leads`，其 `verifyAndAttribute` 只接收 owner/lead/version/now（`job-discovery-leads.ts:187-190,211-243`），可把任意 pending Lead 绑定到任意同 owner 的既有 Version，完全不需要 candidate、extract、URL/page 或本地内容证明。`verifyAndAttributeInTransaction(input, transaction:any)`（`:192-196`）还可通过 root DB 绕过原子事务。公开 `reject`（`:167-185`）接受任意大写稳定 code，也可绕过 gate terminal allowlist，把 timeout/cancelled/unreachable/rate-limited 终态化。应把状态转换/归因 helper 内部化并强类型化；公开 repository 只保留不会绕过 gate 的 record/query 能力，或令 mutator 强制消费不可伪造的 gate-bound capability；增加公开 API 枚举与 bypass 负测。

2. **Posting/Version 复用未绑定 taxonomy 与完整本地来源身份。** Brief `:26-30,35,37` 要求按 owner + source taxonomy + canonical URL 复用并保持本地 page 身份；但 `verified-job-source-gate.ts:129-139` 的 existing Version 查询只按 owner + sourceIdentifier + 双 hash，`:143-148` 的 Posting 查询只按 owner + sourceIdentifier，均未限定计算后的 `sourceType`，也未核对 `sourceId/sourceIdentity/finalUrl/isOfficial/rawObjectReference`，两个无序查询甚至可能选到不同 Posting。数据库唯一键本来包含 `sourceType`（`packages/database/src/schema.ts:398-413`），而正常 URL import 会用同一个 `sha256(canonicalUrl)` 创建 `sourceType=url_import`（`job-imports.ts:276,319-340`），所以 gate 会自然复用 taxonomy v1 之外的 Posting/Version，或把新 Version 追加到它；同 Lead 用相同 canonical/双 hash、但不同 finalUrl/sourceKind replay 也会静默成功。应先计算 expected taxonomy 与完整 locally-derived identity，所有查询包含 sourceType/postingId，复用时逐字段核对，不同 taxonomy 建独立 Posting，不同 replay 稳定 conflict；补预置 url_import/旧 Posting+Version、不同 queryKind、final/sourceKind conflict 回归。

3. **对象补偿在 advisory lock 释放后执行，可误删另一事务已提交引用的对象。** `task-7-brief.md:36,66` 要求只删除本次新建且尚未被提交引用的对象。当前 gate 在 transaction 内获取 xact advisory lock 并 put（`verified-job-source-gate.ts:119-120,165-172`），但 transaction reject/rollback 释放锁后才在外层 catch delete（`:190-193`）。T1 回滚释放锁后，T2 可获得锁、看到 deterministic object 已存在（`created=false`）并提交 Version 引用，随后 T1 删除同 key，留下已提交但断链的 Version。现有测试 `:192-219` 只保护无关的 `already-referenced` key，未覆盖该竞态。补偿必须在重新获取 account lock 后查询引用并持锁条件删除，或使用 staging/finalize/代际条件删除协议；补 barrier concurrency、raw/visible 分别 existing、delete failure/orphan 回归。

### Important

1. `task-7-brief.md:38` 要求未知 DB/store 错误不被误分类。`verified-job-source-gate.ts:165-171,190-197` 将所有 store put throw 包装为 `VERIFIED_JOB_SOURCE_STORAGE_FAILED`，并把其余所有未知 transaction/DB/id/programming error 统一包装为 `VERIFIED_JOB_SOURCE_PERSIST_FAILED`；这会把未知 constraint、连接/驱动错误或实现错误伪装为预期领域失败，也与 Slice 5 已确认的“只映射已知约束、未知错误保持 identity”边界不一致。只映射明确可识别的预期错误；未知错误原样抛出，并补 error identity probe。

### Minor

1. `task-7-brief.md:29` 只明确允许招聘平台与微信规则匹配子域，ATS 是既有明确 official hosts；gate `:84-90` 对 ATS 也使用 `hostMatches`，因此 `evil.jobs.lever.co`、`evil.boards.greenhouse.io` 等会被扩为 `company_careers`，与 source-access verifier `job-page-fetcher.ts:224-227` 的 exact normalized ATS host policy 不一致。测试 `verified-job-source-gate.integration.test.ts:311-333` 只覆盖 zhipin 与一个 Greenhouse，未覆盖 liepin/zhaopin/wechat/public_web/target_company/general/site-constrained、合法子域及 near-miss。ATS 应复用 exact normalized official-host predicate，并表驱动锁定全部四类和边界。

2. `task-7-brief.md:56,65-67` 要求逐案证明 owner/expired/state 隔离、所有拒绝/成功无 Opportunity/Result、privacy 不进入 audit/source-health/object。当前只有 happy path（gate test `:110-143`）检查 Opportunity/Result；terminal 表（`:145-169`）只查 Posting/Attribution，且没有 other-owner、expired、rejected/verified-conflicting gate 用例或真正并发 verify。静态实现中部分路径看似无下游写入，但验收证据不完整；必须补公共 gate 回归后才能关闭该要求。

Scope creep：`0`。

## Fresh 验证

- focused gate：`1 file / 8 tests passed`
- Slice 5 Lead regression：`1 file / 8 tests passed`
- source-access regression：`2 files / 125 tests passed`
- `@job-copilot/domain` typecheck：退出 `0`
- `@job-copilot/source-access` typecheck：退出 `0`
- `@job-copilot/database` typecheck：退出 `0`
- `git diff --check b56c3f1..707d530`：退出 `2`，失败点为 `task-7-report.md:3-4` trailing whitespace
- 审查前与验证后工作树均干净；未运行 root full，未提交、push、创建 PR 或 merge

两轴汇总：Standards `0/3/1`（最严重：internal transaction seam 公开泄漏，且最终报告的 diff-check 证据失真）；Spec `3/1/2`（最严重：唯一 gate 可绕过、taxonomy/provenance 可误复用、补偿竞态可误删已提交对象）。结论：`CHANGES_REQUESTED`。

## Fix round 1 复审（HEAD `050372f`）

结论仍为 `CHANGES_REQUESTED`。当前两轴为：

- Standards Critical / Important / Minor：`0 / 0 / 2`
- Spec Critical / Important / Minor：`0 / 2 / 1`
- Scope creep：`0`

### 已关闭的初审问题

1. **公开 bypass 与 transaction seam：CLOSED。** `packages/domain/src/job-discovery-leads.ts:119-171` 的公开 repository 只保留 `recordPending/getLead/getAttribution`；`packages/domain/package.json` 未导出 `job-discovery-lead-transitions`，package subpath probe 得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，consumer API 枚举测试也锁定不存在 reject/verify/transaction injection。internal transition 使用从 `Database["transaction"]` 推导的 transaction 类型，gate 在同一个 account transaction 中调用它；未发现 nested/root transaction 泄漏。
2. **taxonomy/provenance/version 误复用：主体 CLOSED。** Posting 查询已绑定 owner + expected sourceType + canonical identifier，并核对 local `sourceId/sourceIdentity/isOfficial`；Version 查询绑定 Posting ID + 双 hash，并核对 generation object reference。`url_import`、不同 final/sourceKind/content/candidate replay 均有回归。仍有 `normalizedData` 缺陷，见 Spec Important 1。
3. **补偿误删已提交对象的竞态：CLOSED。** owner + 新 sourceVersionId generation + hash 使失败尝试与后续成功尝试不共享 key；barrier 测试证明 T1 cleanup 不会删除 T2 已提交 Version 的 raw/visible 对象。`created=false` 也不会删除既有目标 key。delete 自身失败仍有 orphan，见 Spec Important 2。
4. **未知错误误分类：实现 CLOSED。** 只有显式 `VerifiedJobEvidenceStoreUnavailableError` 映射为稳定 storage code，已知 Attribution constraint 单独映射；未知 store/DB/id/programming error 原样抛。fresh DB sentinel probe 证明 exact error object identity 保留。缺少提交内回归，见 Spec Minor 1。
5. **ATS/taxonomy 与验收矩阵：CLOSED。** ATS exact-host policy 已由 contracts 单点提供给 source-access 与 gate；平台/微信子域、六个 ATS exact host、evil ATS、target/general/site 分类均有表驱动覆盖。terminal/retryable、owner/expiry/state/replay、全表与对象 privacy、bytes/hash/reference、Opportunity/Result 零写入均已补测。
6. **报告与 diff-check 真实性：CLOSED。** 原 trailing whitespace 已删除；fresh `git diff --check b56c3f1..050372f` 退出 `0`，当前报告的 focused 计数与实际运行一致。

### Standards Minor

1. **Fix 引入后留下无用/冗余代码。** `packages/domain/src/job-discovery-leads.ts:1,12` 的 `gt` import 和 `rejectionCode` 已无引用；`packages/source-access/src/job-page-fetcher.ts:225-228` 在共享 predicate 自己已做 lowercase/`www.` normalization 后仍保留 `normalizedHostname`；`packages/domain/src/verified-job-source-gate.ts:217-218` 的类型分支两边都只是 `throw error`。这违反根 `AGENTS.md` §4 对本次改动产生孤立代码的清理要求。
2. **internal sibling 复制事实投影/解析逻辑。** `packages/domain/src/job-discovery-leads.ts:44-47,82-110` 与 `packages/domain/src/job-discovery-lead-transitions.ts:12-31` 各自实现 `parseOrThrow`、`leadFact`、`attributionFact`。虽然状态转换本身仍复用而未复制，但同一事实投影已有两份，后续 schema 变化存在漂移风险；应收敛到未公开 internal helper。

### Spec Important

1. **既有 Version 的 `normalizedData` 没有进入复用相容性校验，provider 数据仍可混入真实来源版本。** `packages/domain/src/verified-job-source-gate.ts:161-173` 查询并核对 Posting ID、双 hash、`rawObjectReference`，却不读取或验证 `job_source_posting_versions.normalized_data`；只有新建路径 `:199-202` 写入 gate-local `{}`。因此，只要预置同 taxonomy/local identity、正确双 hash与 generation refs，但 `normalizedData` 为 `{provider:"anysearch",snippet:"sentinel"}` 的 Version，gate 就会复用它并建立 Lead Attribution，违反 brief `:22,26-30,35,37` 的“normalized data 只来自本地 page、AnySearch 永不进入真实 Source Version”不变量。应把 `normalizedData` 纳入 select 与 exact gate-local schema 相容性检查，不兼容时返回稳定 conflict；补同-taxonomy poisoned Version（含 extra-key provider sentinel）回归并纳入 privacy scan。
2. **delete 补偿失败仍永久留下无 DB 引用的私有页面对象。** `packages/domain/src/verified-job-source-gate.ts:213-216` 吞掉所有 delete 错误且没有 durable cleanup marker、重试或可证明的回收协议。对应测试 `packages/domain/src/verified-job-source-gate.integration.test.ts:256-279` 明确断言 transaction 回滚后 `store.objects.size === 2`、Version 为空；报告 `task-7-report.md:70` 也如实记录“遗留对象没有 DB 引用”。generation key 修复了误删已引用对象，却没有满足本轮明确要求的“DB/Attribution 失败补偿不得留下 orphan”。应在保持原始业务错误为 authoritative 的同时，为 delete failure 提供可验证的 durable cleanup/retry 语义，并测试最终无 orphan；不能仅用“没有 DB 引用”作为通过条件。

### Spec Minor

1. **未知错误 identity 缺少提交内回归。** 当前实现看似正确，fresh DB sentinel probe 也得到 exact object identity；但 focused suite 没有 unknown first/second put、DB/id error 的 `rejects.toBe(error)`。至少补 raw put、second put（同时证明首对象补偿）和 transaction/DB/id sentinel，锁定不得误分类这一 brief `:38` 边界。

### Fresh 验证

- 运行前检查：无其他 Vitest/Testcontainers 进程或活跃测试容器。
- public/internal/gate focused：`3 files / 21 tests passed`。
- source-access regression：`2 files / 125 tests passed`。
- contracts regression：`12 files / 108 tests passed`。
- `@job-copilot/contracts`、`@job-copilot/domain`、`@job-copilot/source-access`、`@job-copilot/database` typecheck：均退出 `0`。
- package subpath probe：`@job-copilot/domain/job-discovery-lead-transitions` 返回 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- unknown DB error identity probe：原 sentinel 对象被原样抛出。
- `git diff --check b56c3f1..050372f` 与 `git diff --check 707d530..050372f`：均退出 `0`。
- 未运行 root full；未修改产品代码，未提交、push、创建 PR 或 merge。

最终两轴不为 `0/0/0`，因此 **NOT APPROVED**。

## Fix round 2 复审（HEAD `acbb303`）

结论仍为 `CHANGES_REQUESTED`。当前两轴为：

- Standards Critical / Important / Minor：`0 / 0 / 1`
- Spec Critical / Important / Minor：`0 / 1 / 0`
- Scope creep：`0`

### Fix round 1 剩余项逐项裁定

1. **existing Version `normalizedData` 污染：CLOSED。** `packages/domain/src/verified-job-source-gate.ts:192-206` 已读取 `normalizedData` 并要求它与 gate 唯一合法值 `{}` 精确相等；含 provider/snippet extra key、但其余 taxonomy/canonical/hash/reference 均正确的 Version 会返回稳定 `VERIFIED_JOB_SOURCE_LEAD_CONFLICT`。`packages/domain/src/verified-job-source-gate.integration.test.ts:304-333` 证明零 put、零 Attribution。
2. **delete failure / orphan recovery：PARTIAL，见 Spec Important 1。** `verified-job-source-gate.ts:128-146` 确实在新 transaction 中重新取得 account advisory lock，扫描 owner 的 Version references，并只删除本次 `created` 且未被引用的对象；`:108-116,213-216` 产生 version/variant 合法、对同一 owner+Lead+taxonomy+canonical+双 hash 稳定的 UUIDv8。测试 `:270-302` 证明无其他同内容 Version 介入时，同输入重试会引用原 keys；`:384-439` 证明 cleanup 持锁时另一 Lead 不能越过并导致误删。但是另一 Lead 在 cleanup failure 与重试之间先提交时，恢复仍失效。
3. **未知错误 identity：CLOSED。** `verified-job-source-gate.ts:220-231,143-146` 只映射明确 typed unavailable，未知 put/delete/DB/id error 原样抛；`verified-job-source-gate.integration.test.ts:335-382` 对 first/second put、delete、transaction DB 与 id sentinel 使用 exact `toBe`，focused Green。
4. **unused/redundant code：PARTIAL，见 Standards Minor 1。** `job-discovery-leads.ts` 的 `gt/rejectionCode` 和 source-access 的重复 hostname normalization 已删除，gate 的冗余双分支也已收敛；但分支删除后留下一个 unused import。
5. **internal mapper/parser duplication：CLOSED。** 新增未公开 `packages/domain/src/job-discovery-lead-internal.ts`，public repository 与 internal transitions 共用 `parseLeadInput/leadFact/attributionFact/JobDiscoveryLeadError`；package exports 未加入该 helper 或 transitions。

### Standards Minor

1. **仍有本次改动产生的孤立 import。** `packages/domain/src/verified-job-source-gate.ts:19` 导入 `JobDiscoveryLeadError`，当前文件没有任何使用点。它是 round 2 删除冗余 catch 类型分支后遗留的代码，未满足根 `AGENTS.md` §4“删除因本次改动而变得无用的 import”要求。

### Spec Important

1. **跨 Lead dedup 可使 cleanup-required 的同输入重试无法正式引用或删除原 keys。** 当前 UUIDv8 generation 包含 `leadId`（`verified-job-source-gate.ts:108-116,213-216`），而重试会先按 Posting + 双 hash 查找任意 existing Version（`:192-203`）；只有不存在 Version 时才计算本 Lead generation 并 put（`:211-231`）。因此存在确定性交错：Lead A 写入 A keys，DB/Attribution 失败且 cleanup delete unavailable，留下 A keys；同 owner 的 Lead B 随后以同 canonical/content 成功，因 Lead 不同写入并引用 B keys；A 再以完全相同输入重试时直接复用 B Version，`createdObjectKeys` 为空，A keys 既不会被引用，也不会进入 `cleanupCreatedObjects`，永久 orphan。当前恢复测试 `verified-job-source-gate.integration.test.ts:270-302` 在 A 的两次调用之间没有插入 B，barrier 测试 `:384-439` 也只覆盖 cleanup 成功路径，不能证明报告 `task-7-report.md:81-82` 所称的正式引用保证。应增加 A cleanup failure → B same canonical/content commit → A same-input retry 的回归，并使 A 原 keys 最终被某 Version 引用或安全删除；同时保持 account lock、reference check 与不同 Lead generation 边界。

### 原 Critical 与范围非回归

- public `job-discovery-leads` 仍只暴露 Error + repository，repository 仍只有 `recordPending/getLead/getAttribution`；focused public API test Green，package probe 对 `@job-copilot/domain/job-discovery-lead-transitions` 返回 `ERR_PACKAGE_PATH_NOT_EXPORTED`。public terminal seam 仍只能经 verified gate 的 allowlist `reject`，未发现 capability/transaction bypass 回归。
- Posting 仍绑定 owner + taxonomy + canonical identity，Version 仍绑定 Posting + 双 hash + local references + exact `{}`；`url_import`、source identity、state/owner/replay、ATS exact policy 和完整 taxonomy 回归均保持 Green。
- cumulative diff 未修改 Opportunity、AgentRunResult、source-health、v1-v3 workflow/adapter/recovery；gate 成功/失败矩阵仍断言不创建 Opportunity/Result，privacy scan 仍覆盖 source-health/audit/object。
- 未发现与 Slice 6 无关的 scope creep。

### Fresh 验证

- 运行前检查：无其他 Vitest/Testcontainers 进程或活跃测试容器。
- public/internal/gate focused：`3 files / 23 tests passed`。
- source-access regression：`2 files / 125 tests passed`。
- contracts regression：`12 files / 108 tests passed`。
- `@job-copilot/contracts`、`@job-copilot/domain`、`@job-copilot/source-access`、`@job-copilot/database` typecheck：均退出 `0`。
- internal transition package subpath probe：`ERR_PACKAGE_PATH_NOT_EXPORTED`。
- `git diff --check b56c3f1..acbb303` 与 `git diff --check 050372f..acbb303`：均退出 `0`；报告无 trailing whitespace，计数与本轮 focused 结果一致。
- 审查前实现 worktree clean；未运行 root full，未修改产品实现，未 push、创建 PR 或 merge。

最终两轴仍不为 `0/0/0`，因此 Slice 6 **NOT APPROVED**。
