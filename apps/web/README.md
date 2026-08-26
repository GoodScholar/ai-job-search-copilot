# AI Job Search Copilot Web

营销首页与可替换登录边界，基于 Next.js App Router。

需要 Node.js `>=22.22.2` 与 pnpm `11.5.2`。在仓库根目录安装并运行：

```bash
pnpm install
pnpm dev:web
```

常用验证命令同样从仓库根目录执行：

```bash
pnpm test:web
pnpm lint:web
pnpm build:web
pnpm test:e2e
```

营销页面位于 `apps/web/app/(marketing)/page.tsx`，公开路径为 `/`。`/login` 是登录边界：本地默认显示 Dev Auth 说明；正式微信 OAuth 仅保留适配边界，尚未创建会话或真实 OAuth 流程。
