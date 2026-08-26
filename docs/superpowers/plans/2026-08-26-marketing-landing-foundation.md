# AI Job Search Copilot Marketing Landing Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从当前只有产品文档与 ADR 的目录开始，交付一个可本地运行、响应式、可访问并符合批准构图的 AI Job Search Copilot 中文营销首页及登录边界。

**Architecture:** 先建立最小 pnpm workspace，只创建 `apps/web`，不提前搭建 API、Worker 或数据库。营销页默认使用 React Server Components；只有三张行动简报的切换使用一个小型 Client Component。登录按钮进入稳定的 `/login` 边界，本批次以 Dev Auth 说明页承接，后续微信 OAuth 只替换 Adapter，不改营销页面。

**Tech Stack:** Node.js 22.22.0、pnpm 11.5.2、Next.js App Router、React、TypeScript、Tailwind CSS、shadcn/ui Button、Vitest、Testing Library、Playwright、`@axe-core/playwright`。

**Spec:** `PRODUCT.md`、`.impeccable/surfaces/apps-web-app-marketing-page-tsx.md`、批准稿 `.impeccable/mocks/landing/morning-brief-daily-actions.png`、`docs/adr/0005-ship-responsive-web-first.md`、`docs/adr/0010-use-react-and-nextjs-web-stack.md`、`docs/adr/0021-use-wechat-as-primary-login.md`。

## Global Constraints

- 当前目录不是 Git 仓库，且没有应用代码；第一项任务必须先建立可审查的 Git 与 pnpm workspace 基线。
- 首批只实现公开营销首页和登录边界，不实现 API、Worker、数据库、真实微信 OAuth 或 Agent 运行。
- 批准稿是构图合同：首屏必须保留左侧价值主张、中央三张错位行动简报、右侧 Agent 状态条和明确审批边界。
- 固定首屏文案：“今天，只处理最值得投的 3 件事”“推荐、确认和材料准备，按价值排好顺序”“微信登录体验”“由你确认后才继续”。
- 演示岗位与状态均标注“示例”；不得虚构客户、评价、用户量、奖项、价格、成功率或自动投递能力。
- 页面使用结果导向中文，不把聊天窗口、Agent 技术术语、开发者控制台或三等分功能卡作为主要表达。
- 所有关键交互支持键盘、可见焦点和屏幕阅读器；文本及控件达到 WCAG AA；状态不只靠颜色表达。
- 动效遵循 `prefers-reduced-motion`；简报只在三个明确状态间切换，不使用连续进度条或无限自动轮播。
- 不引入远程字体、图库、分析脚本、图标包或动画库；图标使用内联 SVG，交互使用 React 与 CSS。
- Client Component 只限于 `briefing-stack.tsx`；营销内容、证据链、审批说明与 Footer 保持 Server Component。

---

### Task 1: 建立可验证的 Web 工作区基线

**Files:**
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `apps/web/**`（由 `create-next-app` 生成）
- Modify: `apps/web/package.json`
- Modify: `apps/web/app/page.tsx`（删除生成示例；后续由 route group 取代）

**Interfaces:**
- Consumes: 当前目录中的 `PRODUCT.md`、`CONTEXT.md`、`docs/adr/**` 与 `.impeccable/**`。
- Produces: 可由 `pnpm dev:web`、`pnpm test:web`、`pnpm build:web` 驱动的 `apps/web` 工作区。

- [ ] **Step 1: 写入根工作区与忽略规则**

`package.json` 使用以下内容：

```json
{
  "name": "ai-job-search-copilot",
  "private": true,
  "packageManager": "pnpm@11.5.2",
  "engines": { "node": ">=22.22.0" },
  "scripts": {
    "dev:web": "pnpm --filter web dev",
    "lint:web": "pnpm --filter web lint",
    "test:web": "pnpm --filter web test",
    "test:e2e": "pnpm --filter web test:e2e",
    "build:web": "pnpm --filter web build"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - packages/*
```

`.nvmrc`：

```text
22.22.0
```

`.gitignore` 至少包含：

```gitignore
node_modules/
.next/
out/
coverage/
playwright-report/
test-results/
.env
.env.local
.DS_Store
.impeccable/questions/
```

- [ ] **Step 2: 初始化 Git，并只提交现有设计与架构基线**

Run:

