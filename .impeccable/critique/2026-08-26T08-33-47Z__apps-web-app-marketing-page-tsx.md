---
target: AI Job Search Copilot 营销首页
total_score: 19
max_score: 32
na_heuristics: 7,10
p0_count: 0
p1_count: 3
timestamp: 2026-08-26T08-33-47Z
slug: apps-web-app-marketing-page-tsx
---
# Task 7 — Impeccable 合并设计批评

Method: dual-agent (A: task_7_critique_a · B: task_7_critique_b)

目标：`apps/web/app/(marketing)/page.tsx` 及其营销首页组件
视口：桌面 `1440×900`、移动 `390×844`
批准稿：`.impeccable/mocks/landing/morning-brief-daily-actions.png`

## Design Health Score

`7` 与 `10` 对 Persuade 型营销首页标记为 `n/a`；其余 8 项的适用满分为 32。

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 2 | 切换有按下状态，但三张非活动简报仍同时进入辅助技术阅读顺序，当前简报缺少明确语义。 |
| 2 | Match Between System and Real World | 3 | 求职决策语言可信；RSC、Agent、Markdown 一级格式仍偏技术化。 |
| 3 | User Control and Freedom | 3 | 简报可往返切换，锚点与登录入口明确。 |
| 4 | Consistency and Standards | 2 | 桌面系统统一，但 390px Header 导航逐字竖排，移动首屏像布局损坏。 |
| 5 | Error Prevention | 3 | 示例和审批边界清楚；“主要缺口”与“候选事实”关系仍需解释。 |
| 6 | Recognition Rather Than Recall | 2 | 只有前卡可读，理解三件事需要逐张切换并记忆。 |
| 7 | Flexibility and Efficiency of Use | n/a | 营销首页没有专家重复任务。 |
| 8 | Aesthetic and Minimalist Design | 2 | 视觉世界成立，但宽标题、三张同时可辨的核心构图与第二折节奏未兑现。 |
| 9 | Error Recovery | 2 | 本页未展示登录失败或微信不可用时的恢复说明。 |
| 10 | Help and Documentation | n/a | 营销首页不要求完整帮助系统。 |
| **Total** | | **19/32** | **59% · Acceptable** |

## Design Specificity Verdict

内容高度产品专属，视觉表达只有中等特定性。页面已经拥有“每日三件高价值行动、证据链、审批边界、外部行动 0”的独特产品语言，也有冷白档案纸、深绿证据和琥珀审批批注构成的统一世界。但批准稿最可记忆的三张错位行动简报被实现成“一张完整卡片、两张幽灵底纸、三枚等权按钮”，下半页又退回通用 B2B 长文结构。

Deterministic scan 对 `apps/web/app/(marketing)`、`apps/web/components/landing` 和 `apps/web/app/globals.css` 得到 1 条有效 finding：`side-tab`，位于 `globals.css:352`，当前 briefing 按钮使用 3px 单侧 inset 强调条。浏览器 overlay 得到 21 条提示，其中 14 条 `text-occlusion` 来自有意叠放的非活动卡片，属于上下文误报；其余提示集中在 eyebrow、宽阴影、11.52px 小字和低于 `-0.04em` 的负字距。

浏览器 dogfood 复现 2 个独立产品问题：390px Header 导航被压成单字竖列（medium），三处主 CTA 高度仅 36px（low）。CTA 路由、鼠标/键盘简报切换、页面级无横向溢出、焦点和 reduced-motion 均通过；早期 127.0.0.1 下的无响应已确认是 Next dev 跨源环境假象，不计入产品问题。

## Overall Impression

这是一个产品判断已经清楚、但构图仍停留在可用原型阶段的首页。最大机会不是加更多效果，而是完整兑现已经批准的那个强概念：让访客第一眼同时看见“三件行动”，同时把移动端第一个破版状态彻底清掉。

## What's Working

1. 产品真相与边界可信：示例、证据来源、缺口和“外部行动 0”都没有伪造商业结果或自动投递能力。
2. 颜色语义一致：冷白、近黑、深绿和琥珀的角色稳定，核心组合满足正文 AA。
3. 基础交互可靠：简报可点击和键盘切换，焦点可见，CTA 正确进入 `/login?returnTo=%2F`，移动无页面级横向滚动。

## Priority Issues

### [P1] 移动 Header 逐字竖排

- **Why it matters**：用户在价值主张之前先看到明显破版，直接损害可信感；导航宽度也小于 44px。
- **Fix**：移动断点只保留品牌与主 CTA，隐藏页内锚点；CTA 保持至少 44px 高。
- **Suggested command**：`$impeccable polish`

