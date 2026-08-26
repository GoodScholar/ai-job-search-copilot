# 使用 React 与 Next.js Web 技术栈

Web 使用 Next.js App Router、React、TypeScript、Tailwind CSS 和 shadcn/ui；Next.js 负责求职工作台渲染与 BFF，不承载长时间 Agent 运行。NestJS + Fastify 提供领域入口和 REST/OpenAPI，独立 NestJS Worker 通过 Redis + BullMQ 执行后台任务；PostgreSQL + Drizzle ORM 保存业务状态，S3 兼容对象存储保存职业资料，SSE 传递运行进度。代码组织为 pnpm workspace，领域、共享契约、模型端口和 Adapter 分别位于内部 package。

## Consequences

- React Server Components 默认承担读取型页面，Client Components 只用于必要交互，减少客户端包与数据瀑布。
- Next.js Route Handler 和 Server Action 不成为领域模块的唯一入口，也不执行长任务。
- Web、API 和 Worker 可以分别部署，但仍属于同一个模块化单体并共享领域模块。
