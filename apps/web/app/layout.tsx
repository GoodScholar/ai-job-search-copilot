/*
THESIS: 让求职者先看见值得判断的机会、真实证据和可控的下一步。
OWN-WORLD: 冷白工作区、深海蓝信息骨架、电蓝行动、青色 AI 状态与克制的琥珀确认状态。
STORY: 用户先处理今天的决定，再回到岗位与画像证据，始终保留外部行动审批权。
FIRST VIEWPORT: 清晰价值主张、真实产品场景和可替换的登录入口。
FORM: 现代专业科技感的求职工作台；视觉以任务结构而非装饰卡片区分信息层级。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
*/
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Job Search Copilot",
  description: "每天筛出最值得处理的技术岗位，并用真实证据解释推荐",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body data-impeccable-seed="4e302c13">{children}</body>
    </html>
  );
}
