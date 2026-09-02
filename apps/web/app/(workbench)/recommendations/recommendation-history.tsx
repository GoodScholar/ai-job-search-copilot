"use client";

import { useRef, useState } from "react";
import { RecommendationExclusionPageSchema, RecommendationListHistoryPageSchema, type RecommendationList, type RecommendationListHistoryPage } from "@job-copilot/contracts/recommendations";

type ExclusionState = { items: RecommendationList["exclusions"]; nextCursor: string | null };
const bandText = { highly_matched: "高度匹配", worth_trying: "值得尝试", consider_carefully: "谨慎考虑" } as const;
const dimensionText = { skills: "技能", experience: "经验", project_depth: "项目深度", career_direction: "岗位方向", location_logistics: "地点与工作方式", qualification_risk: "资格风险" } as const;

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("RECOMMENDATION_HISTORY_LOAD_FAILED");
  return response.json();
}

export function RecommendationHistory({ targetId, initialPage }: { targetId: string; initialPage: RecommendationListHistoryPage }) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [exclusions, setExclusions] = useState<Record<string, ExclusionState>>({});
  const pendingRequests = useRef(new Set<string>());
  const loadHistory = async () => {
    if (!nextCursor || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const page = RecommendationListHistoryPageSchema.parse(await responseJson(await fetch(`/api/recommendations/history?targetId=${encodeURIComponent(targetId)}&cursor=${encodeURIComponent(nextCursor)}`, { cache: "no-store" })));
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } finally { setLoadingHistory(false); }
  };
  const loadExclusions = async (listId: string, cursor?: string) => {
    const requestKey = `${listId}:${cursor ?? "first"}`;
    if (pendingRequests.current.has(requestKey)) return;
    pendingRequests.current.add(requestKey);
    try {
    const page = RecommendationExclusionPageSchema.parse(await responseJson(await fetch(`/api/recommendations/lists/${encodeURIComponent(listId)}/exclusions?targetId=${encodeURIComponent(targetId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" })));
    setExclusions((current) => {
      const previous = current[listId]?.items ?? [];
      const byIdentity = new Map(previous.map((item) => [`${item.opportunityId}:${item.reasonCode}`, item]));
      for (const item of page.items) byIdentity.set(`${item.opportunityId}:${item.reasonCode}`, item);
      return { ...current, [listId]: { items: [...byIdentity.values()], nextCursor: page.nextCursor } };
    });
    } finally { pendingRequests.current.delete(requestKey); }
  };
  return <details><summary>历史版本</summary><ol>{items.map((version) => {
    const exclusion = exclusions[version.recommendationListId];
    return <li key={version.recommendationListId}><details><summary>清单版本 {version.sequence} · {version.localDate}</summary>{version.items.length === 0 ? <p>该版本没有可推荐岗位。</p> : <ol>{version.items.map((item) => <li key={item.matchVersionId}><strong>{item.title ?? "岗位机会"}</strong><p>{bandText[item.displayBand]}</p><p>岗位证据：{item.jobEvidence.map((evidence) => evidence.value).join("；")}</p><p>画像证据：{item.profileEvidence.map((evidence) => evidence.value).join("；")}</p>{item.assessment.dimensions.map((dimension) => <p key={dimension.dimension}><strong>{dimensionText[dimension.dimension]}</strong>：{dimension.judgment === "evidence_backed_inference" ? "证据支持的推断" : "证据不足"}；{dimension.summary}</p>)}</li>)}</ol>} {!exclusion ? <button className="workbench-touch-target" type="button" onClick={() => void loadExclusions(version.recommendationListId)}>查看稳定排除</button> : <>{exclusion.items.length > 0 ? <p>稳定排除：{exclusion.items.map((item) => item.reasonCode).join("、")}</p> : <p>没有稳定排除岗位。</p>}{exclusion.nextCursor ? <button className="workbench-touch-target" type="button" onClick={() => void loadExclusions(version.recommendationListId, exclusion.nextCursor ?? undefined)}>加载更多稳定排除</button> : null}</>}</details></li>;
  })}</ol>{nextCursor ? <button className="workbench-touch-target" type="button" disabled={loadingHistory} onClick={() => void loadHistory()}>{loadingHistory ? "加载中" : "加载更多历史版本"}</button> : null}</details>;
}
