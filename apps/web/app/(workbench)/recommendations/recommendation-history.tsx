"use client";

import { useRef, useState } from "react";
import { RecommendationExclusionPageSchema, RecommendationListHistoryPageSchema, type RecommendationList, type RecommendationListHistoryPage } from "@job-copilot/contracts/recommendations";
import { exclusionReasonText } from "./exclusion-reasons";
import { formatBand, formatDimensionDetail, formatDimensionLabel, formatEvidence, formatProfileEvidence } from "./formatters";

type ExclusionState = { items: RecommendationList["exclusions"]; nextCursor: string | null };

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("RECOMMENDATION_HISTORY_LOAD_FAILED");
  return response.json();
}

export function RecommendationHistory({ targetId, initialPage }: { targetId: string; initialPage: RecommendationListHistoryPage }) {
  const identity = `${targetId}:${initialPage.items.map((item) => item.recommendationListId).join(",")}:${initialPage.nextCursor ?? ""}`;
  return <RecommendationHistoryState key={identity} targetId={targetId} initialPage={initialPage} />;
}

function RecommendationHistoryState({ targetId, initialPage }: { targetId: string; initialPage: RecommendationListHistoryPage }) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exclusions, setExclusions] = useState<Record<string, ExclusionState>>({});
  const [exclusionPending, setExclusionPending] = useState<Record<string, boolean>>({});
  const [exclusionErrors, setExclusionErrors] = useState<Record<string, string | undefined>>({});
  const pendingRequests = useRef(new Set<string>());
  const historyPending = useRef(false);
  const loadHistory = async () => {
    if (!nextCursor || historyPending.current) return;
    historyPending.current = true;
    setLoadingHistory(true);
    setError(null);
    try {
      const page = RecommendationListHistoryPageSchema.parse(await responseJson(await fetch(`/api/recommendations/history?targetId=${encodeURIComponent(targetId)}&cursor=${encodeURIComponent(nextCursor)}`, { cache: "no-store" })));
      setItems((current) => [...new Map([...current, ...page.items].map((item) => [item.recommendationListId, item])).values()]);
      setNextCursor(page.nextCursor);
    } catch { setError("历史版本加载失败，请重试。"); }
    finally { historyPending.current = false; setLoadingHistory(false); }
  };
  const loadExclusions = async (listId: string, cursor?: string) => {
    const requestKey = `${listId}:${cursor ?? "first"}`;
    if (pendingRequests.current.has(requestKey)) return;
    pendingRequests.current.add(requestKey);
    setExclusionPending((current) => ({ ...current, [listId]: true }));
    setExclusionErrors((current) => ({ ...current, [listId]: undefined }));
    try {
    const page = RecommendationExclusionPageSchema.parse(await responseJson(await fetch(`/api/recommendations/lists/${encodeURIComponent(listId)}/exclusions?targetId=${encodeURIComponent(targetId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" })));
    setExclusions((current) => {
      const previous = current[listId]?.items ?? [];
      const byIdentity = new Map(previous.map((item) => [`${item.opportunityId}:${item.reasonCode}`, item]));
      for (const item of page.items) byIdentity.set(`${item.opportunityId}:${item.reasonCode}`, item);
      return { ...current, [listId]: { items: [...byIdentity.values()], nextCursor: page.nextCursor } };
    });
    } catch { setExclusionErrors((current) => ({ ...current, [listId]: "稳定排除加载失败，请重试。" })); }
    finally { pendingRequests.current.delete(requestKey); setExclusionPending((current) => ({ ...current, [listId]: false })); }
  };
  return <details><summary className="workbench-touch-target">历史版本</summary><ol>{items.map((version) => {
    const exclusion = exclusions[version.recommendationListId];
    const pending = exclusionPending[version.recommendationListId] === true;
    const exclusionError = exclusionErrors[version.recommendationListId];
    return <li key={version.recommendationListId}><details><summary className="workbench-touch-target">清单版本 {version.sequence} · {version.localDate}</summary>{version.items.length === 0 ? <p>该版本没有可推荐岗位。</p> : <ol>{version.items.map((item) => <li key={item.matchVersionId}><strong>{item.title ?? "岗位机会"}</strong><p>{formatBand(item.displayBand)}</p><p>岗位证据：{formatEvidence(item.jobEvidence)}</p><p>画像证据：{formatProfileEvidence(item.profileEvidence)}</p>{item.assessment.dimensions.map((dimension) => <p key={dimension.dimension}><strong>{formatDimensionLabel(dimension)}</strong>：{formatDimensionDetail(dimension)}</p>)}</li>)}</ol>} {!exclusion ? <button className="workbench-touch-target" type="button" disabled={pending} onClick={() => void loadExclusions(version.recommendationListId)}>{pending ? "加载中" : "查看稳定排除"}</button> : <>{exclusion.items.length > 0 ? <p>稳定排除：{exclusion.items.map((item) => exclusionReasonText[item.reasonCode]).join("、")}</p> : <p>没有稳定排除岗位。</p>}{exclusion.nextCursor ? <button className="workbench-touch-target" type="button" disabled={pending} onClick={() => void loadExclusions(version.recommendationListId, exclusion.nextCursor ?? undefined)}>{pending ? "加载中" : "加载更多稳定排除"}</button> : null}</>}{exclusionError ? <p role="alert">{exclusionError}</p> : null}</details></li>;
  })}</ol>{error ? <p role="alert">{error}</p> : null}{nextCursor ? <button className="workbench-touch-target" type="button" disabled={loadingHistory} onClick={() => void loadHistory()}>{loadingHistory ? "加载中" : "加载更多历史版本"}</button> : null}</details>;
}
