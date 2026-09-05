# Task 3 执行报告：模型连接诊断页面

## 范围

- 新增安全的 server client、`/api/model-diagnostics` BFF 与 `/profile/model-connection` 页面。
- 首页“运行设置”新增“检查模型连接”入口，保留既有运行策略入口。
- 页面只展示稳定中文诊断状态、四项检查、原因、影响、建议、检查时间、延迟档位和退避信息；不展示密钥、供应商账户、组织/项目、配置指纹或模型标识。
- E2E 运行时仅在 `APP_ENV=test` 接受受控模型诊断场景；运行时启动前清除全部 `OPENAI_*` 配置，避免测试机访问真实模型。

## TDD 记录

- RED：`pnpm --filter web test -- lib/server/model-diagnostics.test.ts app/api/model-diagnostics/route.test.ts "app/(workbench)/profile/model-connection/page.test.tsx" components/workbench/model-connection-view.test.tsx components/workbench/workbench-home-view.test.tsx`，退出码 1；4 个新模块尚不存在，首页入口断言失败。
- GREEN：同一目标集在实现后通过，73 个文件、388 个测试，退出码 0。
- 补充 RED：卸载进行中的 POST 时 `AbortSignal.aborted` 为 `false`，`model-connection-view.test.tsx` 退出码 1。
- 补充 GREEN：保存请求控制器并在卸载时 abort 后，73 个文件、389 个测试，退出码 0。
- lint 先后定位渲染期 `Date.now()` 和 effect 同步 setState；重试退避改为仅由定时回调更新的已过期 retryAt 标记。最终 Web 测试 73 个文件、389 个测试，退出码 0，无 TimeoutOverflowWarning。

## 验证

所有测试命令串行执行；每次前后以 `ps -axo pid=,command= | rg '[v]itest|[p]laywright|pnpm.*test|local-runtime' || true` 确认没有残留。没有重叠测试。

- `pnpm --filter web test`：73 files / 389 tests，exit 0。
- `pnpm --filter web test:e2e -- model-diagnostics.spec.ts`：三组隔离 Fake phase（success、authentication_failed、provider_unavailable）均 passed；每组 Desktop Chrome + Mobile Safari，exit 0。覆盖从 `/home` 入口、触发及刷新后的 stable available、稳定失败和暂不可用建议、键盘焦点、axe、390px 横向溢出检查。
- `pnpm test:runtime`：40 passed，exit 0。
- `DOCKER_API_VERSION=1.51 pnpm -r --workspace-concurrency=1 --if-present test`：exit 0；临时退出码文件 `/tmp/issue50-workspace-tests.exit` 为 `0`。
- `pnpm typecheck`：exit 0。
- `pnpm build`：exit 0，包含 `/api/model-diagnostics` 与 `/profile/model-connection`。
- `pnpm lint`：exit 0。

## 视觉 QA 和 Impeccable

- 已按 Operate/impeccable context 约束复用 workbench ledger、按钮与 focus 视觉语言。
- Impeccable detector 仅运行一次：`node /Users/shen/.skills-manager/skills/impeccable/scripts/detect.mjs --json apps/web/app/'(workbench)'/profile/model-connection/page.tsx apps/web/components/workbench/model-connection-view.tsx apps/web/components/workbench/workbench-home-view.tsx apps/web/app/globals.css`。唯一 `side-tab` warning 位于既有 `globals.css:1283`，不属于本次目标；本次新增规则无发现。
- 已人工检查成功场景桌面与移动截图：窄屏单列、无横向溢出、触控按钮符合既有 44px 规则，状态文本不依赖颜色。

截图目录：`/tmp/issue50-validation-20260905/`

- `success-desktop-chrome.png`
- `success-mobile-safari.png`
- `authentication_failed-desktop-chrome.png`
- `authentication_failed-mobile-safari.png`
- `provider_unavailable-desktop-chrome.png`
- `provider_unavailable-mobile-safari.png`
