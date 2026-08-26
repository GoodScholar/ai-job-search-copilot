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

## 登录与当前范围

本地运行时启用 **Dev Auth**，仅用于本地开发和测试；它不是生产认证方案，也不能用于正式环境。正式 Beta 将使用微信登录，当前仅保留相应的产品与适配边界，尚未实现真实微信 OAuth 流程。

登录后进入 `/home`。这里的推荐、待审批和投递记录均由 API 返回真实的 `0` 值，不展示营销示例数据。当前尚无职业资料、求职画像、岗位业务或求职代理（Agent）业务；这些能力不应被视为已可用。

## 验证

在满足上述 Node 与 pnpm 版本约束的环境中，从仓库根目录运行：

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build
```

端到端测试使用自己的隔离 Compose 项目和端口，并会在结束时清理；它不会占用或替代本文档中的默认开发端口。
