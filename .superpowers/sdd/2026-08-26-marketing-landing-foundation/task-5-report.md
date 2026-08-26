# Task 5：可替换登录边界报告

## 实现范围

- 新增 `getPublicAuthMode(env)`：仅接受已评审的 `wechat`，其他值（含未设置）一律回退 `dev`。
- 新增 `resolveInternalReturnTo(value)`：仅允许单个 `/` 开头且不以 `//` 开头的字符串；数组、绝对 URL、协议相对 URL、空字符串、`undefined` 和 `null` 均回退 `/`。
- 新增保持 Server Component 的 `/login` 页面：使用 Next.js 16 的异步 `searchParams`，展示当前 Adapter 状态与安全的站内回跳路径。
- 默认 Dev 模式说明“本地开发登录”“正式邀请制 Beta 将使用微信登录”及“本实施批次只建立登录边界，尚未创建用户会话”。WeChat 模式只展示“微信 OAuth Adapter 待服务端接入”。

没有新增依赖、客户端边界、API Route、Cookie、OAuth 回调或登录按钮；没有读取 AppSecret，也没有使用 `openid`、`unionid` 或 `/app`。

## TDD 记录

### RED

先创建以下测试：

- `apps/web/lib/auth-mode.test.ts`
- `apps/web/app/login/page.test.tsx`

命令：

```bash
pnpm --filter web test -- lib/auth-mode.test.ts app/login/page.test.tsx
```

关键输出：

```text
FAIL  lib/auth-mode.test.ts
Error: Failed to resolve import "./auth-mode"

FAIL  app/login/page.test.tsx
Error: Failed to resolve import "./page"
```

这确认失败原因是目标功能尚不存在，而非断言或测试配置错误。

### GREEN

以最小实现新增模式解析、站内回跳校验和无操作登录页面后，运行同一命令：

```bash
pnpm --filter web test -- lib/auth-mode.test.ts app/login/page.test.tsx
```

关键输出：

```text
Test Files  5 passed (5)
Tests  9 passed (9)
```

## 验证

```bash
pnpm lint:web
pnpm build:web
git diff --check
```

结果：

```text
$ eslint

✓ Compiled successfully
Finished TypeScript
Route (app)
└ ƒ /login
```

另以静态检查确认新增的登录相关文件不含 Cookie 写入、`openid`/`unionid`、AppSecret、OAuth 回调/链接、`router.push`/`router.replace` 或 `redirect`。

## 构建期类型修复

初次生产构建报告 `ProcessEnv` 不能直接赋给窄化的 `PublicEnv`。原因是 `ProcessEnv` 仅有索引签名，而 `PublicEnv` 含显式可选字段。页面现只投影公开变量：

```ts
getPublicAuthMode({ NEXT_PUBLIC_AUTH_MODE: process.env.NEXT_PUBLIC_AUTH_MODE })
```

这消除了类型错误，并限制了页面可读取的环境值范围。修复后已重跑上述测试、lint 和生产构建。

## 审查修复 Round 1：WeChat 模式文案隔离

审查发现 WeChat 模式仍会无条件显示两段仅属于 Dev 的说明：“正式邀请制 Beta 将使用微信登录”与“本实施批次只建立登录边界，尚未创建用户会话”。本轮不处理已登记 deferred 的 `aria-labelledby` Minor。

### RED

先在 WeChat 模式测试中加入上述两段文本的否定断言，运行：

```bash
pnpm --filter web test -- lib/auth-mode.test.ts app/login/page.test.tsx
```

关键输出：

```text
FAIL  app/login/page.test.tsx > shows only the pending WeChat adapter and rejects external return paths
expected document not to contain element, found <p>
  正式邀请制 Beta 将使用微信登录
</p> instead
```

### GREEN

将这两段说明限制到 `authMode === "dev"` 分支。WeChat 分支保留“微信 OAuth Adapter 待服务端接入”、安全回跳路径及原有的无按钮、无链接边界。

运行同一覆盖测试：

```text
Test Files  5 passed (5)
Tests  9 passed (9)
```

随后验证：

```bash
pnpm lint:web
pnpm build:web
git diff --check
```

关键输出：

```text
$ eslint
✓ Compiled successfully
Finished TypeScript
└ ƒ /login
```
