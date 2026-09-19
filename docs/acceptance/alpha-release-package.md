# v0.1.0-alpha 发布包验收（Issue #59）

规格：[Issue #59](https://github.com/GoodScholar/ai-job-search-copilot/issues/59)，法律接续：[Issue #60](https://github.com/GoodScholar/ai-job-search-copilot/issues/60)。固定基线 `5f4053084f5980f105ddf304c2f9cf052ea21843`；工作区起点与基线完全相同，#58 已关闭。分支 `codex/issue-59-alpha-release`。

## 需求规划与 implementation plan

本次在已完成的首次推荐闭环上准备发布材料，不扩展领域状态、认证或部署架构。沿用父规格的真实全栈首次推荐接缝、运行时启动接缝与公开 UI 接缝。

1. 版本展示先红后绿；统一 9 个 package、页面/工作台与 API 发布元数据，REST `/v1` 不变。
2. 以 README 为入口提供 CHANGELOG、快速开始、部署责任、虚构演示材料与法律审核交接；复用既有两结局验收增加 `demo:alpha`，不构建另一套业务演示状态。
3. 无依赖/缓存/配置的源码目录安装锁定依赖，从空卷启动完整运行时，实际验证演示与日常启动；发现启动缺陷后只修复相关构建排除规则。
4. 串行完整检查；Standards/Spec 独立只读审查；记录证据后提交并更新关闭 #59。#60 交人工接手，未经法律决定不公开发布、不推送或合并。

## 逐项覆盖

| #59 验收要求 | 实现 / 证据 |
| --- | --- |
| 产品与发布版本统一 | package manifests `0.1.0-alpha`、工作台/营销页版本、Next applicationName、OpenAPI info.version、PRODUCT/README/CHANGELOG |
| 变更与兼容性/迁移/限制 | CHANGELOG：首次闭环、`/v1` 保持、全部迁移到 0058、备份/回退、正式 Beta 后边界 |
| 干净环境启动完整依赖 | 全新临时源码目录 frozen 安装；演示与 pnpm dev 空卷启动，readiness 全部 ready |
| 托管/自行部署责任 | docs/releases/v0.1.0-alpha.md：责任表、Dev Auth 与尚未交付的生产托管/微信认证限制 |
| 服务凭据责任 | 服务端部署者持有，无求职账户秘密管理；模型连接诊断与账户额度只呈现脱敏状态 |
| 无支付 | README、CHANGELOG 与责任说明保持一致，无新增支付/订阅接口 |
| 虚构两结局演示 | docs/demo/fictional-career.md 被真实首次旅程读取；固定 Fake 岗位含合成标记，推荐 1 项/资格淘汰后 0 项 |
| 不依赖真实第三方的首次旅程 | pnpm demo:alpha 启动真实 Web/API/Worker/PostgreSQL/Redis/MinIO/Mailpit，4 个桌面/移动结局用例；来源网络禁用 |
| 法律批准前不加入许可声明 | 无新增 LICENSE/NOTICE/license 字段；所有发布入口声明待 #60 审核；人工材料与缺口另列 |

## 干净环境证据

日期：2026-09-19（Asia/Shanghai）；Node `v24.20.0`、pnpm `11.5.2`、Docker `29.5.2`。源码目录 `/var/folders/jk/nlrws6j16tv20qd4p5ctf6700000gn/T/issue59-clean-52rjvl_h` 从本工作树受版本管理文件及本次新增文件复制，无 `.env`、`node_modules`、`.next`；安装复用机器包缓存，不复用项目安装树或历史业务数据。

- `pnpm install --frozen-lockfile` 退出 0：`/tmp/issue59-clean-install.log`。
- `pnpm --filter web exec playwright install --with-deps chromium webkit` 退出 0：`/tmp/issue59-clean-browsers.log`；浏览器可复用机器已安装版本。
- 新终端环境通过 `env -i` 仅保留工具路径/用户目录；`pnpm demo:alpha` 退出 0，4 passed：`/tmp/issue59-clean-demo.log`。每次隔离 Compose 测试卷创建、迁移并删除，无第三方模型/岗位服务调用。
- 日常启动另用全新 Compose 项目 `job-copilot-issue59-clean-dev`，默认文档端口、空数据卷、`pnpm dev`。API readiness 确认 PostgreSQL/Redis/MinIO/Mailpit/Worker 全部 ready；OpenAPI info.version 为 `0.1.0-alpha`；登录页 HTTP 200 且存在 Dev Auth 入口与版本元数据。探针退出 0：`/tmp/issue59-clean-dev-probes.log`；运行日志：`/tmp/issue59-clean-dev-green.log`。
- 日常服务按文档 Ctrl-C 停止（pnpm 返回 1，属于交互中断，不作为“命令正常结束”）；`pnpm dev:down` 退出 0：`/tmp/issue59-clean-dev-down-green.log`。随后仅删除本次专用项目的空测试卷：`/tmp/issue59-clean-dev-cleanup.log`，退出 0。

### 红绿与缺陷记录

- 版本 UI：新增 `v0.1.0-alpha` 可见断言先失败（退出 1，`/tmp/issue59-version-red.log`），实现后通过（退出 0，`/tmp/issue59-version-green.log`）。
- 首次日常启动 API 报 `ERR_MODULE_NOT_FOUND ... apps/api/dist/main`，未达 readiness；日志 `/tmp/issue59-clean-dev.log`。API build 配置未排除 `*.test.ts`，测试跨目录导入导致 `main.js` 输出到 `dist/apps/api/src/`。Worker 已正确排除测试。补齐 API 相同排除项，删除本次输出与空卷后重新启动，探针全部通过。保留原失败，不增加重试，不改变测试专用入口来绕过。
- 首轮演示构建出现 JSON named-export 兼容性警告；三个 Web 版本读取改成默认 JSON import，最终检查覆盖该修改。
- 首次全仓单元/集成在 API 的既有 scheduled-run HTTP 用例失败（207 通过、1 失败，`/tmp/issue59-unit-final.log`，退出 1）：调度注入上午时间，生产 preflight 使用本机 22:36，正确阻止后台窗口外运行。固定 `Date` 为 22:31 后稳定重现 blocked/null（`/tmp/issue59-api-clock-red.log`，退出 1）；仅把该用例的 Date 对齐到调度发生的 09:31，真实异步计时器与生产检查不变，并在 finally 恢复。整个集成文件 65 项通过（`/tmp/issue59-api-clock-green.log`，退出 0）。这是测试时钟缺陷，未改生产策略、增加重试或弱化断言。

## 最终串行检查

执行器 `/tmp/issue59-run-checks.py` 每条命令独立保留日志，失败即停止；机器可读退出码记录 `/tmp/issue59-check-results.json`。最终串行检查已完成。首次全仓的时钟夹具失败经定位与修正后，受影响 API 全套、后续 Worker、完整 E2E 和构建均通过。所有测试由本任务统一执行，没有重叠运行；没有增加重试或将断言失败改为跳过。

| 检查 | 结果 / 退出码 | 完整日志 |
| --- | --- | --- |
| 最终干净演示 | 4 passed / 0 | `/tmp/issue59-clean-demo-final.log` |
| 全仓类型检查 | 通过 / 0 | `/tmp/issue59-typecheck-final.log` |
| API 测试时钟修正后的类型检查 | 通过 / 0 | `/tmp/issue59-api-typecheck-final.log` |
| 运行时 | 44 passed / 0 | `/tmp/issue59-runtime-final.log` |
| contracts / database / web / model-access / source-access / domain | 197 / 54 / 661 / 43 / 125 / 839 passed；全部通过，保留首次串行运行的有效结果 | `/tmp/issue59-unit-final.log`（该命令在后续 API 用例退出 1） |
| API 修正后全套 | 208 passed / 0 | `/tmp/issue59-api-final.log` |
| Worker 全套 | 324 passed / 0 | `/tmp/issue59-worker-final.log` |
| lint | 通过 / 0 | `/tmp/issue59-lint-final.log` |
| 完整三阶段 E2E | 134 passed、26 按环境跳过 / 0 | `/tmp/issue59-e2e-final.log` |
| 构建 | Web/API/Worker 全部通过 / 0 | `/tmp/issue59-build-final.log` |

最终有效工作区结果共 239 个文件、2,451 项，另有 44 项运行时检查。首次全仓命令的 API 失败保留为失败；只重跑受影响 API 和尚未执行的 Worker，不重复未变化且已有有效结果的套件。

Standards 与 Spec 已由两个独立只读代理审查基线至当前全部变更，两轴均为 0 项发现；新增 API 时钟夹具修正又经两轴独立复审，均为 0 项。审查代理未运行测试、构建或服务。

#58 的有效安全分支与历史结果见 [alpha-first-recommendation.md](alpha-first-recommendation.md)。#59 的完整检查重新执行，不以 #58 基线代替本次干净环境验收。trace 留在本地，不公开上传。


E2E 分阶段：ordinary 128 passed / 12 skipped；source-health 4 passed / 10 skipped；workbench-inbox 2 passed / 4 skipped。全部串行、retries=0。构建后确认 API 入口位于 `dist/main.js` 且没有编译后的 `*.test.js`；仅清理了本次生成的 API/Worker dist 目录。最后确认无遗留测试进程和本任务 Compose 资源，未触碰其他项目容器。

## 交付与法律接续

交付为本地提交与本地源码归档，未推送、合并、打公开标签或创建公开 Release。归档及校验清单放在 `/Users/shen/.codex/artifacts/issue59-v0.1.0-alpha/`，精确提交 SHA、SHA-256 和命令结果写入独立 `release-manifest.json`，避免源码文档自引用提交号。该目录还保存本次日志和依赖许可证声明清单的副本；trace 不进入源码包。

#59 工程验收不代替 #60 的人工决定。[法律交接](../releases/legal-review-handoff.md)列明源码/迁移来源、锁定依赖、固定镜像、素材、分发方式、证据缺口与人工签核项目；尚缺审核者、权利链、来源逐文件映射、完整许可证/NOTICE 与素材证明、明确分发方案和最终决定。所有公开发布与许可证批准仍待人工处理。
