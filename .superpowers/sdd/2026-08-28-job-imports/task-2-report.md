# Task 2 报告：岗位导入规范化、去重与审计

## 状态

已完成并验证。

## 提交

`feat: normalize and deduplicate job imports (#7)`

## 改动摘要

- 新增岗位导入 domain seam：NFKC、换行、行尾空白和外层空行规范化；以 UTF-8 字节严格限制 524,288；按账户锁实现幂等提交与对象存储回滚。
- 队列只接收 `{ version, importId, userId }`，队列和对象存储失败均转换为稳定码；正文不进入审计或错误信息。
- 新增严格 normalizer 输出校验、来源身份/来源版本与岗位机会的确定性去重；来源版本仅插入、不更新。
- 新增账户范围列表、详情及原始正文查询；所有数据库查询均携带 `userId` 条件。
- 为三个岗位生命周期事件增加严格审计白名单，仅允许标识、版本、输入类型、尝试次数和失败码。

## 红绿证据

- RED 1：`pnpm --filter @job-copilot/domain test -- src/job-imports.test.ts src/job-imports.integration.test.ts` 以 `Cannot find module './job-imports'` 失败，确认公开 seam 尚不存在。
- GREEN 1：相同命令在提交切片实现后通过。
- RED 2：`pnpm --filter @job-copilot/domain test -- src/audit-trail.integration.test.ts` 以“审计事件不符合字段白名单”失败，确认岗位事件尚未允许。
- GREEN 2：审计 allowlist 实现后通过。
- RED 3：岗位处理器测试以 `createJobImportProcessor is not a function` 失败，确认处理 seam 尚未实现。
- GREEN 3：处理、查询、去重与脱敏实现后通过。
- RED 4：队列失败测试先收到原始 `queue unavailable`，对象存储失败测试先收到原始错误正文；随后分别收敛为 `JOB_IMPORT_QUEUE_UNAVAILABLE` 和 `JOB_IMPORT_OBJECT_STORAGE_FAILED`。

## 命令结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @job-copilot/domain test -- src/job-imports.test.ts src/job-imports.integration.test.ts src/audit-trail.integration.test.ts` | 通过：12 个测试文件，96 个测试。 |
| `pnpm --filter @job-copilot/domain typecheck` | 通过：`tsc --noEmit` 退出码 0。 |
| `git diff --check` | 通过：无空白错误。 |

## 自审

- 需求对应：提交幂等性、UTF-8 限制、账户锁、不可变来源版本、机会去重、账户范围查询及三个脱敏审计事件均已有直接行为测试。
- 保密边界：正文仅在 `JobContentStore` 与 `JobPostingNormalizer` 的调用参数、受控查询返回和数据库 `description`/对象引用中出现；队列、审计 metadata 和错误码均不携带正文。
- 修改范围：仅更改 Task 2 列出的 domain 文件、其新增测试文件及本报告。

## 顾虑

无已知功能阻塞。手动输入的来源身份按已裁定使用 `user_import + canonical content fingerprint`；因此不同正文天然形成不同来源身份，来源版本表仍保持“仅追加、绝不更新”的实现约束。

---

## Fix round 1/5

### 修复与覆盖

1. 队列瞬时失败后的相同正文会原子恢复为可入队状态；成功入队持久化为 `normalizing`，因此并发失败不再覆盖另一请求的成功入队。
   - `job-imports.integration.test.ts`：`允许瞬时队列失败的相同正文重试并由 worker 完成`、`不会让并发重复提交中的队列失败覆盖另一次成功入队`。
2. 复用既有机会时保留机会 ID，同时把机会关联切换到当前导入及当前来源版本，`queries.get(second)` 因而返回复用机会和第二份证据。
   - `job-imports.integration.test.ts`：`用标准化字段的确定性键复用岗位机会`。
