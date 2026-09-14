"use client";

import { AgentInboxActionResponseSchema, AgentInboxListSchema, type AgentInboxActionCommand, type AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import { RunPreflightProblemSchema, type RunPreflightReport } from "@job-copilot/contracts/run-preflight";
import type { AgentRunControlSnapshot } from "@job-copilot/contracts/agent-runs";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RunPreflightPanel } from "./run-preflight-panel";

type InboxFilter = "pending" | "unread" | "read" | "resolved";
type InboxCache = Partial<Record<InboxFilter, AgentInboxItem[]>>;
type InboxCacheState = { source: string; cache: InboxCache };
type FilterRequest = { source: string; filter: InboxFilter; version: number };
const filters: { value: InboxFilter; label: string }[] = [
  { value: "pending", label: "待处理" }, { value: "unread", label: "未读" }, { value: "read", label: "已读" }, { value: "resolved", label: "已处理" },
];
const actionLabels: Record<AgentInboxActionCommand["action"], string> = {
  restart_run: "重新开始岗位发现", resume_run: "继续本次岗位发现", cancel_run: "取消岗位发现", mark_read: "标记为已读", dismiss: "标记已处理",
};
const suggestedActionLinks = {
  run_model_diagnostic: { href: "/profile/model-connection", label: "检查模型连接" },
  review_account_run_policy: { href: "/profile/run-policy", label: "检查账户运行策略" },
} as const;
const emptyCopy: Record<InboxFilter, string> = {
  pending: "目前没有需要你决定的事项。新的确认、异常或推荐会显示在这里。", unread: "没有未读事项。", read: "没有已读事项。", resolved: "没有已处理事项。",
};

