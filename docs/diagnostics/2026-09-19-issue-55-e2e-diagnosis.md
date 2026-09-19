# #55 验收失败：诊断与修复记录（2026-09-19）

最终结果：原 6 个 E2E 失败实例已处理，追加发现的既有模型诊断读锁竞争已修复。最新代码默认三阶段 E2E 共 128 passed / 26 按阶段 skipped，串行、单 worker、零 retry，退出 0。E2E 改为 Webpack 预构建与 next start，隔离 Turbopack 热编译崩溃；未修改上游 Turbopack 实现。

前半部分保留首次诊断时的历史结论（其中“未决”“未修复”指当时状态）；用户追加“全部修复”后的变更和最终验证见末尾“修复阶段”。

## 范围与对照

- 当前提交：`2d38fd215d82ae184aca2f903e4ce2b2d5aa629a`。
- 基线提交：`644dfbe52a4a681f6df316d68cb352d11b076e6c`，独立 worktree、独立 workspace 包链接。
- 两边 lockfile 与 Web package 配置相同；Next 16.3.2、Playwright 1.63.0、Node v24.20.0、pnpm 11.5.2。
- 原 6 项是普通 E2E 矩阵的失败实例（全局停止在两个浏览器各失败一次），不是 6 个独立根因。原 Webpack 验收为 112 passed / 6 failed / 12 skipped；wrapper 随即终止，不能据此声称后续 source-health/inbox phase 已覆盖。
- 本轮所有测试串行、单 worker、零 retry。Webpack 是临时实验配置；每轮结束恢复 package.json。生产代码未修复，原有文档改动保留。

## 已确认结论

| 原失败实例 | 基线/当前对照与最小复现 | 分类 | 建议范围 |
|---|---|---|---|
| Desktop auth 导航链接歧义 | 原测试两提交均失败；基线等“开始推荐”出现后，仅查找 name=推荐 即稳定 strict mode violation，2/2；exact=true 后 2/2 通过 | 既有测试定位缺陷，触发受页面加载时序影响 | 精确匹配或限定导航区域，保留键盘焦点验证 |
| Desktop 全局停止 | 两提交原测试均返回 cancelled；去掉历史 A 和全部 UI 后，真实 API 排队 B→全局停止仍返回 cancelled，2/2 | 既有 E2E 期望与领域契约冲突 | 重写场景使之符合“排队任务取消、解除不复活”的契约 |
| Mobile 全局停止 | 同上；原测试两个提交、两个浏览器一致 | 同一既有测试缺陷的第二个实例 | 与 Desktop 共用修正 |
| Mobile 导入缺少“规范化中” | 当前自然复现转为 Desktop 失败；首次详情 GET 已是 completed。基线把详情请求延迟 1500ms 后同症状 2/2；规范化窗口 750→3000ms 后 2/2 可见中间态 | 既有测试的时序依赖；未见规范化功能失败证据 | 确定性控制中间态；最终成功测试不要求捕捉每个短暂状态 |
| Mobile 每日推荐导航被 /home 打断 | 两提交首次定向重跑通过；当前追加 5 次均通过 | 未决：有导航竞争迹象，尚不能定性为测试问题或产品缺陷 | 保留 trace，进一步建立刷新/RSC/整页导航的因果链 |
| Mobile Inbox 链接未到画像 | 两提交首次定向重跑通过；当前追加 5 次均通过 | 未决：尚未建立最小复现 | 同上，不能仅靠重试隐藏失败 |

### 全局停止为何不能只改一个字符串

`packages/domain/src/account-run-control.ts` 对 queued/running 调用 cancel；既有 `account-run-control.integration.test.ts` 已要求 queued→cancelled、running→cancel_requested，并保留预先 paused 和终态运行。原 E2E 明确先断言 B 为 queued，却要求全局停止后 paused、解除后继续旧 B。仅把 paused 改成 cancelled 会留下后续语义冲突。修复应验证历史 A 保留、B 取消、解除不恢复 B；如需验证手动继续，应单独构造预先 paused 的运行。