```bash
git init
git add .gitignore .nvmrc package.json pnpm-workspace.yaml PRODUCT.md CONTEXT.md docs .impeccable
git commit -m "docs: record product and design baseline"
```

Expected: `.impeccable/questions/` 未进入索引；首个提交包含 ADR、Surface Brief、批准稿与根工作区声明。

- [ ] **Step 3: 创建无 `src` 层级的 Next.js 应用**

Run:

```bash
pnpm dlx create-next-app@latest apps/web --typescript --eslint --tailwind --app --use-pnpm --no-src-dir --import-alias "@/*" --turbopack
```

Expected: `apps/web/app/layout.tsx` 与 `apps/web/app/page.tsx` 存在；`apps/web/package.json` 的 `name` 改为 `web`；根目录生成并保留唯一的 `pnpm-lock.yaml`。

- [ ] **Step 4: 安装测试依赖并定义脚本**

Run:

```bash
pnpm --filter web add -D vitest jsdom @vitejs/plugin-react @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test @axe-core/playwright
```

在 `apps/web/package.json` 中加入：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  }
}
```

- [ ] **Step 5: 验证生成基线**

Run:

```bash
pnpm lint:web
pnpm build:web
```

Expected: 两条命令退出码均为 `0`，构建没有 TypeScript 或 ESLint 错误。

- [ ] **Step 6: 提交基线**

```bash
git add .gitignore .nvmrc package.json pnpm-workspace.yaml pnpm-lock.yaml apps/web
git commit -m "build: scaffold Next.js web workspace"
```

---

### Task 2: 建立视觉合同、语义布局与设计令牌

**Files:**
- Create: `apps/web/app/(marketing)/layout.tsx`
- Create: `apps/web/app/(marketing)/page.tsx`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/globals.css`
- Create: `apps/web/components/landing/marketing-header.tsx`
- Create: `apps/web/components.json`
- Create: `apps/web/components/ui/button.tsx`
- Create: `apps/web/lib/utils.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/vitest.setup.ts`
- Test: `apps/web/app/(marketing)/page.test.tsx`

**Interfaces:**
- Consumes: 批准稿颜色 `#F3F5F2`、`#18201C`、`#246A49`、`#C98532`、`#D5DDD6`。
- Produces: `MarketingPage`、`MarketingHeader`、`Button` 以及全局 CSS 令牌，供后续所有落地页组件使用。

- [ ] **Step 1: 写首页语义与 CTA 的失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import MarketingPage from "./page";

