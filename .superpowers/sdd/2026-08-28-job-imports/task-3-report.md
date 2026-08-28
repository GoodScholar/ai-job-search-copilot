# Task 3 报告：认证 API 与岗位导入 Worker

状态：完成。

提交：`d2370d8`（`feat: expose asynchronous job imports (#7)`）。

## 改动

- 新增 Nest 岗位导入模块：认证的创建、列表、详情和 owner-only 原文端点；创建首次返回 202、重复返回 200；所有可预期错误映射为稳定、安全的 problem。
- 新增 MinIO 正文存储适配器（含 `delete`）和 BullMQ 入队适配器；队列只发送 `{ version, importId, userId }`。
- 新增 Worker Fake normalizer、BullMQ consumer 和 Nest wiring。Fake 仅识别明确 Markdown 标题/标签，未知字段为 `null`，描述章节逐字复制；`<!-- job-copilot:fake-normalizer-invalid -->` 是唯一的确定性无效夹具。
- 新增 API 和 Worker 集成测试，覆盖鉴权/越权、严格请求校验、原文 content-type、异步完成、最终重试失败与至少一次投递幂等。

## 命令与结果

- RED：`pnpm --filter worker exec vitest run src/job-imports/fake-job-posting-normalizer.test.ts`（初次：缺少 Fake normalizer 模块）；新增“原样复制描述章节”测试后，确认因首尾空白被 trim 而失败。
- GREEN：同一 Fake normalizer 测试，4/4 通过。
- RED：`pnpm --filter api exec vitest run src/api.integration.test.ts`（初次：缺少 `job-imports.tokens` 模块）。
- GREEN：`pnpm --filter api exec vitest run src/api.integration.test.ts`，32/32 通过。
- RED：`pnpm --filter worker exec vitest run src/job-imports/job-import.integration.test.ts`（初次：缺少 Worker consumer 模块）。
- GREEN：`pnpm --filter worker exec vitest run src/job-imports/fake-job-posting-normalizer.test.ts src/job-imports/job-import.integration.test.ts`，6/6 通过。
- `pnpm --filter api typecheck`：通过。
- `pnpm --filter worker typecheck`：通过。
- `git diff --check`：通过。
- brief 中指定的 `pnpm --filter @job-copilot/api ...` 与 `pnpm --filter @job-copilot/worker ...` 均未执行测试：当前 workspace 包名实际是 `api` 与 `worker`，因此 pnpm 返回 `No projects matched the filters`；已用上述等价实际包名命令完成验证。

## 自审与顾虑

- 正文不会写入队列载荷；非最终 content/normalizer 失败仍抛出，使 BullMQ 重试；最终尝试写入稳定失败码。
- brief 的 Fake normalizer 示例含 `adapter` 字段，但现有 `JobNormalizerOutputSchema` 是严格对象且不允许该字段。为确保 Worker 可完成导入，Fake 输出遵循既有契约，只返回 `normalizerVersion` 与规范化字段。
- Worker 内的 MinIO store 保持在 module 文件中，是为遵守 Task 3 指定的可修改文件范围；与 API adapter 的行为一致。