### 导入的最小证据

当前自然失败 trace 的第一次详情请求发生于 `2026-09-19T10:22:32.248Z`，响应已经是 `completed`，没有读到 normalizing。UI 立即读取一次，之后以 1000ms 轮询；测试规范化延迟仅 750ms。因此最终成功并不保证浏览器一定观察到中间态。

基线的 1500ms 延迟是**受控延迟注入**，不是自然失败频率统计。它在同一读取边界复现漏采；延长规范化时间是验证原因的反事实实验，不是建议生产代码增加 sleep。导入组件在 #55 仅增加岗位管理链接，轮询逻辑未改。

### 导航证据的边界

原完整日志包含 `Failed to fetch RSC payload ... /home. Falling back to browser navigation`、`The destination stream closed early`，以及 target goto 被另一条 /home 导航中断。当前首页的 online 回调与运行更新回调均会触发 router.refresh；这提供了待验证的路径，但不能据源码和错误文案断言根因。

## 实验记录

原失败涉及的 5 个 E2E 文件在两个提交之间未变；这仅辅助定位，不能独立排除业务回归。

| 实验 | 结果 |
|---|---|
| current-webpack：5 个标题 × 2 浏览器 | 6 passed / 4 failed：auth、Desktop import、双浏览器 global-stop |
| baseline-webpack：同样范围 | 7 passed / 3 failed：auth、双浏览器 global-stop |
| baseline-minimal：初版缩小实验 | 4 passed / 2 failed：只有 queued-stop；暴露 auth 需要等待内容加载、导入需要固定采样窗口 |
| baseline-minimal-pinned：3 场景各 2 次 | 6 failed，分别命中链接歧义、漏采中间态、paused/cancelled 冲突 |
| baseline-counterfactual：每个独立场景只改一个变量 | 6 passed |
| current-navigation-repeat：2 个 Mobile 导航场景各 5 次 | 10 passed；不代表原失败已修复 |
| current-turbo-journey / baseline-turbo-journey：4 场景各 2 次 | 两边各 8 passed，无原 panic |
| current-turbo-prefix：保持原 Desktop 第 1–22 项顺序 | 22 passed，无原 panic |

## 可复跑命令与证据位置

本机实验脚本和日志位于 `/tmp/issue55-diagnosis/`；该目录是临时诊断资料，未提交。`run.py` 保存每轮日志与退出状态，`probe.py` 在现有测试 helper 上追加最小用例并在 finally 中恢复文件。trace 可能包含测试会话凭据，不应直接公开上传。

```sh
BASELINE='/Users/shen/.codex/worktrees/diagnose-issue55-baseline/AI Job Search Copilot'
CURRENT='/Users/shen/SZG/AI Agent/AI Job Search Copilot'
# 严格串行执行，每条命令等待结束。
python3 /tmp/issue55-diagnosis/run.py "$CURRENT" current-webpack
python3 /tmp/issue55-diagnosis/run.py "$BASELINE" baseline-webpack
python3 /tmp/issue55-diagnosis/probe.py "$BASELINE" baseline-minimal-pinned
python3 /tmp/issue55-diagnosis/probe.py "$BASELINE" baseline-counterfactual --counterfactual
python3 /tmp/issue55-diagnosis/run.py "$CURRENT" current-navigation-repeat --grep '每日推荐通过 Fake Worker|从首页将候选事实由未读' --project 'Mobile Safari' --repeat 5
```

证据文件：各实验同名 `.log`、`-exit.json`、`-results/`；原失败快照保存在 `original-test-results/`。原完整验收日志为 `/tmp/issue55-e2e-webpack-full.log`；原 Turbopack 崩溃日志为 `/tmp/issue55-e2e-final.log`。

## Turbopack 对照

原始失败是 Rust `aggregation_update.rs:2021` 的 `inner_of_upper_lost_follower ... make_chunks` panic，随后进程 Aborting；不是普通 E2E 断言超时。原日志提示开启 RUST_BACKTRACE，本轮重放已设置该变量。