### [P1] 首屏未兑现“三张简报同时可辨”

- **Why it matters**：批准稿最强的产品特异性丢失，访客需要理解 tabs 才能知道三件事。
- **Fix**：用更宽 H1 和更有尺度差的错位叠放；至少让三张纸的类型、标题和关键状态同时可辨，并允许点纸置前；弱化或移除等权 side-tab 视觉。
- **Suggested command**：`$impeccable bolder`

### [P1] 缺口与候选事实的状态关系含糊

- **Why it matters**：用户无法判断 91 分是否使用了未经确认的经历，动摇证据可信度。
- **Fix**：明确写出“尚未计入匹配 / 待确认”，让候选事实在确认前不作为正式画像证据。
- **Suggested command**：`$impeccable clarify`

### [P2] 视觉状态与辅助技术状态不一致

- **Why it matters**：视觉用户只读前卡，屏幕阅读器却连续读三卡，且当前简报没有语义关联。
- **Fix**：将控制器实现为 tabs/tabpanels，使用 `aria-controls`、`aria-selected`，只让活动 panel 进入正常阅读顺序。
- **Suggested command**：`$impeccable polish`

### [P2] 下半页节奏模板化、中文负字距过紧

- **Why it matters**：越往下越像通用 B2B 长文，首屏建立的档案索引世界没有延续。
- **Fix**：在不增加新能力的前提下减少重复 kicker，把证据链与审批边界组织为更紧凑的第二峰值；标题字距收回 `-0.02em` 至 `-0.04em`。
- **Suggested command**：`$impeccable polish`

## Cognitive Load

8 项检查中失败 3 项：single focus、visual hierarchy、working memory；属于中等负荷。分组、chunking、单次决策、最少选择和渐进披露本身成立。主要负荷来自首屏多个同权入口，以及两张不可辨底纸迫使用户记忆前一卡内容。

## Emotional Journey

“今天只处理三件事”建立控制感，91 分与强证据形成第一峰值；随后三件事不能同时看清、移动 Header 破版形成低谷。证据与审批段恢复信任，但长下半页缺少第二个视觉峰值，结束稳健却不够可记忆。

## Persona Red Flags

- **Jordan（首次使用）**：移动导航像页面损坏；RSC/Agent 等术语偏技术化；重复 CTA 与三枚简报按钮争夺主行动。
- **Riley（压力测试）**：会追问 91 分是否计入待确认经历；视觉卡片状态和辅助技术阅读模型不一致。
- **Casey（移动使用）**：Header 高 120px 且逐字竖排，三处 CTA 仅 36px 高，核心审批和运行状态落在首屏以下。

## Minor Observations

- Hero CTA 缺少批准稿中的微信图标，当前尺寸更像工具栏动作。
- 琥珀批注失去指向具体审批边界的箭头关系。
- 运行状态的数字在 `dt` 与 `dd` 中重复。
- 品牌资产尚未确认时不应虚构 Logo，但应保留稳定的品牌占位结构。

## Calibration Decision

选择 **`bolder`**，只放大已经批准的首屏“档案纸 + 三件行动 + 琥珀审批批注”语言；不同时执行 `quieter`。依据是页面当前最大差距是产品特异性和首屏尺度不足，而不是色彩或动效过度。移动 Header、触控高度、语义和字距属于随后 `polish` 的局部缺陷修复。

## Questions and confirmed answers

本轮问题已由此前的用户决定覆盖：优先处理全部建议；保持“晨间求职内参”视觉世界；在 bolder/quieter 中按实测选择一个；外部行动、真实性和微信登录边界不变。因此不再重复阻塞式提问，直接执行上述 5 项修复。

## Run Notes

- target slug：`apps-web-app-marketing-page-tsx`
- ignore list：`.impeccable/critique/ignore.md` 不存在
- assessment independence：A、B 分别在隔离 Agent 中完成，A 在 B 结果进入父上下文前完成
- CLI detector：exit 2，1 条有效 `side-tab`
- browser visibility：两个独立 headless session，桌面/移动截图、snapshot、console/errors 均已保存
- overlay injection：B 的 mutable preflight 和注入成功；因 headless 不宣称用户可见 `[Human]` tab
- live-server cleanup：A/B 启动的页面服务、overlay 服务和 browser sessions 均已关闭
- temp cleanup：B 的精确临时镜像已移入废纸篓；证据目录保留
