# Alpha 主线集成验收（Issue #70）

规格：[Issue #70](https://github.com/GoodScholar/ai-job-search-copilot/issues/70)，父规格 [#47](https://github.com/GoodScholar/ai-job-search-copilot/issues/47)。本次从远端 `main` 的受控基线 `fa67dd655aee9bc63eb95e61590648a15cbbdb66` 建立独立工作树；基线通过 `git ls-remote origin refs/heads/main` 固定，不读取原始脏工作目录作为实现来源。

## 来源与移植范围

| 已验收来源 | 本分支提交 | 处理 |
| --- | --- | --- |
| `2d38fd2`、`b3ec0fa`（#55） | `efb9b4a`、`0878cad` | 移植岗位归档、恢复及稳定化修正 |
| `0e6b9f4`（#56） | `7b09975` | 移植不可变 CSV 导出 |
| `e0294dc`（#57） | `1bdb2a4` | 移植首次推荐旅程最小指标 |
| `5f40530`（#58） | `43b0a9b` | 移植首次推荐完整 Playwright 验收接缝 |
| `60c5442`（#59） | `453279a` | 移植 v0.1.0-alpha 元数据、变更记录、快速开始、合成演示和已知限制 |

#58 的验收依赖 #55–#57；远端基线只包含 #65，没有这四个本地 `main` 提交，因此本 PR 显式携带完整已验收前置链。没有移植原始工作目录中的未提交或未跟踪文件，也没有加入 #61、#66 或本地 Chrome/BOSS 实验。

## 主线漂移处理

- #65 已占用 `0056_openai_career_parser`。为保留已发布迁移编号，#55–#57 等价顺延为 `0057_job_opportunity_archives`、`0058_job_exports`、`0059_journey_metrics`。
- 新增 `0059_snapshot.json` 汇合 #65 与 #55–#57 的最终 schema；`drizzle-kit generate` 对集成后 schema 报告 `No schema changes, nothing to migrate`。
- README 同时保留 #59 的 Alpha 验证说明与 #65 的生产职业资料解析边界；CHANGELOG 和快速开始同步记录顺延迁移与 `CAREER_PARSER_ADAPTER=openai` 的显式部署责任。
- 没有舍弃 #55–#59 的有效行为或测试。许可证仍等待 #60 人工决定；未新增 LICENSE、NOTICE 或 package license 字段，也未声明仓库已经获得 AGPL-3.0 授权。

## 串行验证

日期：2026-09-28（Asia/Shanghai）。所有测试由当前任务按单进程命令串行执行，没有 Supervisor/Executor 重叠测试。

| 检查 | 结果 | 完整日志 |
| --- | --- | --- |
| 基线 `pnpm test` | 47/48 domain 文件、789 项通过；`verified-job-source-gate.integration.test.ts` 因 Testcontainers 端口绑定硬编码 10 秒超时失败 | `/tmp/issue70-baseline-test.log` |
| 受影响测试 | contracts/domain/worker/API/Web 共 208 项通过 | `/tmp/issue70-targeted-tests.log` |
| 数据库迁移 | 6 文件、54 项通过；集成后及审查修正后复跑均为 54 项通过；最终 schema 无迁移漂移 | `/tmp/issue70-database-test.log`、`/tmp/issue70-database-rerun.log`、`/tmp/issue70-database-review-fix.log`、`/tmp/issue70-drizzle-review-fix.log` |
| 全仓类型检查 | 退出 0 | `/tmp/issue70-typecheck.log` |
| 运行时 | 44 项通过，退出 0 | `/tmp/issue70-runtime.log` |
| 全工作区测试 | contracts 199、database 54、Web 662、model-access 50、source-access 125、domain 841、API 208、Worker 332；共 243 文件、2,471 项有效通过 | `/tmp/issue70-workspace-tests.log`、`/tmp/issue70-database-rerun.log`、`/tmp/issue70-remaining-workspace-tests.log` |
| lint | 退出 0 | `/tmp/issue70-lint.log` |
| Alpha 合成演示 | Desktop Chrome 与 Mobile Safari 的推荐清单/暂无推荐共 4 项通过，退出 0 | `/tmp/issue70-alpha-demo.log` |
| 完整三阶段 E2E | ordinary 128/12、source-health 4/10、workbench-inbox 2/4；合计 134 passed、26 按阶段跳过、retries=0、退出 0 | `/tmp/issue70-e2e.log` |
| build | Web、API、Worker 通过，退出 0 | `/tmp/issue70-build.log` |

全工作区首次串行命令在 database 的 `recommendation-runs.migrate.integration.test.ts` 再次遇到同一 Testcontainers 端口绑定超时，40 项通过、14 项因 beforeAll 失败跳过。调查确认 Testcontainers 12.1.0 在 wait strategy 之前使用不可配置的 10 秒端口映射等待；失败容器由 Ryuk 清理，项目代码和迁移未产生断言失败。保留 `/tmp/issue70-workspace-tests.log` 原始失败，不修改依赖或测试超时；随后只重跑受影响 database 套件，并继续尚未执行的工作区套件。该既有环境问题仍由 #71 独立归因。

## 双轴审查

Standards 与 Spec 由两个独立只读代理对固定基线至当前全部变更进行审查，代理未运行测试或服务。首次审查发现并修正三项可验证偏差：`0057`/`0058` 中间快照未承接 #65 的 OpenAI 解析器列及约束；指标文档引用仓库中不存在的 ADR 0039；#59 验收文档仍把迁移终点写作集成前的 0058。修正后重新生成对应阶段快照，`drizzle-kit generate` 确认最终 schema 无漂移，数据库 54 项测试通过；两轴随后复审最终差异，Spec 与 Standards 均为 0 项发现。

Standards 另标记 API 与 Worker 各自的 `MinioJobExportStore` 存在相似实现。本次不跨应用抽取：两者位于独立可部署应用的基础设施适配层，分别服务读取与后台写入生命周期；仓库对 career document 等 MinIO 适配器同样保持应用本地实现。为消除十余行重复而新增跨应用共享基础设施依赖会扩大 #70 的集成范围，且不会改变领域端口契约或验收行为。

## 交付边界

- 分支：`codex/issue-70-alpha-integration`。
- 本 Issue 与 #47 在合并前保持开放；本次只创建可审查 PR，不打标签、不创建公开 Release、不合并主线。
- 临时日志与 Playwright trace 不进入源码；E2E 专用 Compose 项目和测试卷均已清理。
