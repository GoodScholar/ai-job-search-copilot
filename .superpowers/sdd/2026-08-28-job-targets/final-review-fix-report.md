# Issue #6 final review fix wave report

Base reviewed: `12dee33ba9b0098e024181ce8741e382c0d0e1d6`.

## RED

在修改生产代码前，新增两个可观察的回归断言并执行：

```bash
DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test -- job-targets
```

实际输出：`src/job-targets.test.ts` 的新用例失败；期望 `['前端工程师', '全栈工程师', 'AI 应用工程师']`，实际只得到 `['前端工程师', '全栈工程师']`。汇总为 `1 failed | 9 passed` 测试文件、`1 failed | 85 passed` 测试。

```bash
pnpm --filter web test -- job-targets-view.test.tsx
```

实际输出：组件用例失败，找不到标题“候选岗位方向”及表单可访问标签“目标岗位方向”；渲染结果仍为“候选方向”和“角色族”。汇总为 `2 failed | 123 passed` 测试、`1 failed | 26 passed` 测试文件。

## GREEN

最小实现保留按直接关键词匹配分数的排序；当至少有一条当前可信事实且直接匹配少于三项时，按目录顺序补足相邻方向。补足项只引用传入的当前事实/revision，并明确要求用户确认；函数仍为纯读取，不写入求职目标。

```bash
DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test -- job-targets
```

实际输出：`10 passed` 测试文件，`86 passed` 测试。

```bash
pnpm --filter @job-copilot/domain typecheck
```

实际输出：`tsc --noEmit`，退出码 `0`。

```bash
pnpm --filter web test -- job-targets-view.test.tsx
```

实际输出：`27 passed` 测试文件，`125 passed` 测试。

```bash
pnpm --filter web typecheck
```

实际输出：`next typegen && tsc --noEmit`；`✓ Types generated successfully`，退出码 `0`。

```bash
pnpm --filter web test:e2e -- job-targets.spec.ts
```

实际输出：Playwright 启动隔离运行时后，岗位目标的桌面浏览器用例通过：`✓ [Desktop Chrome] e2e/job-targets.spec.ts … (3.0s)`。运行结束后 `apps/web/test-results/.last-run.json` 为 `{"status":"passed","failedTests":[]}`。该脚本在当前配置中执行完整的 44 项 Playwright 配置。

## Changed files

- `CONTEXT.md`：按裁定文本新增唯一的“候选岗位方向”术语。
- `packages/domain/src/job-targets.ts`：补足相邻候选岗位方向，保持直接匹配排序与真实证据引用。
- `packages/domain/src/job-targets.test.ts`：覆盖 React/TypeScript 可信画像返回三项、直接匹配优先、回退理由与证据。
- `apps/web/components/workbench/job-targets-view.tsx`：将候选区和输入标签替换为“候选岗位方向”及“目标岗位方向”。
- `apps/web/components/workbench/job-targets-view.test.tsx`：更新可访问标签并覆盖候选区标题。
- `apps/web/e2e/job-targets.spec.ts`：更新页面标题和输入标签断言。

## Self-review

- 无当前可信事实时仍返回空建议；至少一条事实时返回 3–4 个目录项。
- 直接匹配排在前面，并且仅使用匹配的事实/revision；相邻补足项使用真实当前事实/revision，并明确不是已证实匹配。
- `roleFamily` 合同字段未变；未添加写入、副作用或 ADR；未处理 deferred Minor。
- `rg` 确认本功能相关 Web 源码、组件测试和 Playwright 用例中不再出现“角色族”或“候选方向”。
- `git diff --check` 通过。

## Concerns

- 无功能性顾虑。端到端运行出现既有环境警告（`NO_COLOR` 与 PostgreSQL 标识符截断 NOTICE），但 Playwright 结果为通过；本次未修改这些无关基础设施项。

---

## Additional scoped re-review fix

Base reviewed: `8ff6b1dcec3a44ddef611945fb4e0bd4743b3ef5`.

### RED

在生产代码改动前，扩展真实公开查询 seam `createJobTargetQueries({ db }).getOverview` 的集成测试：为一个求职账户写入 21 条当前、可信、但不匹配目录关键词的 skill 事实，再读取 overview。

```bash
DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test -- job-targets
```

实际输出：新用例失败于 `overview` 的 `JobTargetOverviewSchema.parse`。三个回退建议均报告 `Too big: expected array to have <=20 items`，路径分别为 `suggestions[0..2].evidence`；汇总为 `1 failed | 86 passed` 测试。该失败证明 21 条未匹配可信事实会阻断 overview 返回，而不是仅在私有帮助函数中产生不规范数据。

### GREEN

最小修复仅将回退建议的 evidence 从全部当前事实限制为第一条真实当前事实。直接匹配的 evidence、按分数排序和 3–4 项候选数量逻辑均未改变；契约上限没有放宽。

```bash
DOCKER_API_VERSION=1.51 pnpm --filter @job-copilot/domain test -- job-targets
```

实际输出：`10 passed` 测试文件，`87 passed` 测试。

```bash
pnpm --filter @job-copilot/domain typecheck
```

实际输出：`tsc --noEmit`，退出码 `0`。

### Changed files

- `packages/domain/src/job-targets.ts`：将回退建议的真实 evidence 限制为一条。
- `packages/domain/src/job-targets.integration.test.ts`：通过公开 overview 查询覆盖 21 条以上未匹配可信事实。
- `.superpowers/sdd/2026-08-28-job-targets/final-review-fix-report.md`：追加本轮证据与自审。

### Self-review

- 新测试通过数据库与 `getOverview` 公共路径验证，不依赖实现细节或 mock。
- 回退 evidence 始终为真实当前事实，且最多一条，满足 `max(20)` 与非空证据要求。
- 无事实时仍不生成建议；直接匹配的 evidence 和排序路径未修改；回退仍保持既有目录顺序和最少三项语义。
- 未修改 contracts、API、Web 或 deferred Minor；`git diff --check` 通过。

### Concerns

- 无功能性顾虑。PostgreSQL 测试容器仍输出既有外键标识符截断 NOTICE；测试结果为通过，未扩展修复范围。
