"use client";

import { useRef, useState } from "react";
import { RecommendationExclusionPageSchema, type RecommendationList } from "@job-copilot/contracts/recommendations";

export function LatestExclusions({ targetId, list }: { targetId: string; list: RecommendationList }) {
  const [items, setItems] = useState(list.exclusions);
  const [cursor, setCursor] = useState(list.exclusionsNextCursor ?? null);
  const pending = useRef(false);
  const load = async () => {
    if (!cursor || pending.current) return;
    pending.current = true;
    try {
      const response = await fetch(`/api/recommendations/lists/${encodeURIComponent(list.recommendationListId)}/exclusions?targetId=${encodeURIComponent(targetId)}&cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("RECOMMENDATION_EXCLUSIONS_LOAD_FAILED");
      const page = RecommendationExclusionPageSchema.parse(await response.json());
      setItems((current) => [...new Map([...current, ...page.items].map((item) => [`${item.opportunityId}:${item.reasonCode}`, item])).values()]);
      setCursor(page.nextCursor);
    } finally { pending.current = false; }
  };
  if (!items.length) return null;
  return <div><p>稳定排除 {items.length} 项岗位：{items.map((item) => item.reasonCode).join("、")}</p>{cursor ? <button className="workbench-touch-target" type="button" onClick={() => void load()}>加载更多稳定排除</button> : null}</div>;
}
