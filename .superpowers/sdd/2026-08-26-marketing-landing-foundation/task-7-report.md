# Task 7 最终自检报告

## 校准决策

- 选择：**bolder**。
- 依据：合并 critique 已确认首屏过于普通，批准稿要求的三张行动简报没有同时可辨；问题不在色彩或动效过强。
- 执行：只放大现有“档案纸 + 三件行动 + 琥珀审批注记”语言；**quieter 未运行**。

## 初始问题、修复与证据

| 初始问题 | 最小修复 | 最终证据 |
| --- | --- | --- |
| 390px Header 将页内锚点压成逐字竖排，CTA 仅 36px | 增加 Header 局部响应式规则：小屏隐藏两条页内锚点；三处登录 CTA 统一最小高度 44px | 浏览器 390×844 snapshot 只列品牌与“微信登录体验”；实测 CTA heights 为 `[44,44,44]`，`scrollWidth=clientWidth=375`；移动 e2e 通过 |
| 首屏退化为一张完整卡与两张幽灵纸 | H1 扩至 5 列语言空间；桌面行动纸改为一张主纸和两张右侧不同尺度的可读待处理纸，显示类型与状态；移除 side-tab 视觉 | `landing-desktop.png` 显示“AI 应用工程师 / 匹配 91”“确认 2 条候选事实 / 待你确认”“审核 1 份定制简历 / 待你审核”；桌面 e2e 通过直接点击露出的纸张置前 |
| 切换器是 `aria-pressed` 按钮，非活动详情连续进入辅助技术阅读顺序 | 改为 roving-tabindex tabs：`tablist`、`tab`、关联 `tabpanel`；只让活动 panel 留在正常辅助技术树；方向键、Home、End 选纸 | RED 测试先因找不到 `tab` 失败；GREEN 单测通过。最终 desktop/mobile axe 通过，键盘 e2e 通过 |
| 候选“大模型评测”事实与 91 分的关系不清楚 | 候选事实纸新增“待确认，尚未计入当前 91 分或正式画像证据（示例）” | 文案同时存在于视觉纸和活动 panel；单测在切换后断言活动 panel 内容 |
| reduced-motion 仅断言 ARIA 状态 | e2e 额外断言切换后活动 panel 立即包含“Markdown 简历草稿” | Desktop Chrome 与 Mobile Safari reduced-motion e2e 均通过 |
| 中文标题字距过紧、后半页重复眉题 | 中文负字距收回至不低于 `-0.04em`；仅隐藏营销页后半段重复眉题 | 最终截图显示更直接的章节节奏；`rg` 未发现低于阈值的本次标题字距 |
| 桌面 axe 发现叠放纸的透明度降低了小字对比 | 去除非活动纸的全卡 opacity 降级，保留尺度和位置区分 | 重跑桌面 axe 通过；全量 e2e 12 passed、6 skipped |

## RED / GREEN 记录

- **RED 1**：`pnpm --filter web test -- components/landing/briefing-stack.test.tsx` 失败，旧实现没有 `tab` 角色，错误为找不到 `AI 应用工程师（示例）` tab。
- **GREEN 1**：最小 tabs 实现后，`pnpm test:web` 为 5 files / 9 tests passed。
- **RED 2**：新增桌面直接点击纸张的 e2e 在堆叠遮挡下超时，确认露出的事实纸中心会被更高层纸截获。
- **GREEN 2**：调整两张待处理纸的层级后，`桌面端可直接点击露出的档案纸将其置前` 通过。
- **RED 3**：全量 axe 报告叠放纸 opacity 导致 3.48:1 / 4.24:1 的文字对比不足。
- **GREEN 3**：移除 opacity 降级后，Desktop Chrome 和 Mobile Safari 的 axe 均通过。

## 浏览器证据

- 独立服务：`127.0.0.1:3005`，以 `apps/web/node_modules/.bin/next dev` 启动；检查后已停止。
- Desktop：1440×900 浏览器 snapshot 包含 3 个 tabs、主标题、登录 CTA 和各章节；截图为 `.impeccable/mocks/review/landing-desktop.png`。
- Mobile：390×844 snapshot 只保留 Header 的品牌和登录 CTA；截图为 `.impeccable/mocks/review/landing-mobile.png`。
- Console：仅 Next DevTools 提示和 HMR 连接日志；errors 无输出。
- Browser session：`task7-final-desktop`、`task7-final-mobile` 已关闭。

## 最终审查评分

### Critique 自检

| 项目 | 分数 | 依据 |
| --- | ---: | --- |
| 系统状态可见性 | 4/4 | 离散运行条、选中 tab 和关联 panel 同步。 |
| 真实世界匹配 | 3/4 | 求职证据与审批语言明确；RSC/Markdown 仍作为示例材料内容保留。 |
| 用户控制 | 4/4 | 鼠标、键盘和登录边界均可返回且无外部自动操作。 |
| 一致性与响应式 | 4/4 | Mobile Header、触控尺寸、焦点和断点均通过实测。 |
| 错误预防 | 4/4 | 候选事实不计入 91 分的边界已明确。 |
| 识别而非回忆 | 4/4 | 三张纸同时露出类型和状态。 |
| 审美与最小化 | 3/4 | 首屏形成强记忆点；下半页仍以克制的文字证据为主。 |
| 错误恢复 | 2/4 | 登录边界说明未创建会话，但没有模拟真实微信 OAuth 失败流程（本批次未实现能力）。 |
| **合计** | **28/32 · 88%** | **Good，剩余限制已如实标注。** |

