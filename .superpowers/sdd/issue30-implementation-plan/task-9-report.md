# Task 9 / Slice 8 实施报告

基线：`4473524`。本 Slice 未推送、未创建 PR、未合并。

## TDD 提交

- `c70dfe2`：初始 Worker runtime wiring Red。
- `e33db6b`：Round 1 config、Greenhouse retry、对象 key Red。
- `4932852`：跨包 config、schedule/UI 语义 Red。
- `ab0fa0d`：进程重建后 pending Lead capability recovery Red；在 live search 变为 clean-zero 时旧实现确实错误返回 `clean_zero`。
- 本提交：最小 Green/Refactor，包含 claim-bound recovery、严格配置、schedule/UI、retry 与 owner namespace 收紧。

此前误启动的两套并发测试 PID（`83635/83658/83664` 与 `83796/83797/83819/83826`）的证据已作废；其后所有本 Slice 命令均按单进程串行运行。

## Runtime matrix

| 环境 | 允许配置 | execution mode |
| --- | --- | --- |
| production | 不允许 `PUBLIC_JOB_DISCOVERY_ADAPTER`、E2E scenario 或 provider/base override | `layered_public` |
| local | 仅 `PUBLIC_JOB_DISCOVERY_ADAPTER=greenhouse` 可选 v3 | `fake` / `greenhouse` |
| test | E2E scenario 与 transport/base 注入仅此处允许 | `fake` / `greenhouse` |

未知值、production fake/greenhouse、非 test scenario/base override 均稳定抛出 `JOB_DISCOVERY_RUNTIME_CONFIG_INVALID`，错误不包含配置值或 key。

## 关键边界

- pending Lead 恢复由 domain repository 以 owner/run/query/fingerprint/lead/claim/expiry 校验；Worker 仅在一次 extract 内取得布尔授权闭包，不能持有 repository 或跨进程 Map capability。
- AnySearch key 缺失不 checkpoint、不传输；可信 Greenhouse 成功仍可完成为带 source issue 的终态。
- v4 无 Watchlist 对 UI 报告 `executable: 0`，但 profile 缺失拒绝启用并在补全后可重试；既有 v3 Greenhouse 语义未改。
- Greenhouse v4 adapter 使用 `retry: "none"`；run attempt 仍是唯一重试权威。trusted 原始对象在 `accounts/{userId}/agent-runs/...` 下。

## 串行验证

- Worker focused：22 tests。
- Domain workflow/schedule/processor/Lead focused：94 tests；Lead repository integration：10 tests。
- API focused：7 tests；Web focused：16 tests；Contracts focused：3 tests。
- Contracts/API/Domain/Worker/Web typecheck 全通过。

完整包级回归、Drizzle check 与最终 diff/clean 检查在本提交后续收尾执行并记录于最终验收。
