# AI Job Search Copilot

本仓库提供 AI Job Search Copilot 的本地产品运行时：Web、API、Worker，以及 PostgreSQL、Redis、MinIO 和 Mailpit。本阶段的工作台是一个已接入真实账户与会话的空状态基础，不是营销首页的示例数据。

## 前置条件

- Node.js `>=22.22.2`
- pnpm `11.5.2`
- Docker 与 Docker Compose

默认端口见 [`.env.example`](./.env.example)。如需覆盖端口，请在同一 shell 中导出变量后再运行 `pnpm dev`；例如 `WEB_PORT=4020 API_PORT=4021 pnpm dev`。默认端口适用于通常的本地开发；不要把 E2E 使用的隔离端口作为日常开发端口。

## 启动与访问

在仓库根目录运行：

```bash
pnpm install && pnpm dev
```

`pnpm dev` 会先对本地数据库运行迁移，再启动 Web、API、Worker，以及 PostgreSQL、Redis、MinIO 和 Mailpit；迁移、Docker Compose 或任何依赖不可用时，应用不会以不完整状态继续启动，因此无需手动执行迁移。

- 产品：<http://127.0.0.1:3020>
- API OpenAPI：<http://127.0.0.1:3021/openapi.json>
- API readiness：<http://127.0.0.1:3021/health/ready>
- Mailpit：<http://127.0.0.1:58025>
- MinIO Console：<http://127.0.0.1:59001>

停止本地运行时：

```bash
pnpm dev:down
```

若 `pnpm dev` 仍在另一个终端运行，先在该终端按 `Ctrl-C`，它会先停止 Web、API 和 Worker，再清理由 Compose 管理的依赖。`pnpm dev:down` 本身只关闭 Compose 管理的基础设施（以及残留测试资源），不会终止其他终端中的应用进程。

## 登录与当前范围

本地运行时启用 **Dev Auth**，仅用于本地开发和测试；它不是生产认证方案，也不能用于正式环境。正式 Beta 将使用微信登录，当前仅保留相应的产品与适配边界，尚未实现真实微信 OAuth 流程。

登录后进入 `/home`。任务控制首页与 Agent Inbox 会聚合账户级的真实推荐、待确认事实、运行、来源关注和待决定事项，不展示营销示例数据。投递记录仍未启用，始终显示为 `0`，也不会保存投递数据。

## 验证

在满足上述 Node 与 pnpm 版本约束的环境中，从仓库根目录运行：

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build
```

端到端测试使用自己的隔离 Compose 项目和端口，并会在结束时清理；它不会占用或替代本文档中的默认开发端口。

### OpenAI 职业资料解析

默认使用确定性的 Fake；测试运行时会强制选择 Fake。生产解析需在同一运行环境中显式配置 `CAREER_PARSER_ADAPTER=openai` 和 `OPENAI_API_KEY`，模型默认遵循 ADR 0019 的 `gpt-5.6-luna`（可由部署配置 `OPENAI_LOW_COST_MODEL` 指定）。API 与 Worker 必须使用相同配置。

独立真实验证使用 `career-parser-eval-v1` 固定脱敏 Markdown，不读取用户文件；门禁检查事实完整性、准确原文证据、注入过滤与延迟，仅输出版本和事实数量：

```bash
CAREER_PARSER_ADAPTER=openai pnpm verify:career-parser:openai
```

解析仅读取通过隐私检查的处理副本；每次最多处理 16 KiB UTF-8 文本、生成 4,000 个输出 Token、消耗 20,000 个总 Token，25 秒后终止。超出解析预算的资料会保留稳定失败原因，用户可精简后重试。文件上传上限与解析预算分别约束文件存储和模型调用。

Adapter 使用 [Responses Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)，关闭响应存储、不提供工具，模型仅选择事实类型和原文行号；事实值由本地原文生成，并再次通过领域校验。密钥、原文、联系方式和供应方错误正文不会进入普通日志。

### OpenAI 岗位规范化

岗位规范化默认使用确定性的 Fake；生产 API 与 Worker 都需显式设置 `JOB_POSTING_NORMALIZER_ADAPTER=openai` 和 `OPENAI_API_KEY`，并共同沿用 `OPENAI_LOW_COST_MODEL`；可选 `OPENAI_ENDPOINT`、`OPENAI_ORGANIZATION` 与 `OPENAI_PROJECT`。独立评测只使用固定合成岗位并输出版本、状态、证据数量、用量状态与延迟分桶：

```bash
JOB_POSTING_NORMALIZER_ADAPTER=openai pnpm verify:job-normalizer:openai
```

每次调用最多接收 16 KiB 输入、生成 2,000 个输出 Token、总计 12,000 Token，并在 25 秒后终止；发现运行仍受其冻结预算策略约束。未在原文明确支持的字段保持未知，正文不会写入日志，Responses 关闭存储且不提供工具。
