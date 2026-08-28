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