两个提交均以原默认 Turbopack 模式运行首次推荐旅程的 4 个场景，每个重复 2 次：**current 8 passed / baseline 8 passed**，未观察到同一 panic。两个提交都出现过 `The destination stream closed early`；它没有导致这两轮失败，所以不能把此消息单独当成 crash 判据。

随后按原顺序补跑当前版本 Desktop 第 1–22 项（账户策略、运行控制、认证、Watchlist、DOCX、首次推荐旅程），22 passed，用时 3.6 分钟，仍未重现 panic。auth 在这一轮通过也符合其触发受内容加载时序影响的观察。

这尚未建立 Turbopack 的最小复现。重放没有重建原崩溃当时的 `.next` 缓存或历史任务图；锁文件相同也不足以排除由新增模块触发的构建器问题。不能宣称“已知上游缺陷”或“与 #55 无关”，也没有依据直接升级 Next、永久切换 Webpack 或回滚 #55。

```sh
RUST_BACKTRACE=1 python3 /tmp/issue55-diagnosis/run.py "$CURRENT" current-turbo-journey --mode turbo --grep '首次推荐旅程|可信非空推荐|零接受推荐清单' --project 'Desktop Chrome' --repeat 2
RUST_BACKTRACE=1 python3 /tmp/issue55-diagnosis/run.py "$BASELINE" baseline-turbo-journey --mode turbo --grep '首次推荐旅程|可信非空推荐|零接受推荐清单' --project 'Desktop Chrome' --repeat 2
```

## 修复范围决策

1. 首批只修 3 个 E2E 场景：auth 定位、global-stop 语义、import 状态观察。这覆盖原 6 个失败实例中的 4 个。测试修改仍需回到原完整场景验证，不能把最小实验通过当成验收完成。
2. 不改全局停止业务语义，不要求产品为了测试延长规范化，不为未复现的导航问题添加重试或固定等待。
3. 两项导航与 Turbopack 单独保留未决记录；没有证据把它们认定为 #55 回归，也没有证据宣布已经排除 #55 的影响。
4. 本轮遵循“先诊断、再决定范围”，未进入业务修复或提交阶段。已确认项可以独立修正；未决项继续保留验收缺口。

## 未决项的后续诊断边界

- **两项导航：** 仍缺少失败当次带时间线的 trace。下一次重现应同时保留主框架 navigation、RSC request/response/requestfailed 与用户点击时刻；用在线恢复或运行完成触发的真实 refresh 做受控延迟实验。只有确认哪次 refresh/fallback 覆盖哪次导航，才决定改测试同步还是产品导航行为。本轮没有足够证据作这个决定。
- **Turbopack：** 精确症状判据必须是相同 Rust panic 与服务退出。下一次出现时应保留 RUST_BACKTRACE、触发路径和当时缓存，再以冷缓存/保留缓存为单一变量对比两个提交。本轮没有该崩溃瞬间缓存，未能得到稳定最小复现；不能把多轮通过当作修复证明。

补充重放命令：

```sh
RUST_BACKTRACE=1 python3 /tmp/issue55-diagnosis/run.py "$CURRENT" current-turbo-prefix --mode turbo --grep 'account-run-policy.spec|agent-runs.spec|auth-workbench.spec|company-watchlist.spec|docx-career-import.spec|first-recommendation-journey.spec' --project 'Desktop Chrome'
```

## 清理核对

两工作区的 package.json、Playwright 配置及 3 个临时追加用例的测试文件均与各自 HEAD 逐字节一致；基线工作树无跟踪文件改动。当前原有 CONTEXT.md / README.md diff 与诊断前备份一致，原有 ADR 保留。本轮只新增此报告，未提交；无遗留 Node E2E runtime 进程。所有诊断轮次均保存退出状态，未把预期为红的实验报告为测试通过。


## 修复阶段（用户追加“全部修复”后）

### 实施内容

