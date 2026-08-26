---
name: AI Job Search Copilot
description: 面向主动求职者的晨间行动内参。
colors:
  ground: "#f3f5f2"
  surface: "#fafbf8"
  ink: "#18201c"
  muted: "#657069"
  emerald: "#246a49"
  emerald-strong: "#18553a"
  amber: "#c98532"
  amber-ink: "#9f5f14"
  rule: "#d5ddd6"
typography:
  display:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "clamp(2.8rem, 3.5vw, 4.2rem)"
    fontWeight: 750
    lineHeight: 1.04
    letterSpacing: "-0.04em"
  body:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "0.75rem"
    fontWeight: 700
    letterSpacing: "0.08em"
rounded:
  control: "0.625rem"
spacing:
  compact: "0.75rem"
  control: "1rem"
  section: "clamp(3.5rem, 8vw, 7rem)"
components:
  login-cta:
    backgroundColor: "{colors.emerald}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "0 1rem"
    height: "2.75rem"
  briefing-paper:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "clamp(1.25rem, 3vw, 2.2rem)"
  status-strip:
    textColor: "{colors.ink}"
    padding: "0 0 0 1.4rem"
---

# Design System: AI Job Search Copilot

## Overview

**Creative North Star: "晨间求职内参"**

页面像一份被优先级整理过的数字档案，而不是聊天入口或后台仪表盘。冷白底和近黑文字保持安静，深祖母绿只用于证据、可继续的行动和可见焦点；琥珀色只标记需要用户确认的边界。

首屏的主角是可切换的三张错位行动简报：一张完整的当前优先纸，配两张尺度更小、仍可读出类型和状态的待处理纸。页面随后用规则线、证据索引和窄状态条延续同一份内参的阅读节奏。

**Key Characteristics:**

- 今日三件行动先于机制说明。
- 证据为深绿，审批为琥珀，状态不只依靠颜色。
- 档案纸是可操作的 tabs，不是静态装饰。

## Colors

冷白纸张承担大面积留白，少量深绿和琥珀分别承载可追溯证据与审批提醒。

### Primary

- **证据深绿**：用于主登录行动、证据标签、离散运行数字与键盘焦点。
- **推进绿**：用于深绿文字在浅色表面上的高对比状态。

### Secondary

- **审批琥珀**：用于指向“由你确认后才继续”的注记箭头。
- **审批墨色**：用于审批说明和候选事实的未确认状态。

### Neutral

- **档案底纸**：页面基础表面。
- **纸张白**：行动简报和边界清晰的控件表面。
- **近黑墨色**：标题与主体阅读文字。
- **静音灰绿**：说明性元数据。
- **细规则线**：分隔内容，不承担状态含义。

**The Evidence Before Accent Rule.** 深绿和琥珀必须同时配合文字状态或标签出现；它们不单独传达证据或审批含义。

## Typography

**Display Font:** PingFang SC、Microsoft YaHei、Noto Sans CJK SC 与系统无衬线回退。

**Body Font:** 同一中文无衬线栈，避免未批准的远程字体。

**Character:** 宽而紧凑的中文标题制造编辑部判断感，正文保持可扫描的行距；所有中文负字距不低于 `-0.04em`。

### Hierarchy

- **Display**（750，`clamp(2.8rem, 3.5vw, 4.2rem)`，1.04）：仅用于首屏承诺。
- **Headline**（默认粗体，`clamp(2rem, 4vw, 3.5rem)`，1.1）：用于后续章节与最终行动。
- **Briefing title**（750，`clamp(1.45rem, 2.3vw, 2rem)`，1.15）：用于当前档案纸与可辨的待处理纸。
- **Body**（400，1rem，1.65）：用于解释性文字，正文容器在宽屏保持有限阅读宽度。
- **Label**（700，0.75rem，0.08em）：用于编号、示例与状态标签。

## Layout

`.container` 最大宽度为 1440px，横向内边距为 `clamp(1.25rem, 4vw, 4rem)`。桌面首屏采用 12 列：标题 5 列、行动简报 5 列、状态条 2 列；小屏改为单列，Header 只保留品牌和主 CTA。

三张行动纸在桌面通过不同的纸张尺度与右侧错位同时露出类型和状态；在移动端恢复为可读的叠放层级。后续章节以规则线分段，并使用 `clamp(3.5rem, 8vw, 7rem)` 维持稀疏但连续的阅读节奏。

## Elevation & Depth

深度仅属于档案纸，使用一条扩散的纸张阴影（`0 24px 70px rgb(24 32 28 / 0.12)`）表示被拿到桌面的当前任务。其余页面通过冷白底、细规则线和错位关系组织层级，不在每个区块上重复使用阴影。

**The Paper-Only Elevation Rule.** 阴影用于优先级纸张，不用于下半页的说明段或普通控件。

## Shapes

档案纸与内容段落以直线规则边界为主。主 CTA 使用柔和控制圆角（0.625rem）；页面不使用大面积圆角卡片、厚色侧边条或装饰性玻璃效果。

## Components

### Buttons

- **Shape:** 柔和控制圆角（0.625rem）。
- **Primary:** 深绿底、纸张白文字，至少 44px 高（2.75rem），文案固定为清晰动作“微信登录体验”。
- **Hover / Focus:** Hover 加深背景；focus-visible 使用 2px 深绿轮廓与底色外扩。

### Navigation

- **Style:** 顶部细规则线下的单行品牌与导航。桌面展示页内锚点与 CTA；640px 以下隐藏页内锚点，保留品牌与 CTA，避免中文逐字换行。

### Action Briefing Tabs

- **Style:** 每张纸本身是可点击的 `tab`，当前项与 `tabpanel` 通过 `aria-controls` 和 `aria-labelledby` 关联。
- **State:** 当前纸完整展示；另外两张仍显示任务类型和关键状态。方向键、Home、End 可切换并将焦点移到活动纸；非活动详情标记为 `aria-hidden`，不造成三篇连续阅读。
- **Motion:** 纸张只在三种明确排序间切换；`prefers-reduced-motion` 下立即完成状态切换。

### Status Strip

- **Style:** 右侧窄规则线、离散任务数字与琥珀箭头注记。
- **Content:** 运行状态只列“正在检查”“已完成”“外部行动 0”等离散事实，不使用连续进度条。

### Evidence Chain

- **Style:** 一条深绿 1px 证据线串联来源、已验证画像、岗位要求和推荐解释；圆点编号用于真实的证据顺序。

## Do's and Don'ts

- Do 先交代今天的行动，再解释 Copilot 如何工作。
- Do 在候选事实确认前明确其未计入匹配分或正式画像证据。
- Do 用键盘可达的真实控件承载纸张切换，并在移动端保持 44px 触控高度。
- Don't 把首页做成聊天窗口、后台仪表盘或三张等权功能卡。
- Don't 使用远程字体、虚构 Logo、客户背书、成功率或自动投递承诺。
- Don't 用颜色、厚侧边条、连续进度条或无限轮播单独表达状态。
