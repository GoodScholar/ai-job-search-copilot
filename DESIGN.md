# AI Job Search Copilot 设计系统

## 设计目标

界面帮助中国市场的中高级技术岗位求职者每天处理少量可信机会。工作台优先展示待决定事项、真实岗位与画像证据，以及可恢复的 AI 工作状态；它不模拟自动投递，也不把示例内容伪装为真实结果。

## 视觉令牌

| 用途 | 色值 |
| --- | --- |
| 工作区 | `#F5F7FB` |
| 内容面 | `#FFFFFF` |
| 导航与主要文字 | `#10243A` |
| 主行动与当前选择 | `#245FE5` |
| AI 完成状态 | `#147A79` |
| 待确认 | `#D18A20` |
| 错误 | `#C63B4D` |
| 边界 | `#D7E0EC` |

使用中文系统无衬线。间距按 8px 节奏；内容面圆角 12px，控件圆角 8px。阴影仅用于主要行动或浮起的内容面，普通信息分区用边框区分。

## 产品结构

桌面端使用 232px 深海蓝侧导航和最大 1184px 内容区；移动端收束为四项底部语义导航，所有主控件至少 44px 高。移动导航和页面底部使用 `safe-area-inset-bottom`，退出入口保留在可触达的页面顶部。首页将真实摘要、今日主行动、运行阶段和待决定事项分区；推荐将岗位主体、行动和可展开的岗位/画像证据并列；画像优先展示已确认事实，导入和维护作为聚焦编辑区。

运行进度只呈现后端已有的离散阶段和状态文本。证据不足、待确认和错误必须同时通过文案与颜色呈现。必要的设置对照表可在容器内横向滚动，页面本身不能发生横向溢出。

## 营销与认证

营销页使用与工作台相同的冷白、深海蓝和电蓝身份，展示“发现—判断—决定”的产品场景。所有岗位、运行和材料场景均标注为示例；不使用客户标识、成功率、自动投递或未经证实的数据。登录页保持 Dev Auth 和微信 OAuth 的现有边界。

## 动效与无障碍

原生 CSS 仅用于 160ms 的控件反馈和 220ms 的展开反馈，位移不超过 8px。`prefers-reduced-motion` 会关闭非必要过渡。键盘焦点使用电蓝双层焦点环；正文和交互控件满足 WCAG AA 对比度目标。

## 参考与许可

采用现有 Base UI/shadcn、原生语义导航与 `details` 的模式，不新增 UI 或动画 runtime。NameThatUI 的 Steps、Disclosure、Bottom Navigation、Inline Alert 与 Empty State 只作为已核实的通用交互模式；其源码许可未核实，因此不复制其代码、素材或提示词。参考许可记录在 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)：[shadcn/ui](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md)、[Reactive Resume](https://github.com/AmruthPillai/Reactive-Resume/blob/main/LICENSE) 与 [Tabler Icons](https://github.com/tabler/tabler-icons/blob/main/LICENSE) 为 MIT；[Plane](https://github.com/makeplane/plane/blob/preview/LICENSE.txt) 为 AGPL-3.0、Twenty API 为 NOASSERTION，均只研究公开模式且不复制代码。Motion Primitives 与 MagicUI 未采用。
