# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

- pnpm workspace
- Next.js App Router、React、TypeScript
- Tailwind CSS、shadcn/ui
- NestJS、Fastify、REST/OpenAPI
- NestJS standalone Worker、BullMQ
- PostgreSQL、Drizzle ORM、Redis、S3-compatible object storage
- Zod、SSE、Vitest、Testcontainers、Playwright
- OpenTelemetry、Sentry
- 本地开发使用 Docker Compose、PostgreSQL、Redis、MinIO、Mailpit

## Users

主要用户是在中国市场寻找中高级互联网或 AI 技术岗位的求职者，首期覆盖前端、全栈、AI 应用和 Agent 工程方向。他们需要持续处理分散的岗位来源、判断匹配质量、定制材料并跟踪投递，但不希望学习 Claude Code 或配置开发者工作流。

## Product Purpose

AI Job Search Copilot 持续发现和筛选岗位机会，每天把大量候选缩小为少量“值得投”的推荐，并在用户授权下推进材料准备和投递跟踪。首要成功指标是用户每周实际采纳的推荐岗位，包括收藏、准备投递和完成投递；面试进展、忽略原因和推荐采纳率用于评估长期价值。

## Positioning

产品不是聊天机器人、岗位搜索框或自动投递器。它以长期求职画像和可追溯证据为基础，通过受约束且可恢复的 Agent 运行持续完成岗位发现、资格判断、深度匹配和材料准备。Agent 可以自主执行内部分析，任何向外部页面写入个人信息、真实投递、表单提交、邮件或招聘者联系都必须绑定用户看到的最终内容并获得明确审批。

## Operating Context

- 用户上传或导入 Markdown、DOCX、PDF 简历，系统解析为结构化求职画像；AI 解析产生的候选事实必须经来源验证或用户确认。
- 用户维护求职目标和目标公司 Watchlist，也可以即时导入岗位链接、职位描述或 Markdown 内容。
- Agent 每日检查公开公司招聘官网和已接入 ATS，先做资格门槛与粗排，再对少量候选执行证据驱动的深度匹配。
- 用户通过求职工作台查看今日推荐、待确认事项、Agent 运行状态和投递记录；聊天只作为辅助入口。
- Agent Inbox 是每日发现、审批请求、失败结果和截止提醒的站内权威记录；每日邮件摘要由用户选择开启。
- 用户可从已验证画像证据生成岗位定制简历，并导出 Markdown、DOCX 和 PDF。
- MVP 与正式 Beta 由用户在外部招聘页面完成投递；正式 Beta 之后可以逐站引入用户侧浏览器辅助执行，但填写和最终提交必须分别审批。

## Capabilities and Constraints

- MVP 包含：简历导入、求职画像、岗位导入与发现、规范化与去重、混合匹配、推荐解释、收藏或忽略、定制简历、投递跟踪。
- V1 只有求职者角色，每个账户只有一个主要画像；允许主动创建只读分享，但不包含雇主、教练或团队协作角色。
- 匹配先执行确定性资格门槛，再使用模型根据画像证据进行语义评分；匹配结果按画像、岗位、规则、提示词和模型版本保存为不可变记录。
- 结构化简历模型是内容单一事实来源。Markdown 是一级导入与导出格式，但导入修改先形成草稿并通过差异确认，不能直接覆盖已确认版本。
- Agent 运行具有工具白名单、成本预算、重试上限、暂停点和终止条件，并支持恢复、取消和失败解释。
- 岗位网页、岗位描述和职业文件是不可信数据，不能改变 Agent 指令或权限；解析与抓取在隔离边界执行，PII 不进入普通日志。
- 本地邀请制 Beta 不包含支付、自动外部行动、服务器端 BOSS 直聘自动化、封面信、面试训练、Gmail/Notion 集成或自定义招聘源开发工具。
- 正式 Beta 以微信 OAuth 为主要登录方式，本地开发使用 Dev Auth；邮箱仅用于摘要和恢复辅助。
- 正式 Beta 之后的浏览器辅助执行只在用户侧使用招聘平台登录态，按已审批的不可变投递内容逐次执行；不提供批量海投、验证码绕过、反检测或服务器端招聘平台账号托管。
- 模型通过 OpenAI Responses API 适配层调用，业务状态由应用持有；模型、提示词和评分规则变更必须通过版本化评测集。

## Brand Commitments

- 产品名称：AI Job Search Copilot；界面短名称可使用 Job Copilot。
- 面向普通求职者使用结果导向、清晰、可信的中文表达，界面名称描述用户能控制的结果，不暴露内部 Agent 技术术语。
- 交互以工作台为中心，首页采用 Agent 任务中心结构，顶层导航为首页、推荐、投递和画像。
- 尚未确认正式 Logo、品牌色、字体或其他品牌资产，后续设计不得把探索性视觉当成既有品牌事实。

## Evidence on Hand

- [CONTEXT.md](./CONTEXT.md) 记录已确认的领域语言。
- [docs/adr](./docs/adr) 记录产品、Agent、数据、安全和技术架构决策。
- 原始 `ai-job-search` 仓库提供 Claude Code 命令、门户适配器、简历和岗位处理逻辑作为迁移参考，但不构成可直接复用的生产 Web 架构。
- [`feder-cr/Jobs_Applier_AI_Agent_AIHawk`](https://github.com/feder-cr/Jobs_Applier_AI_Agent_AIHawk) 提供自动投递流程和浏览器失败场景的研究参考；本项目不把第三方自动投递项目作为运行时依赖，也不复制其实现。
- 当前没有可公开使用的客户 Logo、客户评价、成功案例、转化率、用户规模、招聘结果数据或品牌视觉资产；营销页面不得编造这些证据。

## Product Principles

1. 每次打开产品，都先回答“今天哪些岗位值得处理”。
2. 所有匹配和材料内容都必须回到可追溯的真实证据。
3. Agent 自动完成内部分析，用户保留外部行动的最终决定权。
4. 用结构化领域记录形成长期记忆，不把聊天历史当作事实来源。
5. 先做少量可信推荐和清晰审批，再扩展自动化范围。

## Accessibility & Inclusion

- 响应式 Web 优先，桌面端支持深度工作，移动端支持查看推荐和处理审批。
- 关键流程必须支持键盘操作、可见焦点、语义化控件和屏幕阅读器标签。
- 正文与交互控件达到 WCAG AA 对比度，状态不能只依赖颜色表达。
- 动画遵循 `prefers-reduced-motion`，高动效不得阻碍阅读、审批或投递操作。
- 微信登录之外保留可访问的辅助恢复路径，避免把单一外部身份当作内部用户 ID。
