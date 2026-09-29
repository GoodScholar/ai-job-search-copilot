# Alpha 首次推荐验收（Issue #58）

规格：[Issue #58](https://github.com/GoodScholar/ai-job-search-copilot/issues/58)，父规格 [#47](https://github.com/GoodScholar/ai-job-search-copilot/issues/47)。基线 `e0294dc` 包含已关闭的 #52–#57。

## 实施计划与接缝

1. 在已约定的来源 Adapter 公开接口添加显式合成夹具，先验证失败，再让测试环境解析场景；生产与 local 不接受 E2E 场景配置。
2. 扩展现有 `first-recommendation-journey.spec.ts`：真实职业资料上传 → 公开画像确认命令 → 工作台权威进度 → 运行前检查警告确认 → 推荐运行 → 推荐结果 → 岗位归档、恢复、导出 → 后续画像失效仍永久完成。独立场景用薪资门槛淘汰已发现岗位，检查暂无推荐的覆盖与淘汰证据。
3. 主接缝若暴露生产缺陷，保留红色日志后做最小修复。复用现有安全分支，不重建重复套件。
4. 串行执行类型、单文件、完整测试与三阶段 Playwright，随后 Standards / Spec 独立审查、修复、提交、关闭 Issue。

## 验收环境

Playwright 启动真实 Next.js 生产构建、Nest API / Worker、PostgreSQL、Redis、MinIO 和 Mailpit。来源与模型使用确定性 Fake Adapter；合成岗位名称、公司和原始证据明确标记测试用途，不代表真实招聘信息。新主接缝不写入岗位、来源发布、匹配或推荐结果；仅通过公开 API 准备用户领域状态。过期下载复用既有岗位工作区测试的过期元数据夹具，不改写真实快照的不可变时间字段。

默认测试不访问真实模型、AnySearch 或招聘站点。真实外部 Adapter 的显式冒烟检查不属于默认质量门，也不能替代主旅程通过。

## 覆盖映射

| 验收要求 | 最高层接缝 |
| --- | --- |
| 初始阻塞、准备进度、警告确认、一键推荐、永久完成 | first-recommendation-journey：Alpha 主旅程 |
| 有来源覆盖与资格淘汰证据的暂无推荐、永久完成 | first-recommendation-journey：Alpha 暂无推荐 |
| 重复启动、离页恢复、部分来源失败、排队取消 | one-click-recommendation |
| 默认关闭与显式启用计划、真实计划执行 | scheduled-job-discovery |
| 全局停止持久化、解除不复活旧任务 | account-run-policy / one-click-recommendation |
| 安全检查点取消、暂停后明确恢复、可处理失败 Inbox | agent-runs |
| 来源失败 Inbox 处理与修复入口 | workbench-inbox（独立来源阶段） |
| 归档恢复、不可变 CSV、BOM、公式防护、账户隔离、24 小时有效期及过期拒绝 | Alpha 主旅程 / recommendations |
| 桌面与移动、键盘与焦点、44px、减少动态效果、溢出、axe | 两浏览器的 Alpha 主旅程及既有安全分支 |

## 复跑与失败分类

先确认没有其他任务占用测试运行时；固定端口的 E2E 不可并发。所有命令串行运行，保留完整日志及退出码。

```sh
pnpm install --frozen-lockfile
pnpm test:e2e -- e2e/first-recommendation-journey.spec.ts --grep Alpha --workers=1 --retries=0
pnpm typecheck
pnpm test
pnpm lint
pnpm test:e2e -- --workers=1 --retries=0 --trace=retain-on-failure --reporter=line
```

默认 E2E 包括 ordinary、source-health、workbench-inbox 三阶段，每阶段重建隔离测试基础设施；不允许用仅一个文件通过代替完整验收。重试默认关闭，包括 CI；失败保留 trace。按阶段跳过只用于不同 Adapter 环境之间的场景选择，不能把断言失败改为 skip。

- **环境配置失败**：Docker/端口/依赖/迁移/服务启动出错，尚未到业务断言。保留启动日志，修复环境后从失败阶段重新执行。
- **产品缺陷**：真实应用接口或 UI 与规格冲突。记录首个断言、请求/响应和 trace；建立因果证据并修复后重跑受影响检查。
- **测试缺陷**：定位器歧义、时钟夹具或同步错误。证明原因，修复测试，保留失败日志；不得用 sleep、增加 retries 或重复跑到绿来消除记录。
- **外部冒烟失败**：仅出现在另行显式启用的生产 Adapter 检查中。分别记录鉴权、供应商限制或目标站点变化；不计入确定性 Fake 验收。

trace 可能包含合成账户会话凭据，只保存在本地，不公开上传。

## 本次红绿证据与审查

- 来源场景公开接口：新增用例先报 `JOB_DISCOVERY_RUNTIME_CONFIG_INVALID`，实现显式 test-only 场景后 20 项通过。
- 无 SQL 业务结果注入的主旅程：首次失败为 `AGENT_RUN_ADAPTER_FAILED`。发现详情契约不支持资格证据，持久化仅保留摘要；补齐可选正文/资格字段、来源版本摘要和机会快照后，真实流水线可以完成推荐。
- 来源版本：把内容摘要临时恢复到旧实现后，新增正文/资格变化回归失败（51 通过、1 失败）；恢复修复后 52 项通过，证明并非仅增加不会失败的测试。
- 验收代码问题保留记录：修改导出时间被不可变约束拒绝，改为验证真实快照精确 24 小时有效期并复用既有过期下载分支；空结局链接应为“查看本次结论”；Inbox 点击后应等待权威 resolved 状态。没有增加 retry 或固定 sleep。
- Standards 独立审查指出 reduced-motion 只检查 main 不足，已扩展到主内容所有后代及 `::before` / `::after`。Spec 独立审查未发现额外规格缺口。

本机红绿与定向日志位于 `/tmp/issue58-*.log`，失败 trace 备份位于 `/tmp/issue58-evidence/`。

## 完整检查结果

| 检查 | 结果 |
| --- | --- |
| 全仓 `pnpm typecheck` | 通过 |
| `pnpm test:runtime` | 44 项通过 |
| 全工作区测试（`--workspace-concurrency=1`） | 239 文件、2,451 项通过 |
| `pnpm lint` | 测试会话 helper 改名后通过 |
| Inbox 恢复与强制刷新失败定向检查 | 桌面及移动共 6 项通过 |
| 完整 Playwright ordinary 阶段 | 128 项通过、12 项按环境跳过 |
| 完整 Playwright source-health 阶段 | 4 项通过、10 项按环境跳过 |
| 完整 Playwright workbench-inbox 阶段 | 2 项通过、4 项按环境跳过 |
| Standards 最终复审 | 0 项剩余问题 |
| Spec 最终复审 | 0 项剩余问题 |

全量测试按 contracts 197、database 54、web 661、model-access 43、source-access 125、domain 839、api 208、worker 324 串行完成。没有与其他任务重叠执行测试。

最终完整 E2E 在修复下述同步问题后从零串行执行，退出码 0，共 134 项通过、26 项按阶段环境选择跳过，重试次数为 0。完整日志：`/tmp/issue58-full-e2e-final.log`；定向恢复日志：`/tmp/issue58-inbox-recovery-green.log`。测试运行时已自动清理，无遗留测试进程。两轴复审均覆盖最终 Inbox 同步修改。

### 完整 E2E 首轮发现的既有同步问题

首轮完整 E2E 在 Desktop Inbox 候选事实用例失败，随后主动中止，退出 130；不计为验收通过。`trackWorkbenchRefresh` 等待 RSC 网络传输结束超时。保留 trace 表明 `/home` 的恢复请求已返回 200，首页已提交新状态且恢复提示消失，但流式响应尚未结束；未出现 RSC 回退日志，响应在测试结束时被取消。

该用例改为在恢复网络前注册 RSC 响应等待，确认成功响应和用户可见恢复状态完成后，再标记 Inbox 已读并导航。同步基于页面权威状态，不等待流式 EOF，不增大超时或重试。原有两类强制刷新失败与整页回退用例保留，用于验证失败时仍会正确等待导航恢复。失败 trace：`/tmp/issue58-evidence/inbox-refresh-failure/trace.zip`；原完整日志：`/tmp/issue58-full-e2e.log`。