it("renders the approved promise and login action", () => {
  render(<MarketingPage />);
  expect(
    screen.getByRole("heading", { level: 1, name: "今天，只处理最值得投的 3 件事" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "微信登录体验" })).toHaveAttribute(
    "href",
    "/login?returnTo=%2F",
  );
});
```

- [ ] **Step 2: 运行测试并确认失败原因正确**

Run:

```bash
pnpm --filter web test -- app/\(marketing\)/page.test.tsx
```

Expected: FAIL，原因是 `./page` 尚未提供批准文案或营销页结构。

- [ ] **Step 3: 配置 Vitest 与 Testing Library**

`vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
```

`vitest.setup.ts`：

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: 初始化 shadcn/ui 并只加入 Button**

Run:

```bash
pnpm --dir apps/web dlx shadcn@latest init --defaults
pnpm --dir apps/web dlx shadcn@latest add button
```

Expected: 生成 `apps/web/components.json`、`apps/web/components/ui/button.tsx` 和 `apps/web/lib/utils.ts`；不加入本批次没有使用的组件。

- [ ] **Step 5: 建立全局布局与设计令牌**

`app/layout.tsx` 设置 `lang="zh-CN"`，标题为 `AI Job Search Copilot`，描述为“每天筛出最值得处理的技术岗位，并用真实证据解释推荐”。不加载远程字体。

在 `globals.css` 定义以下令牌并作为唯一颜色入口：

```css
:root {
  --ground: #f3f5f2;
  --surface: #fafbf8;
  --ink: #18201c;
  --muted: #657069;
  --emerald: #246a49;
  --emerald-strong: #18553a;
  --amber: #c98532;
  --rule: #d5ddd6;
  --shadow-paper: 0 24px 70px rgb(24 32 28 / 0.12);
  --font-sans: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
}
```

同时定义 `.container` 最大宽度 `1440px`、统一左右留白、`focus-visible` 双层焦点环，以及 `prefers-reduced-motion` 下禁用非必要过渡。

- [ ] **Step 6: 创建营销页骨架与 Header**

`MarketingHeader` 使用语义化 `<header>` 与 `<nav aria-label="主导航">`，只包含品牌、锚点“工作方式”“证据与控制”及主 CTA。`page.tsx` 先输出 `<main>` 和唯一 `<h1>`，不放生成器默认内容。

根布局源文件首部记录并固定以下方向合同，同时给 `<body>` 增加 `data-impeccable-seed="4e302c13"` 供生产构建审计：

```tsx
/*
THESIS: 每天只交付三件最值得处理的求职行动，拒绝通用 AI SaaS 的截图加三卡布局。
OWN-WORLD: 冷白档案纸、近黑墨色、深祖母绿、克制琥珀批注与精确证据索引。
STORY: 用户先看见结果，再相信证据，最后在保留审批权的前提下登录体验。
FIRST VIEWPORT: 左侧标题与微信 CTA；中央三张错位行动简报；右侧离散 Agent 状态条与审批批注。
FORM: 晨间求职内参 / 今日行动优先；三版构图中的第 3 版；seed 4e302c13。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
*/
```

- [ ] **Step 7: 运行测试、Lint 与构建**

Run:

```bash
pnpm test:web
pnpm lint:web
pnpm build:web
```

Expected: 测试通过；构建产物包含 `data-impeccable-seed="4e302c13"`，且没有远程字体请求。

- [ ] **Step 8: 提交视觉基线**

```bash
git add apps/web
git commit -m "feat(web): establish marketing design foundation"
```

---

### Task 3: 实现首屏行动简报与明确状态切换

**Files:**
- Create: `apps/web/components/landing/briefing-stack.tsx`
- Create: `apps/web/components/landing/hero-section.tsx`
- Test: `apps/web/components/landing/briefing-stack.test.tsx`
- Modify: `apps/web/app/(marketing)/page.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `Button`、全局令牌和 `/login?returnTo=%2F`。
- Produces: `BriefingStack`，props 为 `{ initialId?: BriefingId }`；导出类型 `BriefingId = "recommendation" | "facts" | "resume"`。

- [ ] **Step 1: 写键盘与状态语义的失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BriefingStack } from "./briefing-stack";

it("lets the user bring a briefing to the front", async () => {
  const user = userEvent.setup();
  render(<BriefingStack />);
  expect(screen.getByText("AI 应用工程师").closest("article")).toHaveAttribute(
    "data-active",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "查看确认 2 条候选事实" }));
  expect(screen.getByText("确认 2 条候选事实").closest("article")).toHaveAttribute(
    "data-active",
    "true",
  );
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm --filter web test -- components/landing/briefing-stack.test.tsx
```

Expected: FAIL，原因是 `BriefingStack` 尚不存在。

- [ ] **Step 3: 实现最小状态模型**

`briefing-stack.tsx` 是本页唯一 Client Component，使用固定数组和 `useState`，不使用定时器：

```tsx
"use client";

export type BriefingId = "recommendation" | "facts" | "resume";

