---
version: 1
slug: "apps-web-app-workbench-home-page-tsx"
primary_target: "apps/web/app/(workbench)/home/page.tsx"
related_targets: ["apps/web/components/workbench/recommendation-run-panel.tsx","apps/web/components/workbench/workbench-home-view.tsx"]
---

# 工作台完整推荐入口

Mode: Operate。范围是已批准Issue53 Task8的现有首页局部扩展，不是整页重设计。用户已确认实施计划并要求继续；保留当前工作台、定时发现、历史物理运行与Inbox行为。Task7审查通过后才实施。

主要任务：普通求职者从主目标和准备摘要启动一次完整推荐，确认警告，离页后恢复查看五阶段状态，并主动暂停、继续或取消。未完成、失败、取消和可信空结果必须分开表达。

## Direction contract

THESIS: 在现有工作台中建立一个权威的完整推荐入口；不把五阶段拆成五个互不关联的启动按钮，也不显示虚构百分比进度。

OWN-WORLD: 沿用DESIGN.md的冷白表面、墨色文字、证据深绿、确认琥珀和现有workbench控件；保持中文系统字体与细规则线，不新增字体、图标库、圆角卡片体系或动效运行时。

STORY: 用户先看本次主目标、来源与预算摘要，再启动或确认警告；运行中看到当前阶段与可用控制，终态得到绑定本次结果的入口或明确修复方向。

FIRST VIEWPORT: 沿用既有首页组成与信息顺序，在原手动发现入口职责处加入单一推荐面板。面板顶部为标题与摘要，接主操作/警告确认，其后五阶段有序列表和状态说明；窄屏按相同语义顺序纵向展开，所有操作至少44px。

FORM: 继承现有工作台局部扩展，无新概念竞赛、seed或新视觉世界，也无待复刻的生成图comp。交互特点是可见页才轮询、终态停止、状态刷新不抢焦点；保留旧面板中的定时发现与物理历史。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

约束：不新增shipping raster；不改全局设计体系。自动检查与桌面/窄屏浏览器验证分别记录；截图自查最多两轮，机械检测一次，独立视觉验收和文档对照由root调度。新失败提示与preflight沿用服务端有限建议，不反射不可信正文。
