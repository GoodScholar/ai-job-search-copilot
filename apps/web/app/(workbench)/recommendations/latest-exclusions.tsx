"use client";

import { useRef, useState } from "react";
import { RecommendationExclusionPageSchema, type RecommendationList } from "@job-copilot/contracts/recommendations";
import { exclusionReasonText } from "./exclusion-reasons";

export function LatestExclusions({ targetId, list }: { targetId: string; list: RecommendationList }) {
  return <LatestExclusionsState key={list.recommendationListId} targetId={targetId} list={list} />;
}

function LatestExclusionsState({ targetId, list }: { targetId: string; list: RecommendationList }) {
  const [items, setItems] = useState(list.exclusions);
  const [cursor, setCursor] = useState(list.exclusionsNextCursor ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const load = async () => {
    if (!cursor || pending.current) return;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/recommendations/lists/${encodeURIComponent(list.recommendationListId)}/exclusions?targetId=${encodeURIComponent(targetId)}&cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("RECOMMENDATION_EXCLUSIONS_LOAD_FAILED");
      const page = RecommendationExclusionPageSchema.parse(await response.json());
      setItems((current) => [...new Map([...current, ...page.items].map((item) => [`${item.opportunityId}:${item.reasonCode}`, item])).values()]);
      setCursor(page.nextCursor);
    } catch { setError("稳定排除加载失败，请重试。"); }
    finally { pending.current = false; setLoading(false); }
  };
  if (!items.length) return null;
  return <div><p>稳定排除 {items.length} 项岗位：{items.map((item) => exclusionReasonText[item.reasonCode]).join("、")}</p>{error ? <p role="alert">{error}</p> : null}{cursor ? <button className="workbench-touch-target" type="button" disabled={loading} onClick={() => void load()}>{loading ? "加载中" : "加载更多稳定排除"}</button> : null}</div>;
}