const inboxSourceIds = new WeakMap<AgentInboxItem[], number>();
let nextInboxSourceId = 0;
function inboxSource(items: AgentInboxItem[]) {
  let identity = inboxSourceIds.get(items);
  if (identity === undefined) { identity = ++nextInboxSourceId; inboxSourceIds.set(items, identity); }
  return `${identity}:${JSON.stringify(items)}`;
}
function authoritativeInboxCache(items: AgentInboxItem[]): InboxCache {
  const pending = items.filter((item) => item.status !== "resolved");
  return { pending, unread: pending.filter((item) => item.status === "unread"), read: pending.filter((item) => item.status === "read") };
}
function compareInboxItems(left: AgentInboxItem, right: AgentInboxItem): number {
  const createdAtOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (createdAtOrder !== 0) return createdAtOrder;
  return right.itemId > left.itemId ? 1 : right.itemId < left.itemId ? -1 : 0;
}
function upsertInboxItem(entries: AgentInboxItem[], item: AgentInboxItem): AgentInboxItem[] {
  return [...entries.filter((entry) => entry.itemId !== item.itemId), item].sort(compareInboxItems);
}
function moveCachedItem(current: InboxCache, item: AgentInboxItem): InboxCache {
  return {
    ...current,
    pending: current.pending === undefined ? undefined : upsertInboxItem(current.pending, item),
    unread: current.unread === undefined ? undefined : item.status === "unread" ? upsertInboxItem(current.unread, item) : current.unread.filter((entry) => entry.itemId !== item.itemId),
    read: current.read === undefined ? undefined : item.status === "read" ? upsertInboxItem(current.read, item) : current.read.filter((entry) => entry.itemId !== item.itemId),
  };
}
function actionLabel(item: AgentInboxItem, action: AgentInboxActionCommand["action"]) {
  if (item.target.type !== "recommendation_run") return actionLabels[action];
  if (action === "restart_run") return "重新开始完整推荐";
  if (action === "resume_run") return "继续本次推荐";
  if (action === "cancel_run") return "取消推荐";
  return actionLabels[action];
}
function navigationFor(item: AgentInboxItem) {
  return (item.suggestedActions ?? []).flatMap((action) => {
    if (action === "restart_discovery") return [];
    if (action === "review_source_health" && item.target.type === "recommendation_run") return [{ href: `/profile/targets/${item.target.targetId}/watchlist#source-health`, label: "查看来源健康状态" }];
    const link = action in suggestedActionLinks ? suggestedActionLinks[action as keyof typeof suggestedActionLinks] : null;
    return link ? [link] : [];
  });
}

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
  const source = inboxSource(items);
  const [filter, setFilter] = useState<InboxFilter>("pending");
  const [cacheState, setCacheState] = useState<InboxCacheState>({ source, cache: { pending: items } });
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [restartPreflight, setRestartPreflight] = useState<Record<string, RunPreflightReport>>({});
  const [loadingRequest, setLoadingRequest] = useState<FilterRequest | null>(null);
  const [failedRequest, setFailedRequest] = useState<FilterRequest | null>(null);
  const actionIds = useRef(new Map<string, string>());
  const requestVersion = useRef(0);
  const resolvedRequestSource = useRef<string | null>(null);
  const filterButtons = useRef<Partial<Record<InboxFilter, HTMLButtonElement | null>>>({});
  const itemTargets = useRef<Record<string, HTMLAnchorElement | null>>({});
  const sourceChanged = cacheState.source !== source;
  const cache = sourceChanged ? authoritativeInboxCache(items) : cacheState.cache;
  const loadingFilter = loadingRequest?.source === source ? loadingRequest.filter : sourceChanged && filter === "resolved" ? "resolved" : null;
  const failedFilter = failedRequest?.source === source ? failedRequest.filter : null;
  const visibleItems = cache[filter] ?? [];

  function updateCache(update: (current: InboxCache) => InboxCache) {
    setCacheState((current) => {
      const authoritativeCache = current.source === source ? current.cache : authoritativeInboxCache(items);
      return { source, cache: update(authoritativeCache) };
    });
  }

  useEffect(() => {
    if (filter !== "resolved" || resolvedRequestSource.current === source) return;
    resolvedRequestSource.current = source;
    const version = ++requestVersion.current;
    const request = { source, filter: "resolved" as const, version };
    setLoadingRequest(request);
    setFailedRequest(null);
    void loadAgentInbox("resolved").then((nextItems) => {
      if (version !== requestVersion.current) return;
      setLoadingRequest((current) => current?.source === source && current.version === version ? null : current);
      if (nextItems === false) {
        setFailedRequest(request);
        return;
      }
      setCacheState((current) => {
        const authoritativeCache = current.source === source ? current.cache : authoritativeInboxCache(items);
        return { source, cache: { ...authoritativeCache, resolved: nextItems } };
      });
    });
  }, [filter, items, source]);

  async function changeFilter(next: InboxFilter, retry = false) {
    const version = ++requestVersion.current;
    const request = { source, filter: next, version };
    if (next === "resolved") resolvedRequestSource.current = source;
    setFilter(next);
    setMessage("");
    setFailedRequest(null);
    if (!retry && cache[next] !== undefined) return;
    setLoadingRequest(request);
    const nextItems = await loadAgentInbox(next);
    if (version !== requestVersion.current) return;
    setLoadingRequest((current) => current?.source === source && current.version === version ? null : current);
    if (nextItems === false) { setFailedRequest(request); return; }
    updateCache((current) => ({ ...current, [next]: nextItems }));
  }

  async function actOn(item: AgentInboxItem, action: AgentInboxActionCommand["action"], warningFingerprint?: string) {
    const key = `${item.itemId}:${action}`;
    const actionId = actionIds.current.get(key) ?? crypto.randomUUID();
    actionIds.current.set(key, actionId);
    setPending(key);
    setMessage("");
    try {
      const response = await fetch(`/api/agent-inbox/${item.itemId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actionId, action, ...(warningFingerprint === undefined ? {} : { warningFingerprint }) }) });
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        const preflight = action === "restart_run" ? RunPreflightProblemSchema.safeParse(problem).data : undefined;
        if (preflight) { setRestartPreflight((current) => ({ ...current, [item.itemId]: preflight.preflight })); return; }
        if (response.status === 409) actionIds.current.delete(key);
        const accountStopped = problem && typeof problem === "object" && "code" in problem && problem.code === "ACCOUNT_RUN_STOPPED";
        setMessage(accountStopped ? "账户已停止全部运行，请先恢复后重试。" : response.status === 409 ? "该事项状态已变化，请刷新后查看。" : "暂时无法处理该事项，请稍后重试。");
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
        updateCache((current) => moveCachedItem(current, parsed.data.item));
        setMessage(action === "mark_read" ? "事项已标记为已读。" : "事项状态已更新。");
        if (action === "mark_read") queueMicrotask(() => (filter === "unread" ? filterButtons.current.unread : itemTargets.current[item.itemId] ?? filterButtons.current[filter] ?? filterButtons.current.pending)?.focus());
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
      {visibleItems.map((item) => { const preflight = restartPreflight[item.itemId]; const navigation = navigationFor(item); return <article aria-label={item.title} key={item.itemId}>
        <h3>{item.title}</h3><p>{item.message}</p>
        <dl className="agent-inbox-details"><div><dt>依据</dt><dd>{item.basis}</dd></div><div><dt>影响</dt><dd>{item.impact}</dd></div><div><dt>建议</dt><dd>{item.suggestedAction}</dd></div></dl>
        <div className="agent-inbox-actions"><Link className="workbench-ledger-link workbench-touch-target" href={item.target.href} ref={(node) => { itemTargets.current[item.itemId] = node; }}>查看相关记录</Link>
          {navigation.map((link) => <Link className="workbench-ledger-link workbench-touch-target" href={link.href} key={link.href}>{link.label}</Link>)}
          {preflight ? <RunPreflightPanel report={preflight} unavailable={false} /> : null}
          {item.availableActions.filter((action) => action !== "restart_run" || !preflight).map((action) => { const key = `${item.itemId}:${action}`; return <button className="agent-run-action workbench-touch-target" disabled={pending === key} key={action} onClick={() => void actOn(item, action)} type="button">{pending === key ? "正在处理…" : `${actionLabel(item, action)}：${item.title}`}</button>; })}
          {preflight?.status === "ready_with_warnings" && item.availableActions.includes("restart_run") ? <button className="agent-run-action workbench-touch-target" disabled={pending === `${item.itemId}:restart_run`} onClick={() => void actOn(item, "restart_run", preflight.warningFingerprint!)} type="button">确认当前提示并{item.target.type === "recommendation_run" ? "重新开始完整推荐" : "重新开始岗位发现"}</button> : null}
        </div>
      </article>; })}
    </div>}
  </section>;
}
