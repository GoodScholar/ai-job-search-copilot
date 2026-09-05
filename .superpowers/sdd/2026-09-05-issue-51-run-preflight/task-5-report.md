# Issue #51 Task 5 执行报告

## 实现

- 新增认证的 `GET /v1/run-preflight`：严格 query、无 `scheduledFor`、`Cache-Control: no-store`，仅调用领域只读 query。
- `ModelDiagnosticsModule` 公开 projection reader；API 的 test adapter 使用与 Worker 一致的稳定 fingerprint `job-copilot-test-deployment-v1`，生产仍由真实 OpenAI 配置派生。
- `RunPreflightModule` 组装 Greenhouse capability adapter、projection reader 与当前 execution mode，并将同一个 `RUN_PREFLIGHT_EVALUATOR` 显式注入 Agent Runs 与 Recommendations 两条手动路径。
- 已知 `RunPreflightRejectedError` 映射为严格 409；filter 运行时只白名单 `dependencies`、`issues`、经 schema 校验的 `preflight`，不会输出异常、stack 或任意附加字段。
- Web ApiClient、BFF 与 server action 只对严格的预检 409 保留报告；未知 409 仍为 502。重新评估 action 返回判别 union，并传递原幂等键和可空 fingerprint。

## RED / GREEN

### RED

```text
API：run-preflight controller 文件不存在；既有 API integration 因手动路径没有 preflight composition 而 500。
Web：ApiClient 缺 getRunPreflight；BFF 缺 route；409 和 server-action 判别分支失败。
```

### GREEN

```text
API 定点：6 files / 87 tests passed
Web 定点：5 files / 41 tests passed
```

## 最终串行验证

```text
pnpm --filter api exec vitest run --no-file-parallelism \
  src/run-preflight/run-preflight.controller.test.ts \
  src/recommendations/recommendations.controller.test.ts \
  src/common/api-problem.filter.test.ts \
  src/model-diagnostics/model-diagnostics.controller.test.ts \
  src/agent-runs/agent-runs.module.test.ts src/api.integration.test.ts
# 6 files / 87 passed / exit 0

pnpm --filter web exec vitest run --no-file-parallelism \
  lib/server/api-client.test.ts lib/server/run-preflight.test.ts \
  app/api/run-preflight/route.test.ts app/api/agent-runs/route.test.ts \
  'app/(workbench)/recommendations/actions.test.ts'
# 5 files / 41 passed / exit 0

pnpm --filter api typecheck
pnpm --filter web typecheck
pnpm --filter worker typecheck
git diff --check
# all exit 0
```

## HTTP 安全扫描

对新增/变更 HTTP 边界扫描 `stack|careersUrl|allowedDomains|configurationFingerprint|apiKey|providerResponse|rawPayload|rawJobDescription`，无命中；响应只使用 contracts 的预检安全投影。集成覆盖未认证、`no-store`、未知 query 和伪造 `scheduledFor`。

## Composition / fingerprint

- API 明确通过 `RUN_PREFLIGHT_EVALUATOR` provider 注入 discovery 与 deep-match；无生产 ready fallback。
- projection reader 和 diagnostics service 复用同一 adapter fingerprint；API test seed 为 `job-copilot-test-deployment-v1`，与 Worker 一致。
- 修复了 API composition 中未绑定 `crypto.randomUUID` 回调导致首次策略基线创建异常的问题。

## 文件与疑虑

本任务变更位于 `apps/api/src/run-preflight/`、Model Diagnostics/API controller/filter/module、Web ApiClient/BFF/action 及相应测试。为保持已有页面 action 的 void prop 约束，页面只 await action 结果；不展示 blocker/warning UI（Task 6 范围）。

工作树原有 `task-4-report.md` 未提交改动已保留且不会纳入本任务 commit。
