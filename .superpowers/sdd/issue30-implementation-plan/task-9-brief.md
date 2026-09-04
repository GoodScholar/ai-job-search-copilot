# Task 9 / Slice 8 Brief：v4 Runtime 与调度接线

## 目标与基线

以 Slice 7 双轴 `0/0/0` 的 clean 提交 `4473524` 为起点，把已经完成的
`layered-public-job-discovery-v1` 接入 API/Worker production runtime 与 schedule。固定最终审查基线仍为
`3a1a3940773921a1a03c3b25ea7baa378c025e83`。

本 Slice 只负责新 run 的 v4 immutable snapshot/spec、Worker production resolver/module/config 和既有 schedule
派发到同一 v4 starter。Fake AnySearch local runtime 与 Playwright 属于 Slice 9，不得在本 Slice 提前实现。

## 冻结兼容边界

1. `JobDiscoveryExecutionMode` additive 增加明确的 v4 mode；production 的 API 与 Worker 必须一致选择 v4。
   既有默认 test fake、v1/v2 recovery、v3 source-health 专用 test/local phase 保持原样。不得把旧
   `greenhouse` mode 改名或改写成 v4，也不得改写旧 adapter 的输入输出。
2. 新建 manual 与 scheduled run 共用 `createAgentRunCommands` 的同一 v4 spec builder；schedule 不复制 query
   planner 或 snapshot 逻辑。幂等 occurrence 重放仍返回同一 run/spec。
3. v4 run 创建事务冻结当前 target/profile/watchlist 版本：
   - target 仍只允许当前 active target revision；
   - profile snapshot 只投影当前 profile version 和最多 10 个当前 active、已确认的 skill `name`，稳定去重/
     排序；不得投影姓名、联系方式、完整画像或其他 fact value；
   - 无 Watchlist 时冻结 `{ version: 0, companies: [] }`，仍生成 general + 四个固定 site query；只有
     `target_company` query 依赖 Watchlist；
   - Watchlist 公司只来自当前 revision 中经既有公开来源策略批准的公司/域，并冻结 item ID、canonical name、
     approved domains；页面、provider 返回或自由文本不得扩权。
4. source scope 必须是 `layered_public`：trusted Greenhouse sources 是既有批准 source 的 v4 wrapper 投影；
   public discovery 只调用 `createAnySearchQueryPlan`，并持久化完整 v4 constants、profile/watchlist snapshots、
   query plan 与 budget。旧 v1-v3 fixture/parser/recovery 必须继续 Green。

## Production resolver 与安全组装

1. Worker 新增一个强类型 `LayeredPublicJobDiscoveryWorkflowResolver`，只接受冻结 v4 spec。它负责组装：
   - Greenhouse trusted wrapper：复用既有 Greenhouse adapter/persistence seam，通过 v4 wrapper 接入；不得修改旧
     adapter 契约，不得写 AnySearch 诊断到 `job_source_health_checks`；
   - `AnySearchPublicJobAdapter`：只从 runtime `ANYSEARCH_API_KEY` 读取 key。缺失/空白时 adapter 返回
     `ANYSEARCH_NOT_CONFIGURED`，绝不发匿名请求；production base URL 固定，只有既有 `APP_ENV=test` seam
     可注入 transport/base URL；
   - shared secure preflight/fetcher、内部 claim-bound Lead repository 与 Verified Gate、同一个 MinIO evidence
     store。不得绕过 `preflight -> extract -> local fetch -> final validate -> gate`。
2. `AgentRunModule` 必须向 processor 注入 v4 resolver，同时保留 legacy adapter resolver 与 v3 source-health
   resolver。module lifecycle 继续由现有 owner 关闭 DB/Redis/consumer；不得新增重复 destroy hook。
3. runtime config 必须 fail closed：未知 execution mode、test-only scenario 出现在 local/production、任意
   provider base override 出现在非 test 都拒绝。日志/错误不得包含 API key、provider body、query、URL 或用户事实。
4. trusted wrapper 和 AnySearch 分支共享 processor 的 AbortSignal/checkpoint authority。每个真实 Greenhouse
   list/detail、AnySearch search/extract 与 local fetch 仍分别 reserve/checkpoint；本地拒绝、缺 key和 replay
   不伪造物理请求。不得在 resolver 内增加隐藏 retry、batch 计费折算或进程内 capability 恢复。

### Greenhouse v4 wrapper seam 裁决

现有 Greenhouse port 只返回 list/detail，旧 persistence 又绑定 v1-v3 processor 终态，不能直接拼接。Slice 8
获准做以下 additive 抽取；这是已批准 v4 wrapper 的实现 seam，不是旧契约改写：

