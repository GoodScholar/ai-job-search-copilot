# #60 人工法律审核交接：v0.1.0-alpha

**状态：未批准，未公开发布。** 本文是证据入口与待办材料清单，不是法律意见或许可证授权。#59 只准备可验证运行包；具备资质的人工审核者须在 [Issue #60](https://github.com/GoodScholar/ai-job-search-copilot/issues/60) 记录决定。不得由实现代理代签、加入未经批准的 LICENSE/NOTICE、打公开发布标签或发布制品。

## 待审核材料

| 范围 | 当前证据入口 | 尚缺信息 / 审核动作 |
| --- | --- | --- |
| 自有实现与版权链 | 本仓库 Git 历史、根级及子目录 AGENTS、[PRODUCT](../../PRODUCT.md)、[CONTEXT](../../CONTEXT.md)、全部 apps/packages/scripts | 确认权利主体、所有贡献者/委托关系、授权链及拟采用的版权署名；提交作者信息本身不能证明权利归属 |
| 工作流迁移来源 | `MadsLorentzen/ai-job-search`；[ADR 0001](../adr/0001-rebuild-production-agent-runtime.md) 声明迁移工作流、规则、提示词、模板意图而非生产运行时 | 来源固定提交、当时许可证全文、逐项复制/改写/参考清单与对应目标文件；当前没有完整可审计映射，不能凭架构重写断言没有派生义务 |
| 自动投递研究参考 | `feder-cr/Jobs_Applier_AI_Agent_AIHawk`；[ADR 0032](../adr/0032-use-user-side-approval-bound-application-execution.md) 明确只研究、不直接复制/集成 | 人工确认实际实现与素材来源，核对有无额外引入内容 |
| JavaScript 直接及传递依赖 | 全部 `package.json`、[pnpm-lock.yaml](../../pnpm-lock.yaml)、[pnpm-workspace.yaml](../../pnpm-workspace.yaml)；锁文件固定安装版本与完整性 | 在待分发树上生成依赖清单，复核每个包实际附带 LICENSE/NOTICE 与例外；不能只依赖 package 的 license 字段 |
| 基础设施镜像 | [compose.yaml](../../compose.yaml) 固定 PostgreSQL、Redis、MinIO、MinIO Client、Mailpit 镜像摘要 | 确认各摘要对应镜像内许可证、源码提供/NOTICE 要求与实际分发方式；不能把所有镜像统称为“MIT 依赖” |
| 素材与字体 | [DESIGN.md](../../DESIGN.md)、`apps/web/public/*.svg`（含 next/vercel 标识）、`apps/web/app/favicon.ico`、组件内图形与系统字体栈 | 确认来源、商标/再分发权限、是否随制品发布；当前未有完整素材授权证明，不凭模板来源作批准结论 |
| 演示与业务数据 | [明确虚构的职业资料](../demo/fictional-career.md)、`apps/worker/src/agent-runs/fake-job-discovery-adapter.ts`、首次推荐 E2E；[验收记录](../acceptance/alpha-release-package.md) | 确认演示内容无第三方个人信息或真实效果声明；真实运行另行核对数据来源、保存与服务条款 |
| 计划使用与分发 | [部署责任](v0.1.0-alpha.md)、[变更记录](../../CHANGELOG.md) | 确认法律实体、运营地区、托管网络服务、源码分发、是否分发容器/二进制、修改版源码提供方式；本次仅本地提交，不含公开 Release/推送/部署 |

可在锁定依赖安装后生成供人工筛查的声明清单：

```sh
pnpm licenses list --json > /tmp/job-copilot-dependency-license-declarations.json
```

本次已生成本地清单 `/tmp/issue59-dependency-license-declarations.json`：948 个条目、19 组许可证声明，包含 LGPL/MPL 与多许可表达式，需逐项人工复核。对应 `pnpm-lock.yaml` SHA-256：`85c3c618170e625f0c06bb2fd77cfc11977ad55cfd123b9de760c2b8004c6ff1`；`compose.yaml` SHA-256：`9ba9d1cff398018ff6f689551e9a981c638bd542fe742ff10234902a6dd3d024`。本地临时文件不是永久附件，接手时应按同一命令重新生成并归档。

此清单包含依赖自行声明的许可证，不是审定的 SBOM 或授权结论；与锁文件摘要、审核提交 SHA 一起归档，并核对实际分发依赖、容器、素材和人工发现的缺口。法律审核期间若代码、依赖或分发计划改变，需更新审核范围。

## 人工决定必须留下的记录

- 审核者姓名/机构、资质或受托角色、日期、范围、固定提交 SHA 和证据附件位置。
- 明确决定：批准、附条件批准或不批准采用 AGPL-3.0；若批准，明确是否限定具体版本/后续版本条款，不由代理推断。
- 批准时：最终 LICENSE 文本、版权声明、NOTICE/来源披露、网络服务或分发义务及所有条件、责任人、完成证据。
- 不批准时：替代许可证决定、权利补充、移除/重写等整改项或停止公开发布要求。
- 公开发布前由责任人逐条验证条件；最终 LICENSE、README、CHANGELOG、版本元数据、仓库展示及计划制品保持一致，并在 #60 留下可追溯签核。

## 当前仍缺的关键输入

具备资质的审核者及委托、权利主体与贡献授权、来源固定版本及逐文件迁移表、完整第三方许可证/NOTICE 与素材证明、明确的运营/分发方案、正式决定及批准条件。未补齐前，#60 保持人工待处理，不能将 #59 的工程验收当作法律审核完成。
