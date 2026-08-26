# Domain Docs

## Before exploring

1. 阅读根目录 `CONTEXT.md`
2. 阅读与当前任务相关的 `docs/adr/`
3. 不存在的领域文档无需提前创建

## Layout

本仓库采用 single-context：

- `CONTEXT.md`：统一领域词汇
- `docs/adr/`：系统级架构决策

## Vocabulary

Issue、规格、测试和代码命名必须使用 `CONTEXT.md` 定义的术语，避免使用其中明确排除的同义词。

遇到尚未定义的领域概念时，重新检查是否正在创造无必要的新语言；若确有领域缺口，交给 `/domain-modeling`。

## ADR conflicts

若方案与现有 ADR 冲突，必须明确指出对应 ADR 和重新讨论的理由，不得静默覆盖。
