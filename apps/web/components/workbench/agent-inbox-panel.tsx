"use client";

import { AgentInboxActionResponseSchema, AgentInboxListSchema, type AgentInboxActionCommand, type AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import type { AgentRunControlSnapshot } from "@job-copilot/contracts/agent-runs";
import Link from "next/link";
import { useRef, useState } from "react";

type InboxFilter = "pending" | "unread" | "read" | "resolved";
type InboxCache = Partial<Record<InboxFilter, AgentInboxItem[]>>;
type InboxCacheState = { source: AgentInboxItem[]; cache: InboxCache };
const filters: { value: InboxFilter; label: string }[] = [
  { value: "pending", label: "待处理" }, { value: "unread", label: "未读" }, { value: "read", label: "已读" }, { value: "resolved", label: "已处理" },
];
const actionLabels: Record<AgentInboxActionCommand["action"], string> = {
  restart_run: "重新开始岗位发现", resume_run: "继续本次岗位发现", cancel_run: "取消岗位发现", mark_read: "标记为已读", dismiss: "标记已处理",
};
const emptyCopy: Record<InboxFilter, string> = {
  pending: "目前没有需要你决定的事项。新的确认、异常或推荐会显示在这里。", unread: "没有未读事项。", read: "没有已读事项。", resolved: "没有已处理事项。",
};

export async function loadAgentInbox(status: InboxFilter): Promise<AgentInboxItem[] | false> {
  try {
    const response = await fetch(`/api/agent-inbox?status=${status}`, { cache: "no-store" });
    if (!response.ok) return false;
    const parsed = AgentInboxListSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data.items : false;
  } catch {
    return false;
  }
}

export function AgentInboxPanel({ items, onResolved, onRunUpdated }: {
  items: AgentInboxItem[];
  onResolved: (item: AgentInboxItem) => void;
  onRunUpdated?: (run: AgentRunControlSnapshot) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>("pending");
  const [cacheState, setCacheState] = useState<InboxCacheState>({ source: items, cache: { pending: items } });
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [loadingFilter, setLoadingFilter] = useState<InboxFilter | null>(null);
  const [failedFilter, setFailedFilter] = useState<InboxFilter | null>(null);
  const actionIds = useRef(new Map<string, string>());
  const requestVersion = useRef(0);
  const filterButtons = useRef<Partial<Record<InboxFilter, HTMLButtonElement | null>>>({});
  const itemTargets = useRef<Record<string, HTMLAnchorElement | null>>({});
  const cache = cacheState.source === items ? cacheState.cache : { pending: items };
  const visibleItems = cache[filter] ?? [];

  function updateCache(update: (current: InboxCache) => InboxCache) {
    setCacheState((current) => {
      const authoritativeCache = current.source === items ? current.cache : { pending: items };
      return { source: items, cache: update(authoritativeCache) };
    });
  }

  async function changeFilter(next: InboxFilter, retry = false) {
    const version = ++requestVersion.current;
    setFilter(next);
    setMessage("");
    setFailedFilter(null);
    if (!retry && cache[next] !== undefined) return;
    setLoadingFilter(next);
    const nextItems = await loadAgentInbox(next);
    if (version === requestVersion.current) setLoadingFilter(null);
    if (version !== requestVersion.current || nextItems === false) {
      if (version === requestVersion.current && nextItems === false) setFailedFilter(next);
      return;
    }
    updateCache((current) => ({ ...current, [next]: nextItems }));
  }

  async function actOn(item: AgentInboxItem, action: AgentInboxActionCommand["action"]) {
    const key = `${item.itemId}:${action}`;
    const actionId = actionIds.current.get(key) ?? crypto.randomUUID();
    actionIds.current.set(key, actionId);
    setPending(key);
    setMessage("");
    try {
      const response = await fetch(`/api/agent-inbox/${item.itemId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId, action }) });
      if (!response.ok) {
        if (response.status === 409) actionIds.current.delete(key);
        setMessage(response.status === 409 ? "该事项状态已变化，请刷新后查看。" : "暂时无法处理该事项，请稍后重试。");
        return;
      }
      const parsed = AgentInboxActionResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) { setMessage("暂时无法处理该事项，请稍后重试。"); return; }
      actionIds.current.delete(key);
      if (parsed.data.run) onRunUpdated?.(parsed.data.run);
      if (parsed.data.item.status === "resolved") {
        updateCache((current) => Object.fromEntries(Object.entries(current).map(([status, entries]) => [status, entries?.filter((entry) => entry.itemId !== item.itemId)])) as InboxCache);
        onResolved(item);
        setMessage("事项已处理。");
        queueMicrotask(() => filterButtons.current.pending?.focus());
      } else {
        updateCache((current) => ({ ...current, [filter]: (current[filter] ?? []).map((entry) => entry.itemId === item.itemId ? parsed.data.item : entry) }));
        setMessage(action === "mark_read" ? "事项已标记为已读。" : "事项状态已更新。");
        if (action === "mark_read") queueMicrotask(() => (itemTargets.current[item.itemId] ?? filterButtons.current.pending)?.focus());
      }
    } catch {
      setMessage("暂时无法处理该事项，请稍后重试。");
    } finally {
      setPending(null);
    }
  }

  return <section aria-labelledby="agent-inbox-title" className="workbench-ledger agent-inbox-panel">
    <div className="workbench-ledger-heading"><p>待处理事项</p><h2 id="agent-inbox-title">需要你决定的事项</h2></div>
    <div aria-label="事项状态筛选" className="agent-inbox-filters" role="group">
      {filters.map(({ value, label }) => <button aria-pressed={filter === value} className="workbench-touch-target" key={value} onClick={() => void changeFilter(value)} ref={(node) => { filterButtons.current[value] = node; }} type="button">{label}</button>)}
    </div>
    <p aria-live="polite" className={message ? "agent-inbox-live" : "agent-inbox-live is-empty"} role="status">{message}</p>
    {loadingFilter === filter ? <p className="agent-inbox-empty">正在读取事项…</p> : failedFilter === filter ? <div className="agent-inbox-load-error"><p>事项暂时无法读取，请稍后重试。</p><button className="workbench-touch-target" onClick={() => void changeFilter(filter, true)} type="button">重试读取{filters.find(({ value }) => value === filter)!.label}事项</button></div> : visibleItems.length === 0 ? <p className="agent-inbox-empty">{emptyCopy[filter]}</p> : <div className="agent-inbox-list">
      {visibleItems.map((item) => <article aria-label={item.title} key={item.itemId}>
        <h3>{item.title}</h3><p>{item.message}</p>
        <dl className="agent-inbox-details"><div><dt>依据</dt><dd>{item.basis}</dd></div><div><dt>影响</dt><dd>{item.impact}</dd></div><div><dt>建议</dt><dd>{item.suggestedAction}</dd></div></dl>
        <div className="agent-inbox-actions"><Link className="workbench-ledger-link workbench-touch-target" href={item.target.href} ref={(node) => { itemTargets.current[item.itemId] = node; }}>查看相关记录</Link>
          {item.availableActions.map((action) => { const key = `${item.itemId}:${action}`; return <button className="agent-run-action workbench-touch-target" disabled={pending === key} key={action} onClick={() => void actOn(item, action)} type="button">{pending === key ? "正在处理…" : `${actionLabels[action]}：${item.title}`}</button>; })}
        </div>
      </article>)}
    </div>}
  </section>;
}