1. 新增一个 domain-owned v4 runtime factory，内部组装 claim-bound Lead repository 与 Verified Gate；Worker 只
   注入 provider/source-access/content-store ports，不直接获得或公开 `recordPendingForClaim`、
   `verifyForClaim`、`rejectForClaim`。
2. 从既有 trusted persistence 抽出窄的 claim-bound bridge：只持久化真实 Greenhouse Source Posting/Version 和
   既有 trusted Opportunity 语义，并返回 owner/run-bound Source Posting Version IDs。它必须在同一 account-lock
   transaction 校验 v4 run、claim token、DB current time、`controlState=none` 与 frozen trusted source；replay
   幂等并返回重复对象清理键。
3. 该 bridge **不得**终结 Agent Run、推进旧 step、写 `agent_run_job_results` 或 v4 run results、写
   `job_source_health_checks`、写 diagnostic/source issue/attention。v4 results 与终态仍只由 Slice 7
   `persistLayeredPublicOutcome` 持久化。
4. v4 trusted wrapper 可适配既有逐来源 Greenhouse list/detail port；每个真实 list/detail 调用前调用 workflow
   的 `beforeRequest`，局部失败只转换为脱敏 Greenhouse source issue。旧 v1-v3 adapter class、输入输出、resolver
   与 processor 分支保持原样。

## 终态与 schedule 验收语义

1. v4 run 即使无 Watchlist 也可入队并执行 general/site discovery；v3 `greenhouse` mode 仍可因无受支持
   Watchlist 来源而保持其原有 `AGENT_RUN_UNAVAILABLE` 语义。
2. 同一 v4 run 中 Greenhouse 成功、AnySearch key 缺失：必须 `completed_with_source_issues`，聚合一个
   `ANYSEARCH_NOT_CONFIGURED` provider diagnostic/source issue/attention；没有匿名 transport 调用。
3. scheduled occurrence materialize/dispatch/recovery 保持 owner-bound、exactly-once/idempotent；其 run 的
   workflow/spec 必须与同 target 同版本的 manual v4 run 等价，trigger/occurrence 事实除外。
4. v4 runtime 仍必须允许 trustedSources 为空；不能为了生产接线恢复 Watchlist-only discovery。

## TDD 切片（必须保留真实 Red）

1. **Red A — execution mode/spec snapshot。** 扩展 domain execution-mode 与 agent-run-control integration：
   production 选择 v4；manual/schedule 冻结 v4 target/profile/watchlist/query plan；无 Watchlist 仍有 5 条
   general/site query；profile/Watchlist 改版只影响新 run，replay 不变；隐私字段不进入 spec。
2. **Red B — Worker resolver/config。** 在公开 Worker seam 断言 production v4 resolver 可解析 v4 spec；缺 key
   返回 NOT_CONFIGURED 且 transport 0 调用；fake/v3 phase 和 v1-v3 resolver fixtures 不变；非 test base/
   scenario override fail closed。
3. **Red C — production module integration。** 通过 Nest provider/真实 PostgreSQL/Redis/MinIO focused integration
   证明 module 向 processor 注入 v4 resolver，manual 与 scheduled v4 run 可被消费；同 run 组合 trusted +
   AnySearch，缺 key 不阻断 trusted success。
4. **Red D — schedule/recovery。** 证明 occurrence dispatch 创建 v4 spec、重复 dispatch/reconciler 不重复 run/
   query/usage/diagnostic/attention；无 Watchlist schedule 仍可执行 general/site。
5. **Refactor。** runtime wiring 只负责对象组装；snapshot/query 构造留在 domain，provider I/O 留在 adapter，
   orchestration 留在 Slice 7 deep module。若需要新增 seam，必须窄接口、可注入且只服务以上验收。

## 验收与报告

- 每个 Red 先记录失败命令/原因并提交，再做最小 Green/Refactor；不得用先实现后补测冒充 TDD。
- 严格串行运行 execution-mode、agent-run-control、schedule、Worker resolver/module/integration focused tests；再运行
  domain 与 worker 全包测试、相关 v1-v3 fixture 回归、六包 typecheck、Drizzle check 与
  `git diff --check 4473524..HEAD`。
- 新建 tracked `task-9-report.md`，如实记录 Red/Green commit、命令、测试计数、runtime env matrix、已知边界。
- 提交全部 intended diff，最终 `git status --short` 为空；不得 push、PR、merge。
- 完成后由 `gpt-5.6-sol/high` 对 Slice 8 做独立 Standards/Spec 双轴审查，修复全部等级至 `0/0/0` 后才进入
  Slice 9。
