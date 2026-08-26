"use client";

import { useState } from "react";

export type BriefingId = "recommendation" | "facts" | "resume";

const briefings = [
  { id: "recommendation", label: "AI 应用工程师", action: "查看岗位推荐" },
  { id: "facts", label: "确认 2 条候选事实", action: "查看确认 2 条候选事实" },
  { id: "resume", label: "审核 1 份定制简历", action: "查看审核 1 份定制简历" },
] as const;

type BriefingStackProps = {
  initialId?: BriefingId;
};

export function BriefingStack({
  initialId = "recommendation",
}: BriefingStackProps) {
  const [activeId, setActiveId] = useState<BriefingId>(initialId);
  const activeIndex = briefings.findIndex(({ id }) => id === activeId);

  return (
    <section className="briefing-stack" aria-label="今日行动简报">
      <div className="briefing-switcher" aria-label="切换行动简报">
        {briefings.map((briefing) => (
          <button
            aria-pressed={briefing.id === activeId}
            className="briefing-switcher-button"
            key={briefing.id}
            onClick={() => setActiveId(briefing.id)}
            type="button"
          >
            {briefing.action}
          </button>
        ))}
      </div>

      <div className="briefing-cards">
        {briefings.map((briefing, index) => {
          const position = (index - activeIndex + briefings.length) % briefings.length;
          const isActive = briefing.id === activeId;

          return (
            <article
              aria-label={`${briefing.label}（示例）`}
              className="briefing-card"
              data-active={isActive}
              data-position={position}
              key={briefing.id}
            >
              <div className="briefing-card-heading">
                <p>
                  {String(index + 1).padStart(2, "0")} / {isActive ? "当前优先" : "待处理"}
                </p>
                <span>示例</span>
              </div>
              {briefing.id === "recommendation" ? <RecommendationBriefing /> : null}
              {briefing.id === "facts" ? <FactsBriefing /> : null}
              {briefing.id === "resume" ? <ResumeBriefing /> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function RecommendationBriefing() {
  return (
    <>
      <div className="briefing-card-title">
        <h2>AI 应用工程师</h2>
        <p>
          匹配 <strong>91</strong>
        </p>
      </div>
      <p className="briefing-meta">极光科技 · 北京 · 25–40K · 发布 2 小时</p>
      <div className="briefing-evidence">
        <h3>强证据</h3>
        <ul>
          <li>React 架构</li>
          <li>Agent 工作流</li>
        </ul>
      </div>
      <div className="briefing-gap">
        <h3>主要缺口</h3>
        <p>大模型评测经验</p>
      </div>
      <p className="briefing-footnote">推荐理由：你的项目经历与岗位要求逐条对照（示例）</p>
    </>
  );
}

function FactsBriefing() {
  return (
    <>
      <h2>确认 2 条候选事实</h2>
      <p className="briefing-meta">这些事实将在你确认后用于后续材料准备（示例）</p>
      <ol className="briefing-checklist">
        <li>
          <strong>候选事实 1</strong>
          <span>岗位使用 React 18 + RSC</span>
        </li>
        <li>
          <strong>候选事实 2</strong>
          <span>项目包含大模型评测相关经验</span>
        </li>
      </ol>
      <p className="briefing-footnote">来源待你核验；确认不等于自动执行（示例）</p>
    </>
  );
}

function ResumeBriefing() {
  return (
    <>
      <h2>审核 1 份定制简历</h2>
      <p className="briefing-meta">针对该岗位的 Markdown 简历草稿（示例）</p>
      <div className="briefing-markdown" aria-label="Markdown 简历审阅示例">
        <p># AI 应用工程师</p>
        <p>## React 架构与 Agent 工作流</p>
        <p>- 补充：大模型评测的影响与结果</p>
      </div>
      <p className="briefing-footnote">先审核，再决定是否继续（示例）</p>
    </>
  );
}
