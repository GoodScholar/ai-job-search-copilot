# Issue tracker: GitHub

本仓库的 Issue 与规格存放在 `GoodScholar/ai-job-search-copilot` 的 GitHub Issues 中。所有操作使用 `gh` CLI，并从当前仓库的 `origin` 自动解析目标仓库。

## Conventions

- 创建：`gh issue create --title "..." --body "..."`
- 阅读：`gh issue view <number> --comments`
- 列表：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <number> --body "..."`
- 添加或移除标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

多行正文使用 heredoc，读取列表时通过 `--jq` 保留 Issue 编号、标题、正文、标签和评论。

## Pull requests as a triage surface

**PRs as a request surface: no.**

外部 Pull Request 默认不进入 triage 队列。若以后需要，可将此标记改为 `yes`，再使用相应的 `gh pr` 命令。

GitHub 的 Issue 与 Pull Request 共享编号空间。遇到裸编号 `#42` 时，先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## Skill operations

- “Publish to the issue tracker”：创建 GitHub Issue
- “Fetch the relevant ticket”：运行 `gh issue view <number> --comments`
- `/to-spec`：将规格发布为 GitHub Issue 或其明确引用的文档
- `/to-tickets`：创建独立、可执行且带阻塞关系的 GitHub Issues
- `/implement`：领取所有 blocker 已关闭的 Issue，并在完成后更新 Issue

## Wayfinding operations

- **Map**：一个带 `wayfinder:map` 标签的 GitHub Issue，保存 Notes、Decisions-so-far 与 Fog
- **Child ticket**：优先使用 GitHub sub-issue；不可用时，在 Map 的任务列表和 Child 正文中互相引用
- **Type labels**：`wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling`、`wayfinder:task`
- **Blocking**：优先使用 GitHub 原生 Issue dependencies；不可用时，在 Child 顶部使用 `Blocked by: #<n>`
- **Frontier**：从 Map 的开放 Child 中排除仍有开放 blocker 或已被领取的 Issue，按 Map 顺序选择第一项
- **Claim**：`gh issue edit <number> --add-assignee @me`
- **Resolve**：追加答案评论、关闭 Child，并将摘要与链接补入 Map 的 Decisions-so-far

原生依赖 API 使用 blocker 的数据库 ID，而不是 Issue 编号或 `node_id`：

```bash
gh api repos/<owner>/<repo>/issues/<number> --jq .id
gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>
```
