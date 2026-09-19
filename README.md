# AI Job Search Copilot · v0.1.0-alpha

面向中国市场中高级互联网与 AI 技术求职者的求职工作台。本次 Alpha 交付从职业资料、画像确认、求职目标和来源准备，到运行前检查、首次推荐清单或可信“暂无推荐”、岗位归档与 CSV 导出的闭环。

**发布准备状态：未公开发布；许可证待 [#60 人工法律审核](https://github.com/GoodScholar/ai-job-search-copilot/issues/60)。尚未加入获批 LICENSE，不宣称已按 AGPL-3.0 授权。** Alpha 不包含支付、购买额度或自动外部行动。

## 从零体验合成演示

需要 Node.js `>=22.22.2`、pnpm `11.5.2`、运行中的 Docker 与 Docker Compose；首次安装需访问包仓库、浏览器和容器镜像下载源。取得本版本源码后，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter web exec playwright install --with-deps chromium webkit
pnpm demo:alpha
```

这是自动运行的全栈演示验收：启动 Web、API、Worker、PostgreSQL、Redis、MinIO 和 Mailpit，从空数据库执行迁移，使用[明确虚构的职业资料](docs/demo/fictional-career.md)和确定性模型/岗位来源，串行验证桌面和移动端两种结局，预期 **4 passed**。默认无需 OpenAI、AnySearch 或招聘站点凭据，不访问真实招聘或模型服务。安装下载不属于业务服务调用。

演示复用专用隔离 Compose 项目 `job-copilot-issue-2-e2e`；每次运行前后会删除该项目的测试卷，不得用于真实资料，也不能与其他 E2E 同时运行。想观察浏览器操作可运行 `pnpm demo:alpha --headed`；结束后自动清理应用和测试数据，它不是一个常驻的托管站点。完整流程、端口与失败处理见[快速开始和部署责任](docs/releases/v0.1.0-alpha.md)。

## 日常本地运行

```sh
pnpm dev
```

自动启动真实依赖、初始化对象存储、运行数据库迁移，再启动三个应用。默认端口见 [`.env.example`](.env.example)，不自动读取该文件；覆盖配置需在同一 shell `export` 后运行。此模式保留本地数据，使用 Dev Auth；模型服务和真实来源的配置、能力限制见[部署说明](docs/releases/v0.1.0-alpha.md#日常本地运行与运行服务配置)。

- 产品：[本地工作台](http://127.0.0.1:3020)
- API：[OpenAPI](http://127.0.0.1:3021/openapi.json)、[readiness](http://127.0.0.1:3021/health/ready)
- [Mailpit](http://127.0.0.1:58025)、[MinIO Console](http://127.0.0.1:59001)

运行终端按 `Ctrl-C` 停止 Web、API 和 Worker，然后运行 `pnpm dev:down` 停止 Compose 依赖；默认保留数据卷。`dev:down` 不会终止另一终端的应用进程。Dev Auth 和示例凭据只用于本机隔离开发，不能直接作为公网邀请制认证。

## 发布材料与验证

- [变更、兼容性、迁移要求和已知限制](CHANGELOG.md)
- [快速开始、两种演示结局、托管与自行部署责任](docs/releases/v0.1.0-alpha.md)
- [本次干净环境验收记录](docs/acceptance/alpha-release-package.md)
- [#58 首次推荐完整验收与安全分支基线](docs/acceptance/alpha-first-recommendation.md)
- [#60 人工法律审核交接材料与待补信息](docs/releases/legal-review-handoff.md)

全部检查应串行执行：

```sh
pnpm typecheck
pnpm test:runtime
pnpm --workspace-concurrency=1 -r --if-present test
pnpm lint
pnpm test:e2e -- --workers=1 --retries=0 --trace=retain-on-failure --reporter=line
pnpm build
```

端到端测试使用自己的隔离 Compose 项目和端口，并会在结束时清理；它不会占用或替代本文档中的默认开发端口。

E2E 包括 ordinary、source-health、workbench-inbox 三阶段，按环境跳过的场景不算通过。默认检查不调用真实模型、AnySearch 或招聘站点；生产 Adapter 冒烟另行显式执行。

### OpenAI 职业资料解析

默认使用确定性的 Fake；测试运行时会强制选择 Fake。生产解析需在同一运行环境中显式配置 `CAREER_PARSER_ADAPTER=openai` 和 `OPENAI_API_KEY`，模型默认遵循 ADR 0019 的 `gpt-5.6-luna`（可由部署配置 `OPENAI_LOW_COST_MODEL` 指定）。API 与 Worker 必须使用相同配置。

独立真实验证使用 `career-parser-eval-v1` 固定脱敏 Markdown，不读取用户文件；门禁检查事实完整性、准确原文证据、注入过滤与延迟，仅输出版本和事实数量：

```bash
CAREER_PARSER_ADAPTER=openai pnpm verify:career-parser:openai
```

解析仅读取通过隐私检查的处理副本；每次最多处理 16 KiB UTF-8 文本、生成 4,000 个输出 Token、消耗 20,000 个总 Token，25 秒后终止。超出解析预算的资料会保留稳定失败原因，用户可精简后重试。文件上传上限与解析预算分别约束文件存储和模型调用。

Adapter 使用 [Responses Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)，关闭响应存储、不提供工具，模型仅选择事实类型和原文行号；事实值由本地原文生成，并再次通过领域校验。密钥、原文、联系方式和供应方错误正文不会进入普通日志。