- **auth 定位：** 精确匹配导航“推荐”，继续验证键盘焦点顺序。
- **导入状态：** 真实 E2E 保留已导入→完成、去重、原文、安全与失败夹具检查；不要求浏览器一定采到短暂 normalizing。既有组件轮询测试明确检查“规范化中”再到完成。
- **全局停止：** 验证 A 历史保留、排队 B 取消、解除后不恢复 B；队列保持暂停直到解除，使用 QueueEvents 等待真实 Worker 消费旧 B，再检查取消终态、无子运行/结果/清单。处理器对取消终态的消费返回 `cancelled`（不是 `stale`），测试按该契约断言。
- **导航同步：** 两项导航测试共享 `trackWorkbenchRefresh`，等待当前首页 RSC 请求完成；失败请求还需等待主框架回退到 /home，再确认首页已呈现、恢复提示消失。预取请求不计为刷新。仍使用真实点击/goto 和 URL 断言，没有增加固定 sleep 或 retries。
- **刷新失败回归：** 新增网络恢复和关闭引导两种真实 router.refresh 触发方式，受控中断 RSC，明确等 requestfailed 后验证恢复完成再进入画像。每种场景覆盖 Desktop Chrome 与 Mobile Safari；关闭引导路径没有在线恢复提示，用于保护失败回退同步。
- **Turbopack 隔离：** 本地测试运行时选择 dev:e2e；Web 使用 `next build --webpack && next start`，API/Worker 保留原 Nest 测试入口。普通开发仍运行原 dev 命令。此改动消除了默认 E2E 对 Turbopack 热编译的依赖，**并非修复 Turbopack 上游 Rust 实现**。
- **构建类型：** Webpack 的页面检查暴露 /home 与 /recommendations 将整个 props 参数设为可省略的问题；移除整个参数的默认值，保留 searchParams 字段默认值，组件测试按真实页面调用方式传入对象。未改变正常路由业务行为。

### 新增因果证据

1. 受控让首页 RSC 刷新失败并与 goto 重叠，10 次中 9 次发生原症状：`Navigation ... is interrupted by another navigation ... /home`。另 1 次停在实验脚本写错的画像标题断言，不计入同类失败。
2. 相同网络失败条件下，等待既有恢复提示消失后再导航，10/10 通过。
3. 生产模式下，网络恢复/关闭引导 × 两浏览器 × 两次，8/8 通过；进一步固定在 requestfailed 后调用等待，仍 8/8 通过。静态审查要求补齐无在线提示的回退同步，最终 helper 显式跟踪失败后的主框架回退。
4. 运行器新增检查先报 `dev !== dev:e2e`，实现后 44 项全部通过。
5. 新增 Worker 消费同步后的首轮定向验证为 12 passed / 2 failed，两项均是新断言错误地期望 stale、实际 cancelled；查证处理器终态分支后已更正，最终验收须重新覆盖。

### 已完成验证

| 检查 | 结果 |
|---|---|
| 修改前三类测试后，原默认 Turbopack 三阶段完整验收 | 118 + 4 + 2 passed，12 + 10 + 4 按阶段 skipped；无 panic |
| pnpm test:runtime | 44 passed |
| pnpm test:web | 94 文件、652 tests passed |
| pnpm --filter web typecheck | 退出 0 |
| pnpm lint:web | 退出 0 |
| Webpack 生产构建 | 页面类型修复后成功，定向 E2E 可启动 next start |

最终默认三阶段生产模式 E2E 已通过，详见文末最终验收；先前不同代码版本的通过记录仅作为历史证据。

### 修复阶段证据文件

本机 `/tmp/` 下保留：

- `issue55-fix-full-turbo.log`：修改前三类测试后的原默认运行方式验收。
- `issue55-diagnosis/navigation-overlap.log`：受控重叠实验；`navigation-overlap-synchronized.log`：同步实验。
- `issue55-runtime-red.log` / `issue55-runtime-green.log`：运行器红绿记录。
- `issue55-refresh-nononline-initial.log` / `issue55-refresh-failed-boundary.log`：两类刷新触发的重复验证。
- `issue55-fix-targeted-production.log`：定向 12 通过、2 个消费返回值断言失败的中间记录。
- `issue55-fix-web-tests.log` / `issue55-fix-typecheck.log` / `issue55-fix-lint.log`：静态与组件验证。
- `issue55-fix-full-production.log`：最终三阶段验收。