const briefings = [
  { id: "recommendation", label: "AI 应用工程师", action: "查看岗位推荐" },
  { id: "facts", label: "确认 2 条候选事实", action: "查看确认 2 条候选事实" },
  { id: "resume", label: "审核 1 份定制简历", action: "查看审核 1 份定制简历" },
] as const;
```

每张简报使用 `<article data-active>`，切换控件使用真实 `<button>`、`aria-pressed` 和完整可见焦点；只在用户点击或键盘激活时改变前后顺序。

- [ ] **Step 4: 实现批准稿中的真实示例内容**

推荐简报必须显示“示例”“AI 应用工程师”“匹配 91”“强证据：React 架构 / Agent 工作流”“主要缺口：大模型评测经验”；其余两张分别显示待确认事实与 Markdown 简历审阅。所有数字明确属于演示状态，不表达产品实际处理量。

右侧状态条使用 `<aside aria-label="Copilot 示例运行状态">`，固定显示“正在检查 12 家目标公司（示例）”“8 家已完成”“外部行动 0”，并显示琥珀批注“由你确认后才继续”。

- [ ] **Step 5: 还原首屏构图与响应规则**

桌面 `min-width: 1024px` 使用 12 栏网格：标题区 4 栏、简报堆叠 6 栏、状态条 2 栏。移动端顺序为标题与 CTA、简报切换、审批边界、状态条；任何宽度均不得横向滚动。

动效只使用 `transform` 与 `opacity`，切换时长 `260ms`；`prefers-reduced-motion: reduce` 下时长为 `0.01ms`。不自动轮播，不连续闪烁，不动画匹配分数。

- [ ] **Step 6: 运行组件测试与完整验证**

Run:

```bash
pnpm test:web
pnpm lint:web
pnpm build:web
```

Expected: 全部通过；构建中只有 `briefing-stack.tsx` 带 `use client`。

- [ ] **Step 7: 提交首屏**

```bash
git add apps/web
git commit -m "feat(web): build prioritized briefing hero"
```

---

### Task 4: 用证据链和审批边界完成说服路径

**Files:**
- Create: `apps/web/components/landing/background-work-section.tsx`
- Create: `apps/web/components/landing/evidence-chain-section.tsx`
- Create: `apps/web/components/landing/approval-boundary-section.tsx`
- Create: `apps/web/components/landing/resume-format-section.tsx`
- Create: `apps/web/components/landing/final-cta.tsx`
- Create: `apps/web/components/landing/marketing-footer.tsx`
- Test: `apps/web/app/(marketing)/page-content.test.tsx`
- Modify: `apps/web/app/(marketing)/page.tsx`
- Modify: `apps/web/app/globals.css`

**Interfaces:**
- Consumes: Global Constraints 中的真实能力边界和固定 CTA。
- Produces: 完整营销叙事：结果承诺 → 后台工作 → 证据依据 → 用户控制 → 简历格式 → 登录。

- [ ] **Step 1: 写内容真实性与顺序的失败测试**

```tsx
import { render, screen } from "@testing-library/react";
import MarketingPage from "./page";

