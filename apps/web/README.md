# AI Job Search Copilot Web

Web 是本地产品运行时的一部分，基于 Next.js App Router。请在仓库根目录使用完整运行时启动，而不是单独启动营销页面：

```bash
pnpm install && pnpm dev
```

默认访问地址是 <http://127.0.0.1:3020>；API 与运行依赖会同时启动。完整的前置条件、端口、停止方法和验证命令见[根 README](../../README.md)。

`/` 仍是公开营销页面；`/login` 和 `/home` 是产品工作台的认证边界。本地仅使用 Dev Auth，正式 Beta 将使用微信登录；当前尚未实现真实微信 OAuth。工作台的任务控制首页与 Agent Inbox 展示 API 聚合的真实账户级状态；投递记录仍未启用，不会保存投递数据。

Web 专项验证同样从仓库根目录运行：

```bash
pnpm lint:web
pnpm test:web
pnpm test:e2e
pnpm build:web
```
