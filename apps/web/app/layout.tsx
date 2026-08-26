/*
THESIS: 每天只交付三件最值得处理的求职行动，拒绝通用 AI SaaS 的截图加三卡布局。
OWN-WORLD: 冷白档案纸、近黑墨色、深祖母绿、克制琥珀批注与精确证据索引。
STORY: 用户先看见结果，再相信证据，最后在保留审批权的前提下登录体验。
FIRST VIEWPORT: 左侧标题与微信 CTA；中央三张错位行动简报；右侧离散 Agent 状态条与审批批注。
FORM: 晨间求职内参 / 今日行动优先；三版构图中的第 3 版；seed 4e302c13。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
*/
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Job Search Copilot",
  description: "每天筛出最值得处理的技术岗位，并用真实证据解释推荐",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN">
      <body data-impeccable-seed="4e302c13">{children}</body>
    </html>
  );
}