以上含失败的中间实验按实际结果保留，没有覆盖为成功记录。日志与 trace 仅用于本机诊断，不公开测试会话凭据。


当前修复后的复跑入口：

```sh
pnpm test:e2e -- e2e/auth-workbench.spec.ts --grep '首页.*刷新失败后' --workers=1 --retries=0
pnpm test:e2e -- --workers=1 --retries=0 --trace=retain-on-failure --reporter=line
```

注意：前半部分 /tmp/run.py 的 mode 仅适用于诊断时的原提交。当测试运行时改为 dev:e2e 后，旧脚本只修改 dev 并不能改变实际 E2E 构建器；不要将旧脚本的 `--mode turbo` 标签视为修复后仍在运行 Turbopack。


### 完整验收追加发现：模型诊断的并发只读误阻塞

首轮完整生产模式验收在 Desktop 启动历史 A 之后的 B 时发现按钮禁用。保留的 trace 显示：导航前后直接 API 均为 ready_with_warnings，但首页 SSR 中推荐准备的模型证据为 `MODEL_DIAGNOSTIC_UNAVAILABLE / checking`，而相邻运行前检查为 ready。该轮主动停止（退出 130），不是验收通过。

对照 `644dfbe..2d38fd2`，`packages/domain/src/model-diagnostics.ts` 没有变化；此问题属于既有缺陷，并非 #55 引入。

原因是 `createModelDiagnosticProjectionReader` 对纯读取使用排他事务 advisory lock。首页并行读取物理运行 preflight 与逻辑推荐 preparation 时，同一部署指纹的读事务互相争锁，失败的读者误报“诊断进行中”。准备状态留在首次渲染，导致按钮持续禁用。

修复仅将投影读取改为 `pg_try_advisory_xact_lock_shared`；实际 `diagnostics.run()` 仍使用相同键的排他锁。真实探针持锁时，读取仍返回 checking。没有放宽诊断成功条件或移除锁。

新增真实 PostgreSQL 回归：第一个读事务读取 available 后继续持锁，在第二个独立连接/事务读取同一结果。修复前稳定得到 checking（红），修复后两个读者均 available，且未增加 Adapter 探针次数（绿）。相关 3 文件、47 项测试以及领域类型检查通过；独立规格审查未发现新增 P1/P2。

证据：`/tmp/issue55-fix-full-production-lock-regression.log`、`/tmp/issue55-diagnosis/preflight-read-lock-trace.zip`、`/tmp/issue55-diagnostic-lock-red.log`、`/tmp/issue55-diagnostic-lock-green.log`、`/tmp/issue55-domain-typecheck.log`。最终完整验收在此修复后从头运行，并通过以下全部默认阶段。


### 最终验收与清理

最终命令为上述 `pnpm test:e2e` 完整命令，单 worker、零 retry，wrapper 退出 0。

| 默认阶段 | 通过 | 按阶段跳过 |
|---|---:|---:|
| ordinary（Desktop Chrome / Mobile Safari） | 122 | 12 |
| source-health | 4 | 10 |
| workbench-inbox | 2 | 4 |
| 合计 | 128 | 26 |

可选 anysearch / model-diagnostics E2E 阶段未额外运行。模型诊断修复另有 47 项相关领域测试和领域类型检查通过；Web 652 项、运行器 44 项及 Web 类型检查、lint 的有效结果如上。双轴复审最终均无新增问题。

最终 `git diff --check` 通过；没有 DIAG55 临时代码残留。原有 CONTEXT.md / README.md diff 与诊断前备份一致，原有 ADR 保留。最终检查无遗留 Playwright / local-runtime / Nest 测试进程。本报告随本轮修复一并提交；不推送，其他原有未提交改动保持不变。
