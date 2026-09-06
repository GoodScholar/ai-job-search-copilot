"use client";

import type { FirstRecommendationJourney, FirstRecommendationJourneyInteractionCommand, FirstRecommendationJourneyStepId } from "@job-copilot/contracts/workbench";
import Link from "next/link";
import { useState } from "react";

type FirstRecommendationJourneyPanelProps = {
  journey: FirstRecommendationJourney | null;
  onAuthoritativeRefresh: () => void;
};

const interactionEndpoint = "/api/workbench/first-recommendation-journey";

async function updateInteraction(command: FirstRecommendationJourneyInteractionCommand) {
  return fetch(interactionEndpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
    keepalive: true,
  });
}

export function FirstRecommendationJourneyPanel({ journey, onAuthoritativeRefresh }: FirstRecommendationJourneyPanelProps) {
  if (journey === null) {
    return <section aria-labelledby="first-recommendation-journey-unavailable-title" className="workbench-ledger first-recommendation-journey-unavailable">
      <h2 id="first-recommendation-journey-unavailable-title">首次推荐旅程暂时无法读取</h2>
      <p>其余工作台内容仍可使用，请稍后刷新重试。</p>
    </section>;
  }
  if (journey.status === "dismissed" || journey.status === "completed") return null;

  return <ActiveFirstRecommendationJourneyPanel key={`${journey.status}:${journey.interactionVersion}`} journey={journey} onAuthoritativeRefresh={onAuthoritativeRefresh} />;
}

function ActiveFirstRecommendationJourneyPanel({ journey, onAuthoritativeRefresh }: { journey: Extract<FirstRecommendationJourney, { status: "active" }>; onAuthoritativeRefresh: () => void }) {
  const [dismissal, setDismissal] = useState<"idle" | "pending" | "hidden">("idle");
  const [dismissError, setDismissError] = useState(false);

  function saveVisit(stepId: FirstRecommendationJourneyStepId) {
    void updateInteraction({ action: "visit_step", stepId, expectedVersion: journey.interactionVersion })
      .then((response) => {
        if (response.ok || response.status === 409) onAuthoritativeRefresh();
      })
      .catch(() => undefined);
  }

  async function dismiss() {
    setDismissal("pending");
    setDismissError(false);
    try {
      const response = await updateInteraction({ action: "dismiss", expectedVersion: journey.interactionVersion });
      if (response.status === 409) {
        setDismissal("idle");
        onAuthoritativeRefresh();
        return;
      }
      if (!response.ok) throw new Error("dismiss failed");
      setDismissal("hidden");
      onAuthoritativeRefresh();
    } catch {
      setDismissal("idle");
      setDismissError(true);
    }
  }

  if (dismissal === "hidden") return <p className="first-recommendation-journey-live" role="status" aria-live="polite">已暂时关闭首次推荐旅程。</p>;

  return <section aria-labelledby="first-recommendation-journey-title" className="workbench-ledger first-recommendation-journey">
    <div className="first-recommendation-journey-heading">
      <div><h2 id="first-recommendation-journey-title">首次推荐旅程</h2><p>每一步都来自当前真实状态；完成准备后，即可获得第一份可信推荐。</p></div>
      <button className="workbench-touch-target first-recommendation-journey-dismiss" disabled={dismissal === "pending"} onClick={dismiss} type="button">暂时关闭引导</button>
    </div>
    {dismissError && <p className="first-recommendation-journey-error" role="alert">暂时无法关闭引导，请重试。</p>}
    <ol className="first-recommendation-journey-list">
      {journey.steps.map((step) => <li aria-current={step.id === journey.currentStepId ? "step" : undefined} data-status={step.status} key={step.id}>
        <div className="first-recommendation-journey-step-copy"><h3>{step.title}</h3><p className="first-recommendation-journey-state">{step.stateLabel}</p><p>{step.impact}</p></div>
        <Link className="workbench-ledger-link workbench-touch-target" href={step.action.href} onClick={() => saveVisit(step.id)}>{step.action.label}</Link>
      </li>)}
    </ol>
  </section>;
}
