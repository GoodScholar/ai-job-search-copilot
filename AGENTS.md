# AGENTS.md

## Project objective

本项目的最终目标是把 [`MadsLorentzen/ai-job-search`](https://github.com/MadsLorentzen/ai-job-search) 中面向 Claude Code 的求职工作流，重构为普通求职者可直接使用的 AI Job Search Copilot 网站或软件。

原仓库是工作流、评分规则、提示词、模板与适配器的迁移来源，不是生产 Web 运行时。目标产品仓库是 [`GoodScholar/ai-job-search-copilot`](https://github.com/GoodScholar/ai-job-search-copilot)。实现时必须延续 `PRODUCT.md`、`CONTEXT.md` 与 ADR 中已确认的产品和架构边界，不能把当前营销首页误当成最终产品。

## Agent skills

### Issue tracker

Issue 与规格使用 GitHub Issues，目标仓库为 `GoodScholar/ai-job-search-copilot`。参见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认的五类 triage 状态。参见 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context：读取根级 `CONTEXT.md` 与 `docs/adr/`。参见 `docs/agents/domain.md`。
