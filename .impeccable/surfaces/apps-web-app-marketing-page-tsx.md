---
version: 1
slug: "apps-web-app-marketing-page-tsx"
primary_target: "apps/web/app/(marketing)/page.tsx"
related_targets: ["apps/web/app/(marketing)/layout.tsx","apps/web/app/globals.css"]
---

# 营销首页 Surface Brief

- 范围与模式：公开营销首页；`Persuade`。
- 受众：面向中国市场、正在主动求职的中高级前端、全栈、AI 应用与 Agent 工程师。
- 用户任务：在数秒内理解 Copilot 会每天筛出最值得处理的岗位与材料任务，而不是提供泛化聊天。
- 主行动：点击“微信登录体验”，进入登录流程；本地开发环境落到 Dev Auth，正式 Beta 接微信 OAuth。
- 核心证明：首屏三张按价值排序的行动简报；第二屏展示简历事实到岗位要求的证据链；明确“由你确认后才继续”和“外部行动 0”。
- 内容约束：演示岗位和状态必须标记为示例；不虚构客户、用户量、奖项、价格、成功率或自动投递能力。
- 体验约束：响应式 Web；中文优先；键盘可达；支持 `prefers-reduced-motion`；首屏不是聊天窗口、后台仪表盘或三等分功能卡。
- 已选方向：`晨间求职内参 / 今日行动优先`，批准稿为 `.impeccable/mocks/landing/morning-brief-daily-actions.png`。
- 记忆点：三张错位叠放的数字简报按优先级轮换到最前；状态只在明确阶段间跳转，不使用含糊进度条。
- 未决事项：正式微信开放平台参数与品牌审核素材待接入；本批次只实现可替换的登录入口和本地 Dev Auth 路由。
