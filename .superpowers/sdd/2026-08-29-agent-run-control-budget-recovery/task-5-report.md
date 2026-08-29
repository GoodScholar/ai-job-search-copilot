# Task 5 report — mission control and Inbox

## Design pass

- **对象与单一工作：** 面向普通求职者的岗位发现任务控制台；用户在此只需看清一次运行的进度、预算和待处理事项，并能安全地暂停、继续或取消。
- **既有账本 token：** `--ground #f5f1e8`（纸张底）、`--surface #fffdf7`（票据面）、`--ink #17231f`（正文）、`--muted #64726a`（说明）、`--emerald #25745a` / `--emerald-strong #14523d`（可操作事实）、`--amber #c68b2f` / `--amber-ink #805100`（等待或风险）。不引入渐变或新品牌色。
- **字体角色：** 沿用全站既有正文/标题字体；大标题只用于工作台入口，面板标题为紧凑粗体，预算和运行序号使用 tabular numerals，避免把数据当作装饰性大数字。
- **布局线框：**

  ```text
  [运行选择与启动]
  [状态文字 | 暂停 / 继续 / 取消]
  [执行规格与预算分录（dl）]
  [时间线]
  [本次结果]
  [Agent Inbox：每项为 article + 明确动作]
  ```

- **signature：** 预算不是仪表盘，而是一组带“已用 / 上限”文字的账本分录；它把任务、预算与待处理事项连成一个可核对的行动记录。
- **自检与取舍：** 已去除英雄数据、渐变、圆角卡片堆叠、装饰性图标和无意义动画。色彩仅辅助状态，文字状态、定义列表、按钮标签和结果消息承担实际语义。

## RED

- `pnpm --filter web typecheck`：失败（Task 4 明确递延的 3 项）：`maxActiveDurationMs` fixture 旧字段、4 个模型失败码未覆盖、`timelineLabel` 非穷尽返回。
- 待补 UI RED：页面四请求并行、运行详情/安全控制/SSE、Inbox 4 个动作及幂等重试。

## GREEN

- 首页并行读取工作台、目标、最新运行和开放 Inbox，并将严格 DTO 传给视图。
- 运行面板渲染执行规格、来源/步骤、规则、Adapter、工具白名单、模型未使用说明及预算分录；`queued`、`running`、`paused` 均阻止再次启动。
- 控制命令按动作保留 UUID；网络失败复用，成功或 409 冲突才清理。取消请求更新后不会显示继续；暂停/终态 SSE 关闭后重读权威详情。
- Inbox 用 `article` 呈现，统一支持重启、继续、取消、标记已处理；预算事项保留“调整求职目标”链接，导航本身不解决事项。

## Verification

- `pnpm --filter web test -- components/workbench/agent-run-panel.test.tsx components/workbench/agent-inbox-panel.test.tsx components/workbench/workbench-home-view.test.tsx 'app/(workbench)/home/page.test.tsx'` — 42 files / 201 tests passed。
- `pnpm --filter web typecheck` — passed（Task 4 递延的 3 个错误已关闭）。
- `pnpm --filter @job-copilot/contracts typecheck` — passed。
- `git diff --check` — passed。

## Concerns

- Task 6 仍负责真实 Web/API/Worker 的 Playwright 暂停、取消、重试和预算耗尽验收；本 Task 仅覆盖组件与页面边界。