### Audit 自检

| 维度 | 分数 | 结论 |
| --- | ---: | --- |
| Accessibility | 4/4 | axe 0 violations、tabs/tabpanel、焦点、reduced motion、44px 控件。 |
| Performance | 4/4 | 静态营销内容，只有简报 Client Component；无远程字体、图库或额外运行时。 |
| Theming | 3/4 | 营销页面复用现有 CSS tokens；项目没有深色主题需求。 |
| Responsive | 4/4 | 1440/390 实测，无横向溢出。 |
| Implementation Integrity | 4/4 | 视觉世界、批准稿和真实产品边界一致；已移除 side-tab。 |
| **合计** | **19/20 · Excellent** | **无 P0/P1；唯一 P2 为正式微信 OAuth 的失败恢复尚未实现，属于本批次范围外。** |

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test:web` | 5 files / 9 tests passed |
| `pnpm lint:web` | exit 0 |
| `pnpm build:web` | exit 0；`/` 静态，`/login` 动态 |
| `PLAYWRIGHT_PORT=3004 pnpm test:e2e` | 12 passed / 6 skipped / exit 0 |
| `git diff --check` | exit 0 |
| `rg -n "4e302c13|unreviewed and undocumented is unfinished" apps/web` | 3 命中，合同保留 |
| `embed-prompt.mjs ... --read` | exit 0 |
| `jq -e '.approved == true and (.prompt | length > 0)' ...` | `true` |

## 交付物与剩余问题

- 已新增 `DESIGN.md` 与 `.impeccable/design.json`（schemaVersion 2，5 个真实代表组件）。
- 已新增最终桌面/移动审查截图。
- 未解决：真实微信 OAuth 及其网络失败恢复不属于当前公开营销页 + Dev Auth 登录边界的实现范围；没有假造该能力。

## Fix round 1

### RED / GREEN

- **RED 1**：新增 `桌面待处理纸可辨识并可直接点击第三张纸置前` 后，第三张“审核 1 份定制简历 / 待你审核”点击超时；Playwright 明确报告第二张纸的子树拦截 pointer events。
- **GREEN 1**：活动纸只渲染详情，非活动纸只渲染 glance 标题/状态，详情不再以 `visibility: hidden` 留在纸张布局中。定向 E2E 已可直接点击第三张纸置前；两张待处理纸的标题和状态均断言通过。
- **RED 2**：新增组件测试时，旧实现使同一张纸的标题在 glance、详情与 panel 中重复出现。
- **GREEN 2**：组件测试将断言限定于可视纸张 tablist：每张纸在任一排序只有一个标题；`pnpm test:web` 为 5 files / 10 tests passed。

### 逐项修复结论

| Finding | Verdict |
| --- | --- |
| ground / surface / ink 偏离合同 | 已修复为 `#f4f6f3` / `#fffefa` / `#15211d`，并同步 `DESIGN.md` 与 sidecar；`amber #c98532` 未变，`amber-ink #9f5f14` 记录为派生 AA 角色。 |
| 第三张纸被覆盖 | 已修复：非活动详情退出布局，待处理纸保持紧凑高度；E2E 覆盖两张标题/状态及直接点击第三张置前。 |
| sidecar schema 与 colorMeta 不完整 | 已修复：顶层严格为 `schemaVersion`、`generatedAt`、`title`、`extensions`、`components`、`narrative`；9 个 DESIGN 颜色均有 8-step tonalRamp，保留 5 个自包含 `ds-*` 组件。 |
| 活动纸重复标题 | 已修复：活动态仅渲染详情，非活动态仅渲染 glance；组件测试防回归。 |
| Markdown span 样式未绑定 | 已修复：等宽字体、字号、行高迁移到 `.briefing-markdown span`。 |

### 截图与浏览器证据

- 独立服务：`127.0.0.1:3018`，仅用于本轮检查，已关闭；`agent-browser` 的 `task7-fix-desktop`、`task7-fix-mobile` session 也已关闭。
- agent-browser 真实 viewport：Desktop `window.innerWidth/innerHeight=1440/900`、`clientWidth=1425`、`scrollWidth=1425`；Mobile `390/844`、`clientWidth=375`、`scrollWidth=375`。full-page PNG 分别为 `1425×4093`、`375×4276`，15px 差异来自 Chromium 滚动条。
- 为获得精确交付宽度，项目 Playwright page context 以同一 viewport 重采集 `.impeccable/mocks/review/landing-desktop.png` 与 `landing-mobile.png`；实际像素为 **1440×4093**、**390×4205**。

### 验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test:web` | 5 files / 10 tests passed |
| `pnpm lint:web` | exit 0 |
| `pnpm build:web` | exit 0 |
| `PLAYWRIGHT_PORT=3004 pnpm test:e2e` | 13 passed / 7 skipped / exit 0 |
| `git diff --check` | exit 0 |
| `rg -n "4e302c13|unreviewed and undocumented is unfinished" apps/web` | 3 命中 |
| `embed-prompt.mjs ... --read` 与 approved jq | exit 0 / `true` |
| schema jq | 严格顶层键、schemaVersion 2、5 个 `ds-*` 组件均为 `true` |
| colorMeta jq | 9 个 DESIGN 颜色均有对应项且 tonalRamp 长度为 8；amber / amber-ink 合同为 `true` |