3. `finalAttempt` 现在区分可重试与终态：对象读取及 normalizer 运行时异常在非最终尝试维持 `normalizing`；最终 normalizer 异常使用 `JOB_IMPORT_PERSIST_FAILED`，不会冒充 `JOB_NORMALIZER_OUTPUT_INVALID`。
   - `job-imports.integration.test.ts`：`仅在最终尝试终态化读取故障，并允许后续 worker 重试`、`normalizer 异常在非最终尝试可重试，最终尝试不冒充输出无效`。
4. `JobContentStore` 增加最小 `delete` 补偿接口；对象已成功写入但审计/事务失败时删除对象，保留原始事务错误。
   - `job-imports.integration.test.ts`：`在审计导致事务失败时删除已经写入的岗位正文`。

### 命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @job-copilot/domain exec vitest run src/job-imports.test.ts src/job-imports.integration.test.ts src/audit-trail.integration.test.ts` | 通过：3 个文件、20 个测试。 |
| `pnpm --filter @job-copilot/domain typecheck` | 通过：`tsc --noEmit` 退出码 0。 |
| `git diff --check` | 通过：无空白错误。 |
| `pnpm --filter @job-copilot/domain test -- src/job-imports.test.ts src/job-imports.integration.test.ts src/audit-trail.integration.test.ts` | 受环境影响未通过：Vitest 将参数扩展为全套文件，两个无关 Testcontainers 套件端口等待超时；本任务 3 个文件的直接过滤命令如上通过。 |

### 提交

本轮修复提交：`fix: make job import retries and evidence consistent (#7)`；提交 SHA 见本轮最终回复。

---

## Fix round 2/5

### 修复与覆盖

1. 在 `0012` schema、SQL、snapshot 与迁移断言中新增账户所有的 `job_opportunity_sources`；其唯一约束为 `(opportunity_id, source_posting_version_id)`，并含机会和来源版本的复合 owner FKs。
   - `migrate.integration.test.ts`：`migrates versioned account-owned job imports`。
2. 每次处理完成都插入或复用机会—来源版本关联；查询由当前 import 的内容指纹定位来源身份/版本后经关联取得机会。因此两个已完成导入都保留各自证据，同时共享机会 ID，不再移动 `job_opportunities` 的首来源字段。
   - `job-imports.integration.test.ts`：`用标准化字段的确定性键复用岗位机会`。
3. 非最终对象读取及 normalizer 运行时异常抛出可导出的 `JobImportRetryableError`；最终尝试才记录失败，且 normalizer 异常仍使用运行时失败码而不是输出无效码。
   - `job-imports.integration.test.ts`：`仅在最终尝试终态化读取故障，并允许后续 worker 重试`、`normalizer 异常在非最终尝试可重试，最终尝试不冒充输出无效`。
4. 将账户锁中的幂等决定和状态转换前置到 enqueue 之前；enqueue 之后不再写状态。队列异常只返回可重试错误，不能覆盖其他 worker 的终态。
   - `job-imports.integration.test.ts`：`在队列不可用时保留已锁定的可重试导入`、`不会让并发重复提交中的队列失败覆盖另一次成功入队`、`不会在 enqueue 内 worker 已终态失败后回写 normalizing`。

### 命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @job-copilot/database exec vitest run src/migrate.integration.test.ts` | 通过：1 个文件、11 个测试。 |
| `pnpm --filter @job-copilot/domain exec vitest run src/job-imports.test.ts src/job-imports.integration.test.ts src/audit-trail.integration.test.ts` | 通过：3 个文件、21 个测试。 |
| `pnpm --filter @job-copilot/database typecheck` | 通过：`tsc --noEmit` 退出码 0。 |
| `pnpm --filter @job-copilot/domain typecheck` | 通过：`tsc --noEmit` 退出码 0。 |
| `git diff --check` | 通过：无空白错误。 |

### 提交

本轮修复提交：`fix: preserve job import source evidence (#7)`；提交 SHA 见本轮最终回复。
