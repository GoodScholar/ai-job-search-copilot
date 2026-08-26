"use client";

import { useRef, useState } from "react";

export type BriefingId = "recommendation" | "facts" | "resume";

const briefings = [
  { id: "recommendation", label: "AI 应用工程师", state: "匹配 91" },
  { id: "facts", label: "确认 2 条候选事实", state: "待你确认" },
  { id: "resume", label: "审核 1 份定制简历", state: "待你审核" },
] as const;

type BriefingStackProps = {
  initialId?: BriefingId;
};

export function BriefingStack({
  initialId = "recommendation",
}: BriefingStackProps) {
  const [activeId, setActiveId] = useState<BriefingId>(initialId);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = briefings.findIndex(({ id }) => id === activeId);

  function selectBriefing(id: BriefingId) {
    setActiveId(id);
  }

  function handleTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const nextIndexByKey: Record<string, number> = {
      ArrowRight: (index + 1) % briefings.length,
      ArrowDown: (index + 1) % briefings.length,
      ArrowLeft: (index - 1 + briefings.length) % briefings.length,
      ArrowUp: (index - 1 + briefings.length) % briefings.length,
      Home: 0,
      End: briefings.length - 1,
    };
    const nextIndex = nextIndexByKey[event.key];

    if (nextIndex === undefined) {
      return;
    }

    event.preventDefault();
    const nextBriefing = briefings[nextIndex];
    selectBriefing(nextBriefing.id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <div className="briefing-stack" aria-label="今日行动简报">
      <div aria-label="切换行动简报" className="briefing-cards" role="tablist">
        {briefings.map((briefing, index) => {
          const position = (index - activeIndex + briefings.length) % briefings.length;
          const isActive = briefing.id === activeId;

          return (
            <button
              aria-controls={`briefing-panel-${briefing.id}`}
              aria-label={`${briefing.label}（示例）`}
              aria-selected={isActive}
              className="briefing-card"
              data-active={isActive}
              data-position={position}
              id={`briefing-tab-${briefing.id}`}
              key={briefing.id}
              onClick={() => selectBriefing(briefing.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              type="button"
            >
              <span aria-hidden="true" className="briefing-card-content">
                <span className="briefing-card-heading">
                  <span>
                    {String(index + 1).padStart(2, "0")} / {isActive ? "当前优先" : "待处理"}
                  </span>
                  <span>示例</span>
                </span>
                {isActive ? (
                  <BriefingContent id={briefing.id} />
                ) : (
                  <span className="briefing-card-glance">
                    <span>{briefing.label}</span>
                    <strong>{briefing.state}</strong>
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {briefings.map((briefing) => (
        <section
          aria-hidden={briefing.id !== activeId}
          aria-labelledby={`briefing-tab-${briefing.id}`}
          className="sr-only"
          id={`briefing-panel-${briefing.id}`}
          key={briefing.id}
          role="tabpanel"
        >
          <BriefingContent id={briefing.id} />
        </section>
      ))}
    </div>
  );
}

function BriefingContent({ id }: { id: BriefingId }) {
  if (id === "recommendation") {
    return <RecommendationBriefing />;
  }

  if (id === "facts") {
    return <FactsBriefing />;
  }

  return <ResumeBriefing />;
}

function RecommendationBriefing() {
  return (
    <>
      <span className="briefing-card-title">
        <span>AI 应用工程师</span>
        <span>
          匹配 <strong>91</strong>
        </span>
      </span>
      <span className="briefing-meta">极光科技 · 北京 · 25–40K · 发布 2 小时</span>
      <span className="briefing-evidence">
        <strong>强证据</strong>
        <span>React 架构 · Agent 工作流</span>
      </span>
      <span className="briefing-gap">
        <strong>主要缺口</strong>
        <span>大模型评测经验</span>
      </span>
      <span className="briefing-footnote">推荐理由：你的项目经历与岗位要求逐条对照（示例）</span>
    </>
  );
}

function FactsBriefing() {
  return (
    <>
      <span className="briefing-card-title">确认 2 条候选事实</span>
      <span className="briefing-meta">这些事实将在你确认后用于后续材料准备（示例）</span>
      <span className="briefing-checklist">
        <span>
          <strong>候选事实 1</strong>
          <span>岗位使用 React 18 + RSC</span>
        </span>
        <span>
          <strong>候选事实 2</strong>
          <span>项目包含大模型评测相关经验</span>
        </span>
      </span>
      <span className="briefing-candidate-note">
        待确认，尚未计入当前 91 分或正式画像证据（示例）
      </span>
      <span className="briefing-footnote">来源待你核验；确认不等于自动执行（示例）</span>
    </>
  );
}

function ResumeBriefing() {
  return (
    <>
      <span className="briefing-card-title">审核 1 份定制简历</span>
      <span className="briefing-meta">针对该岗位的 Markdown 简历草稿（示例）</span>
      <span aria-label="Markdown 简历审阅示例" className="briefing-markdown">
        <span># AI 应用工程师</span>
        <span>## React 架构与 Agent 工作流</span>
        <span>- 补充：大模型评测的影响与结果</span>
      </span>
      <span className="briefing-footnote">先审核，再决定是否继续（示例）</span>
    </>
  );
}
