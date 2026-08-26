# Task 2 执行报告：视觉合同、语义布局与设计令牌

## 结果

- 建立了仅由 `apps/web/app/(marketing)/page.tsx` 提供 `/` 的营销页骨架；仓库中仍不存在 `apps/web/app/page.tsx`。
- 根布局记录了批准的视觉合同，设定 `lang="zh-CN"`、元数据与 `data-impeccable-seed="4e302c13"`。
- `globals.css` 将批准色值收敛为设计令牌，并提供 `1440px` 容器、统一留白、双层焦点环与减少动态偏好处理。
- 新增语义化 `MarketingHeader`、营销路由布局、Page 的唯一一级标题与微信登录 CTA。
- 通过 shadcn 初始化并仅加入 Button；CTA 使用 `buttonVariants` 的内置 `default` / `lg` variant 和原生链接语义（经 `next/link` 渲染）。

## TDD 记录

1. 先创建 `apps/web/app/(marketing)/page.test.tsx`，它检验批准标题与 `/login?returnTo=%2F` CTA。
2. RED：运行 `pnpm --filter web test -- 'app/(marketing)/page.test.tsx'`，失败原因符合预期：`Cannot find module './page'`。
3. 配置 Vitest/Testing Library 后，实现最小营销页、布局与 Header。
4. GREEN：同一命令通过，`1 passed`；随后升级为完整工作区验证。

## shadcn 流程

- 已在 `apps/web` 运行要求的 `pnpm dlx shadcn@latest info --json` 与 `pnpm dlx shadcn@latest docs button`；本机 pnpm 临时环境在 `@modelcontextprotocol/sdk` 解析 `zod/v4` 时失败，错误为 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- 以相同版本的 `npx --yes shadcn@latest` 作为不修改项目依赖的回退，成功读取项目上下文和 Button 文档。上下文确认：Next.js RSC、Tailwind v4、`@` alias、Base UI；文档确认链接 CTA 应使用 `buttonVariants` 而非把 Base UI Button 直接渲染为链接。
- 执行 `npx --yes shadcn@latest init --defaults` 与 `npx --yes shadcn@latest add button`，生成 `components.json`、`components/ui/button.tsx` 与 `lib/utils.ts`。随后已阅读生成文件并采用其 Base UI API。

## 构建兼容性修复

- Vitest 首次通过时出现 ESM 配置预警；根因是包缺少模块类型，添加 `"type": "module"` 后预警消失。
- 初次生产构建显示锁定的 TypeScript 5.0.2 无法解析当前 `@vitejs/plugin-react` 的类型声明，已将 `typescript` 升级到 5.9.3。
- TypeScript 随后只缺少 Vitest 的全局测试类型，已在 `tsconfig.json` 添加 `vitest/globals`。

## 最终验证

```text
$ pnpm test:web
Test Files  1 passed (1)
Tests       1 passed (1)

$ pnpm lint:web
$ eslint

$ pnpm build:web
✓ Compiled successfully
✓ Finished TypeScript
Route (app)
┌ ○ /
└ ○ /_not-found
```

附加审计：`rg -l -F 'data-impeccable-seed="4e302c13"' apps/web/.next` 命中生产 `index.html`；对 `apps/web/app`、`apps/web/components` 与 `apps/web/.next` 搜索 `next/font/google`、`fonts.googleapis.com`、`fonts.gstatic.com` 未发现结果。

## Fix round 1：移除未使用动画库

- 审查发现 `tw-animate-css` 被添加为依赖并在 `globals.css` 导入；全文检索确认它仅出现在 `apps/web/package.json`、`pnpm-lock.yaml` 与这一个 CSS import，当前 Button、Header 和营销页均未使用其能力。
- 已移除该 CSS import、`tw-animate-css` 依赖及对应 lockfile 条目；保留原有 `prefers-reduced-motion` 规则，未修改任何 shadcn 或视觉实现。

```text
$ pnpm test:web
Test Files  1 passed (1)
Tests       1 passed (1)

$ pnpm lint:web
$ eslint

$ pnpm build:web
✓ Compiled successfully
✓ Finished TypeScript
Route (app)
┌ ○ /
└ ○ /_not-found
```
