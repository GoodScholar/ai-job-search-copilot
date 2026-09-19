"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { JobOpportunityArchiveCommandResponseSchema, JobOpportunityArchivePageSchema, type JobOpportunityArchiveFilter, type JobOpportunityArchivePage } from "@job-copilot/contracts/job-opportunity-archives";
import type { JobExport } from "@job-copilot/contracts/job-exports";
import { JobExportPanel } from "./job-export-panel";

type Retry = { opportunityId: string; action: "archive" | "restore"; version: number; commandId: string };

function appendPage(current: JobOpportunityArchivePage, next: JobOpportunityArchivePage): JobOpportunityArchivePage {
  return { ...next, items: [...new Map([...current.items, ...next.items].map((item) => [item.opportunityId, item])).values()] };
}

export function JobOpportunitiesView({ initialFilter, initialPage, initialExports }: { initialFilter: JobOpportunityArchiveFilter; initialPage: JobOpportunityArchivePage; initialExports?: JobExport[] | null }) {
  const router = useRouter();
  const [filter, setFilter] = useState(initialFilter);
  const [page, setPage] = useState(initialPage);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState<Retry | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const loadingMore = useRef(false);

  async function load(nextFilter: JobOpportunityArchiveFilter, cursor?: string, append = false, apply = true) {
    if (append && loadingMore.current) return false;
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    if (append) loadingMore.current = true;
    setLoading(true);
    try {
      const query = new URLSearchParams({ filter: nextFilter });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/job-opportunities?${query}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("JOB_OPPORTUNITY_LIST_FAILED");
      const next = JobOpportunityArchivePageSchema.parse(await response.json());
      if (apply) setPage((current) => append ? appendPage(current, next) : next);
      return next;
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") setMessage("岗位列表暂时无法读取，请重试。");
      return null;
    } finally {
      if (listRequest.current === controller) setLoading(false);
      if (append) loadingMore.current = false;
    }
  }

  async function select(next: JobOpportunityArchiveFilter) {
    if (next === filter || loading || busy) return;
    setMessage(null); setRetry(null);
    const nextPage = await load(next, undefined, false, false);
    if (!nextPage) return;
    setPage(nextPage); setFilter(next);
    router.replace(`/jobs?filter=${next}`, { scroll: false });
  }

  async function change(input: Retry) {
    setBusy(input.opportunityId); setMessage(null); setRetry(null);
    try {
      const response = await fetch(`/api/job-opportunities/${input.opportunityId}/archive-state`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: input.action, commandId: input.commandId, expectedVersion: input.version }),
      });
      if (response.status === 409) {
        await load(filter);
        setMessage("岗位状态已更新，已刷新列表，请重试。");
        return;
      }
      if (!response.ok) throw new Error("JOB_OPPORTUNITY_ARCHIVE_FAILED");
      const result = JobOpportunityArchiveCommandResponseSchema.parse(await response.json());
      if (!result.applied) {
        await load(filter);
        setMessage("岗位状态未变化，已刷新列表。");
        return;
      }
      setPage((current) => ({
        ...current,
        items: current.items.filter((item) => item.opportunityId !== input.opportunityId),
        nextCursor: null,
        counts: input.action === "archive"
          ? { active: Math.max(0, current.counts.active - 1), archived: current.counts.archived + 1 }
          : { active: current.counts.active + 1, archived: Math.max(0, current.counts.archived - 1) },
      }));
      const refreshed = await load(filter);
      setMessage(refreshed
        ? input.action === "archive" ? "已归档，可在归档岗位中恢复。" : "已恢复到活跃岗位。"
        : "岗位状态已更新，但列表无法刷新，请刷新页面。");
    } catch {
      setRetry(input);
      setMessage("岗位状态暂时无法更新，请重试。");
    } finally { setBusy(null); }
  }

  function startChange(opportunityId: string, action: "archive" | "restore", version: number) {
    void change({ opportunityId, action, version, commandId: crypto.randomUUID() });
  }

  return <main className="container workbench-page" id="main-content"><section className="job-import-panel" aria-labelledby="job-opportunities-title">
    <p className="section-kicker">岗位机会 · 当前状态</p><h1 id="job-opportunities-title">岗位机会</h1><p>归档只整理当前工作区，来源、匹配和推荐历史仍保留原有证据。</p>
    <div aria-label="岗位筛选"><button aria-pressed={filter === "active"} className="workbench-touch-target" disabled={loading || busy !== null} onClick={() => void select("active")} type="button">活跃 {page.counts.active}</button><button aria-pressed={filter === "archived"} className="workbench-touch-target" disabled={loading || busy !== null} onClick={() => void select("archived")} type="button">已归档 {page.counts.archived}</button></div>
    {initialExports !== undefined ? <JobExportPanel filter={filter} initialExports={initialExports} /> : null}
    {message ? <p role="status">{message}</p> : null}
    {retry ? <button className="workbench-touch-target" disabled={loading || busy === retry.opportunityId} onClick={() => void change(retry)} type="button">重试{retry.action === "archive" ? "归档岗位" : "恢复岗位"}</button> : null}
    {page.items.length === 0 ? <p>{filter === "active" ? "没有活跃岗位。" : "没有已归档岗位。"}</p> : <ol aria-label={filter === "active" ? "活跃岗位" : "已归档岗位"}>{page.items.map((item) => <li key={item.opportunityId}><h2>{item.title ?? "岗位机会"}</h2><p>{item.company ?? "来源待确认"} · {item.location ?? "地点待确认"}</p><button className="workbench-touch-target" disabled={loading || busy !== null} onClick={() => startChange(item.opportunityId, filter === "active" ? "archive" : "restore", item.version)} type="button">{filter === "active" ? `归档岗位：${item.title ?? "岗位机会"}` : `恢复岗位：${item.title ?? "岗位机会"}`}</button></li>)}</ol>}
    {page.nextCursor ? <button className="workbench-touch-target" disabled={loading || busy !== null} onClick={() => void load(filter, page.nextCursor ?? undefined, true)} type="button">{loading ? "加载中" : "加载更多岗位"}</button> : null}
  </section></main>;
}