it("explains evidence and approval before the final action", () => {
  render(<MarketingPage />);
  const headings = screen.getAllByRole("heading").map((node) => node.textContent);
  expect(headings).toEqual(expect.arrayContaining([
    "Copilot 在后台工作，你只处理关键决定",
    "值得投，不只是一个分数",
    "任何外部行动，都先经过你的确认",
    "一份画像，多种简历格式",
  ]));
  expect(screen.getByText(/Markdown/)).toBeInTheDocument();
  expect(screen.queryByText(/已有.*用户|成功率|自动投递/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm --filter web test -- app/\(marketing\)/page-content.test.tsx
```

Expected: FAIL，缺少第二屏及后续说服内容。

- [ ] **Step 3: 实现后台工作流程段**

用一条有方向的编辑流程线串联四步：“检查目标公司”“资格门槛”“证据匹配”“生成今日清单”。每一步包含一句用户收益，不做四张等宽功能卡；流程末端连接“你只处理关键决定”。

- [ ] **Step 4: 实现证据链段**

以一条示例事实“主导 React 应用架构拆分”演示 `简历来源 → 已验证画像事实 → 岗位要求 → 推荐解释`。明确显示“来源可追溯”“缺口不隐藏”，并把 B 版构图的证据映射思想吸收到第二屏，但不引入新视觉世界。

- [ ] **Step 5: 实现审批边界与格式段**

审批段只承诺内部分析自动化；把“提交申请”“发送邮件”“联系招聘者”放在审批线外，并写明“本地 Beta 不自动执行外部行动”。格式段明确 Markdown 是一级导入/导出格式，并列出 DOCX、PDF；不暗示导入会直接覆盖确认画像。

- [ ] **Step 6: 实现最终 CTA 与 Footer**

最终 CTA 复用“微信登录体验”并指向 `/login?returnTo=%2F`。Footer 只包含产品名和“本地邀请制 Beta · 外部行动需确认”；不创建尚无正文的隐私、条款路由，也不放社交媒体、客户 Logo 或虚构公司信息。

- [ ] **Step 7: 验证内容与构建**

Run:

```bash
pnpm test:web
pnpm lint:web
pnpm build:web
```

Expected: 测试通过；首页所有 `<section>` 都有可关联的标题；没有被禁止的商业事实。

- [ ] **Step 8: 提交完整说服路径**

```bash
git add apps/web
git commit -m "feat(web): explain evidence and approval boundaries"
```

---

### Task 5: 建立可替换的登录边界

**Files:**
- Create: `apps/web/app/login/page.tsx`
- Create: `apps/web/lib/auth-mode.ts`
- Test: `apps/web/lib/auth-mode.test.ts`
- Test: `apps/web/app/login/page.test.tsx`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_AUTH_MODE`，允许值为 `"dev" | "wechat"`。
- Produces: `getPublicAuthMode(env): "dev" | "wechat"`、`resolveInternalReturnTo(value): string`；稳定登录入口 `/login?returnTo=/`。

- [ ] **Step 1: 写 Auth Mode 的失败测试**

```ts
import { expect, it } from "vitest";
import { getPublicAuthMode, resolveInternalReturnTo } from "./auth-mode";

it("defaults to dev auth locally", () => {
  expect(getPublicAuthMode({})).toBe("dev");
});

it("accepts the reviewed WeChat mode", () => {
  expect(getPublicAuthMode({ NEXT_PUBLIC_AUTH_MODE: "wechat" })).toBe("wechat");
});

it("rejects external and protocol-relative return paths", () => {
  expect(resolveInternalReturnTo("//example.com")).toBe("/");
  expect(resolveInternalReturnTo("https://example.com")).toBe("/");
  expect(resolveInternalReturnTo("/profile")).toBe("/profile");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm --filter web test -- lib/auth-mode.test.ts
```

Expected: FAIL，`getPublicAuthMode` 尚不存在。

- [ ] **Step 3: 实现确定性的模式解析**

```ts
type PublicEnv = { NEXT_PUBLIC_AUTH_MODE?: string };

export function getPublicAuthMode(env: PublicEnv): "dev" | "wechat" {
  return env.NEXT_PUBLIC_AUTH_MODE === "wechat" ? "wechat" : "dev";
}

export function resolveInternalReturnTo(value: string | string[] | undefined): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}
```

不在 Web 客户端读取 AppSecret，不创建伪造微信回调，也不把 openid/unionid 当内部用户 ID。

- [ ] **Step 4: 实现登录页**

Dev 模式显示“本地开发登录”和说明“正式邀请制 Beta 将使用微信登录”，同时明确“本实施批次只建立登录边界，尚未创建用户会话”。页面不渲染伪登录按钮、不写 Cookie，也不进入不存在的工作台路由。Wechat 模式同样只显示“微信 OAuth Adapter 待服务端接入”，不创建指向不存在接口的链接。

对 `returnTo` 仅接受以单个 `/` 开头且不以 `//` 开头的站内路径，非法值回退 `/`，避免开放重定向。

- [ ] **Step 5: 验证登录文案、回跳与模式**

Run:

```bash
pnpm --filter web test -- lib/auth-mode.test.ts app/login/page.test.tsx
pnpm lint:web
pnpm build:web
```

Expected: 两种模式测试通过；默认构建不需要微信凭据；页面不声称已完成真实微信授权。

- [ ] **Step 6: 提交登录边界**

```bash
git add apps/web
git commit -m "feat(web): add replaceable login boundary"
```

---

### Task 6: 加入浏览器级响应式与可访问性验收

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/landing.spec.ts`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: 首页 `/` 与登录页 `/login`。
- Produces: 桌面、移动、键盘与 axe 自动验收，供每次视觉修订后重复运行。

- [ ] **Step 1: 写桌面与移动失败测试**

```ts
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("landing page has no horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBe(widths.client);
});

test("landing page passes automated accessibility checks", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
```

- [ ] **Step 2: 配置 Playwright Web Server**

`playwright.config.ts` 使用 `pnpm dev --hostname 127.0.0.1`，`baseURL` 为 `http://127.0.0.1:3000`，项目包含 Desktop Chrome 与 Mobile Safari 尺寸。CI 重试 `2` 次，本地不重试。

- [ ] **Step 3: 扩充关键路径测试**

增加以下断言：

- `1440×900` 首屏同时可见 H1、CTA、三张简报和审批批注。
- `390×844` 首屏先出现 H1 与 CTA，简报紧随其后。
- Tab 键可以依次到达主导航、CTA、三张简报切换按钮。
- 点击 CTA 后 URL 为 `/login?returnTo=%2F`，页面显示本地 Dev Auth 说明。
- 模拟 `reducedMotion: "reduce"` 后，简报仍能切换且内容没有不可见等待期。

- [ ] **Step 4: 运行浏览器验收**

Run:

```bash
pnpm test:e2e
```

Expected: Desktop Chrome、Mobile Safari、axe、键盘和 reduced-motion 测试全部通过。

- [ ] **Step 5: 提交验收套件**

```bash
git add apps/web
git commit -m "test(web): cover landing accessibility and responsiveness"
```

---

### Task 7: 依据批准稿完成审美校准与收尾审查

**Files:**
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/components/landing/*.tsx`（只修改审查指出的具体问题）
- Create: `DESIGN.md`
- Create: `.impeccable/mocks/review/landing-desktop.png`
- Create: `.impeccable/mocks/review/landing-mobile.png`

**Interfaces:**
- Consumes: 批准稿、Taste 参数 `7/5/4`、Impeccable `polish → bolder/quieter → critique` 流程。
- Produces: 经浏览器截图、视觉差异审查、自动测试和文档化验证的最终落地页。

- [ ] **Step 1: 启动页面并采集固定视口截图**

Run:

```bash
pnpm dev:web
```

使用浏览器自动化在 `1440×900` 与 `390×844` 采集完整页面截图到 `.impeccable/mocks/review/`。截图中不得出现开发错误覆盖层、加载占位或被裁切 CTA。

- [ ] **Step 2: 执行第一轮 critique**

逐项对照批准稿审查：首屏重心、简报叠放尺度、右侧状态条、审批批注、中文换行、背景与纸张层次、移动顺序。形成具体问题清单，每项包含截图证据、组件路径与修复结果；不以“更好看”作为问题描述。

- [ ] **Step 3: 选择 bolder 或 quieter 校准**

仅按实测结果选择一个方向：若首屏与普通 SaaS 无差异，执行 `bolder`，强化叠放尺度和编辑批注；若信息抢夺主任务，执行 `quieter`，降低次级流程与装饰对比。不得同时执行两者，也不得改变已批准的视觉世界。

- [ ] **Step 4: 执行 polish 与全量回归**

修正排版、间距、焦点、断点、触控尺寸和离散状态动效后运行：

```bash
pnpm test:web
pnpm lint:web
pnpm build:web
pnpm test:e2e
```

Expected: 所有命令退出码 `0`；桌面与移动截图无横向滚动、无遮挡、无颜色单独承载的状态。

- [ ] **Step 5: 写入最终设计文档**

`DESIGN.md` 记录已经在代码中成立的视觉系统：颜色令牌、字体栈、页面网格、档案纸组件、琥珀批注、简报离散动效、响应式规则、可访问性规则和禁止模式。它描述最终实现，不新增未实现的品牌规则。

- [ ] **Step 6: 验证视觉合同与图片来源**

Run:

```bash
rg -n "4e302c13|unreviewed and undocumented is unfinished" apps/web
node /Users/shen/.skills-manager/skills/impeccable/scripts/embed-prompt.mjs .impeccable/mocks/landing/morning-brief-daily-actions.png --read >/dev/null
jq -e '.approved == true and (.prompt | length > 0)' .impeccable/mocks/landing/morning-brief-daily-actions.png.json
```

Expected: 三条验证均成功；批准稿保留嵌入提示与 `approved: true`。

- [ ] **Step 7: 最终提交**

```bash
git add apps/web DESIGN.md .impeccable/mocks/review .impeccable/mocks/landing
git commit -m "feat(web): finish AI Job Search Copilot landing page"
```

## Completion Criteria

- `pnpm test:web`、`pnpm lint:web`、`pnpm build:web`、`pnpm test:e2e` 全部通过。
- 首页与批准稿在信息层级和首屏构图上一致，同时在 `390px` 宽度可正常使用。
- “微信登录体验”稳定进入登录边界，本地模式明确说明 Dev Auth，未伪造微信会话。
- 首屏证明“每日少量高价值行动 + 证据 + 用户审批”，而不是聊天机器人或自动投递器。
- 最终有 `DESIGN.md`、桌面/移动审查截图、批准稿来源信息和可追溯 Git 提交。
