"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { JobExportListSchema, JobExportSchema, type JobExport, type JobExportCommand } from "@job-copilot/contracts/job-exports";
import type { JobOpportunityArchiveFilter } from "@job-copilot/contracts/job-opportunity-archives";

const filterLabels = { active: "活跃岗位", archived: "已归档岗位", all: "全部岗位（包含已归档）" };

export function JobExportPanel({ filter, initialExports }: { filter: JobOpportunityArchiveFilter; initialExports: JobExport[] | null }) {
  const [items, setItems] = useState(initialExports ?? []);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [retry, setRetry] = useState<JobExportCommand | null>(null);
  const [message, setMessage] = useState(initialExports === null ? "导出记录暂时无法读取，请刷新导出状态。" : "");
  const creating = useRef(false);
  const refreshing = useRef(false);
  const downloadLock = useRef(false);
  const listRevision = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (refreshing.current) return;
    refreshing.current = true;
    const revision = listRevision.current;
    try {
      const response = await fetch("/api/job-exports", { cache: "no-store", signal });
      if (!response.ok) throw new Error("JOB_EXPORT_LIST_FAILED");
      const next = JobExportListSchema.parse(await response.json());
      if (!signal?.aborted && revision === listRevision.current) setItems(next.items);
    } catch {
      if (!signal?.aborted) setMessage("导出状态暂时无法更新，请刷新导出状态。");
    } finally { refreshing.current = false; }
  }, []);

  const generating = items.some((item) => item.status === "generating");
  useEffect(() => {
    if (!generating) return;
    const controller = new AbortController();
    const timer = setInterval(() => { void refresh(controller.signal); }, 3_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [generating, refresh]);

  useEffect(() => {
    const live = items.filter((item) => item.status !== "expired");
    if (!live.length) return;
    const expiresAt = Math.min(...live.map((item) => Date.parse(item.expiresAt)));
    const timer = setTimeout(() => {
      setItems((current) => current.map((item) => Date.parse(item.expiresAt) <= Date.now() ? { ...item, status: "expired" } : item));
    }, Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [items]);

  async function create() {
    if (creating.current) return;
    creating.current = true;
    setBusy(true); setMessage("");
    const command: JobExportCommand = retry ?? { commandId: crypto.randomUUID(), filter: filter === "archived" ? "archived" : includeArchived ? "all" : "active", fieldVersion: 1 };
    try {
      const response = await fetch("/api/job-exports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command), cache: "no-store" });
      if (!response.ok) {
        if (response.status === 409) { setRetry(null); setMessage("导出请求发生冲突，请重新生成快照。"); return; }
        throw new Error("JOB_EXPORT_CREATE_FAILED");
      }
      const snapshot = JobExportSchema.parse(await response.json());
      listRevision.current += 1;
      setItems((current) => [snapshot, ...current.filter((item) => item.id !== snapshot.id)].slice(0, 20));
      setRetry(null);
      setMessage("已保存导出快照，后续岗位变化不会改写文件内容。");
    } catch {
      setRetry(command);
      setMessage("导出请求暂时无法确认。重试会沿用上次请求的筛选条件。");
    } finally { creating.current = false; setBusy(false); }
  }

  async function download(item: JobExport) {
    if (downloadLock.current) return;
    downloadLock.current = true;
    setDownloading(item.id); setMessage("");
    try {
      const response = await fetch(`/api/job-exports/${item.id}/download`, { cache: "no-store" });
      if (response.status === 410) {
        listRevision.current += 1;
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: "expired" } : entry));
        setMessage("快照已过期，请重新生成。"); return;
      }
      if (!response.ok) throw new Error("JOB_EXPORT_DOWNLOAD_FAILED");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `job-opportunities-${item.id}.csv`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch { setMessage("文件暂时无法下载，请稍后重试。文件仅在创建后 24 小时内可下载。"); }
    finally { downloadLock.current = false; setDownloading(null); }
  }

  return <section aria-labelledby="job-export-title" className="job-export-panel">
    <h2 id="job-export-title">导出岗位</h2>
    <p>保存当前筛选下的全部岗位，包含尚未加载的岗位。CSV 可用 Excel 打开，创建后 24 小时内可下载。</p>
    <label className="workbench-touch-target"><input type="checkbox" checked={filter === "archived" || includeArchived} disabled={filter === "archived" || busy} onChange={(event) => setIncludeArchived(event.target.checked)} />包含已归档岗位</label>
    <p>导出范围：{filterLabels[filter === "archived" ? "archived" : includeArchived ? "all" : "active"]}</p>
    <button className="workbench-touch-target" type="button" disabled={busy} onClick={() => void create()}>{busy ? "正在创建快照…" : retry ? "重试上次导出请求" : "生成 CSV 快照"}</button>{" "}
    <button className="workbench-touch-target" type="button" onClick={() => void refresh()}>刷新导出状态</button>
    <p role="status">{message}</p>
    <ul aria-label="岗位导出快照" aria-live="polite">{items.map((item) => <li key={item.id}>
      <p>{filterLabels[item.filter]} · {item.rowCount} 个岗位 · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN")}</time></p>
      {item.status === "generating" ? <p>生成中，可离开页面，稍后回来下载。</p> : null}
      {item.status === "ready" ? <><p>可下载 · 有效期至 <time dateTime={item.expiresAt}>{new Date(item.expiresAt).toLocaleString("zh-CN")}</time></p><button className="workbench-touch-target" type="button" disabled={downloading !== null} onClick={() => void download(item)}>{downloading === item.id ? "下载中…" : "下载 CSV"}</button></> : null}
      {item.status === "failed" ? <p>文件生成失败，请使用上方按钮重新生成快照。</p> : null}
      {item.status === "expired" ? <p>已过期，请按当前筛选重新生成快照。</p> : null}
    </li>)}</ul>
  </section>;
}
