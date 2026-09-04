"use client";

import {
  AddCompanyWatchlistItemCommandSchema,
  CompanyWatchlistOverviewSchema,
  type AddCompanyWatchlistItemCommand,
  type CompanyWatchlistItem,
  type CompanyWatchlistOverview,
} from "@job-copilot/contracts/company-watchlists";
import { JobSourceHealthOverviewSchema, type JobSourceHealthOverview } from "@job-copilot/contracts/agent-runs";
import { SourceCapabilityProjectionOverviewSchema, type SourceCapabilityProjectionOverview } from "@job-copilot/contracts/source-capabilities";
import { useState, type FormEvent } from "react";

type Draft = {
  canonicalCompanyName: string;
  careersUrl: string;
  allowedDomains: string;
  sourceNote: string;
};

const emptyDraft: Draft = { canonicalCompanyName: "", careersUrl: "", allowedDomains: "", sourceNote: "" };
const conflictMessage = "Watchlist 已在其他位置更新，请刷新后重试。";
const initialHealthRefreshMessage = "来源诊断暂时无法读取，请重新加载或刷新页面。";
const postWriteHealthRefreshMessage = "Watchlist 已保存，但来源诊断刷新失败。请重新加载来源诊断或刷新页面。";
const initialCapabilityRefreshMessage = "来源能力暂不可读，请重新加载或刷新页面。";
const safetyNotice = "不要填写账号、密码、Cookie、验证码或绕过登录限制的说明。";

type RefreshFailure = "initial" | "post_write" | null;

function domains(value: string): string[] {
  return value.split(/[，,\s]+/u).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
}

function draftFrom(item: CompanyWatchlistItem): Draft {
  return {
    canonicalCompanyName: item.canonicalCompanyName,
    careersUrl: item.careersUrl,
    allowedDomains: item.allowedDomains.join(", "),
    sourceNote: item.sourceNote ?? "",
  };
}

function hasCredentialShape(url: URL): boolean {
  const credentialSegments = new Set(["token", "auth", "session", "password", "secret", "key", "code"]);
  return Boolean(url.username || url.password) || Array.from(url.searchParams.keys()).some((key) => key
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[_\-.]+/u)
    .some((part) => credentialSegments.has(part)));
}

function validateDraft(draft: Draft, expectedVersion: number): { command?: AddCompanyWatchlistItemCommand; message?: string } {
  const name = draft.canonicalCompanyName.trim();
  if (!name) return { message: "请填写公司规范名称。" };
  let url: URL;
  try {
    url = new URL(draft.careersUrl.trim());
  } catch {
    return { message: "请输入有效的公开招聘入口 URL。" };
  }
  if (!/^https?:$/u.test(url.protocol)) return { message: "请输入有效的公开招聘入口 URL。" };
  if (hasCredentialShape(url)) return { message: "公开招聘入口不得包含账号信息或凭据型查询参数。" };
  const allowedDomains = domains(draft.allowedDomains);
  const host = url.hostname.toLowerCase();
  if (!allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { message: "公开招聘入口主机必须匹配允许域。" };
  }
  const parsed = AddCompanyWatchlistItemCommandSchema.safeParse({
    expectedVersion,
    canonicalCompanyName: name,
    careersUrl: draft.careersUrl.trim(),
    allowedDomains,
    sourceNote: draft.sourceNote.trim() || null,
  });
  return parsed.success ? { command: parsed.data } : { message: "请检查目标公司的公开来源信息。" };
}

const healthLabels = { healthy: "健康", zero_valid_results: "暂无有效岗位", parser_degraded: "解析异常", rate_limited: "访问受限", hard_failed: "来源不可用", disabled: "已停用", unchecked: "尚未检查" } as const;
const actionLabels = { none: "无需处理", wait_for_next_run: "等待下次发现", retry_later: "稍后重试", retry_or_disable: "稍后重试或停用来源", reenable_source: "可重新启用来源" } as const;
const capabilityLabels = {
  active_discovery: "主动发现",
  read_details: "读取详情",
  continuous_monitoring: "持续监控",
  safe_open_original_page: "安全打开原始页面",
} as const;

export function CompanyWatchlistView({ initialOverview, initialSourceHealth, initialSourceCapabilities, initialHealthRefreshFailed = false, initialCapabilityRefreshFailed = false }: { initialOverview: CompanyWatchlistOverview; initialSourceHealth?: JobSourceHealthOverview; initialSourceCapabilities?: SourceCapabilityProjectionOverview; initialHealthRefreshFailed?: boolean; initialCapabilityRefreshFailed?: boolean }) {
  const [overview, setOverview] = useState(initialOverview);
  const [sourceHealth, setSourceHealth] = useState(initialSourceHealth);
  const [sourceCapabilities, setSourceCapabilities] = useState(initialSourceCapabilities);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [healthRefreshFailure, setHealthRefreshFailure] = useState<RefreshFailure>(initialHealthRefreshFailed ? "initial" : null);
  const [capabilityRefreshFailure, setCapabilityRefreshFailure] = useState<RefreshFailure>(initialCapabilityRefreshFailed ? "initial" : null);
  const [isSaving, setIsSaving] = useState(false);
  const inactive = overview.target.targetState === "inactive";
  const editingItem = overview.items.find((item) => item.itemId === editingItemId) ?? null;
  const healthRefreshMessage = healthRefreshFailure === "initial" ? initialHealthRefreshMessage : "来源诊断未能更新。请重新加载或刷新页面。";
  const capabilitySources = sourceCapabilities?.sources ?? [];

  function updateDraft<Key extends keyof Draft>(key: Key, value: Draft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function fetchSourceHealth(nextOverview: CompanyWatchlistOverview): Promise<JobSourceHealthOverview> {
    const response = await fetch(`/api/job-targets/${nextOverview.target.targetId}/source-health`, { cache: "no-store" });
    if (!response.ok) throw new Error("source health unavailable");
    const parsed = JobSourceHealthOverviewSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.targetId !== nextOverview.target.targetId || parsed.data.watchlistVersion !== nextOverview.version) throw new Error("source health invalid");
    return parsed.data;
  }

  async function fetchSourceCapabilities(nextOverview: CompanyWatchlistOverview): Promise<SourceCapabilityProjectionOverview> {
    const response = await fetch(`/api/job-targets/${nextOverview.target.targetId}/source-capabilities`, { cache: "no-store" });
    if (!response.ok) throw new Error("source capabilities unavailable");
    const parsed = SourceCapabilityProjectionOverviewSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.targetId !== nextOverview.target.targetId || parsed.data.watchlistVersion !== nextOverview.version) throw new Error("source capabilities invalid");
    return parsed.data;
  }

  async function applySuccessfulMutation(nextOverview: CompanyWatchlistOverview, successMessage: string) {
    // A successful write invalidates every prior health identity/version before the
    // authoritative projection has returned.
    setSourceHealth(undefined);
    setSourceCapabilities(undefined);
    setOverview(nextOverview);
    const [health, capabilities] = await Promise.allSettled([fetchSourceHealth(nextOverview), fetchSourceCapabilities(nextOverview)]);
    if (health.status === "fulfilled") { setSourceHealth(health.value); setHealthRefreshFailure(null); } else { setHealthRefreshFailure("post_write"); }
    if (capabilities.status === "fulfilled") { setSourceCapabilities(capabilities.value); setCapabilityRefreshFailure(null); } else { setCapabilityRefreshFailure("post_write"); }
    setMessage(health.status === "rejected" ? postWriteHealthRefreshMessage : successMessage);
  }

  async function retrySourceHealth() {
    setMessage(""); setIsSaving(true);
    try {
      setSourceHealth(await fetchSourceHealth(overview));
      setHealthRefreshFailure(null);
    } catch {
      setSourceHealth(undefined);
      setHealthRefreshFailure((current) => current ?? "initial");
    } finally {
      setIsSaving(false);
    }
  }

  async function retrySourceCapabilities() {
    setMessage(""); setIsSaving(true);
    try { setSourceCapabilities(await fetchSourceCapabilities(overview)); setCapabilityRefreshFailure(null); }
    catch { setSourceCapabilities(undefined); setCapabilityRefreshFailure((current) => current ?? "initial"); }
    finally { setIsSaving(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inactive) return;
    const validation = validateDraft(draft, overview.version);
    if (!validation.command) { setMessage(validation.message!); return; }
    const path = editingItem
      ? `/api/job-targets/${overview.target.targetId}/company-watchlist/items/${editingItem.itemId}/revisions`
      : `/api/job-targets/${overview.target.targetId}/company-watchlist/items`;
    setMessage(""); setIsSaving(true);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validation.command) });
      if (!response.ok) { setMessage(response.status === 409 ? conflictMessage : "暂时无法保存目标公司，请稍后重试。"); return; }
      const parsed = CompanyWatchlistOverviewSchema.safeParse(await response.json());
      if (!parsed.success) { setMessage("暂时无法保存目标公司，请稍后重试。"); return; }
      await applySuccessfulMutation(parsed.data, editingItem ? "目标公司已更新。" : "目标公司已添加。");
      setDraft(emptyDraft); setEditingItemId(null);
    } catch {
      setMessage("暂时无法保存目标公司，请稍后重试。");
    } finally {
      setIsSaving(false);
    }
  }

  async function mutate(path: string, body: unknown, successMessage: string) {
    if (inactive) return;
    setMessage(""); setIsSaving(true);
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) { setMessage(response.status === 409 ? conflictMessage : "暂时无法更新 Watchlist，请稍后重试。"); return; }
      const parsed = CompanyWatchlistOverviewSchema.safeParse(await response.json());
      if (!parsed.success) { setMessage("暂时无法更新 Watchlist，请稍后重试。"); return; }
      await applySuccessfulMutation(parsed.data, successMessage);
    } catch {
      setMessage("暂时无法更新 Watchlist，请稍后重试。");
    } finally {
      setIsSaving(false);
    }
  }

  function startEditing(item: CompanyWatchlistItem) {
    setDraft(draftFrom(item)); setEditingItemId(item.itemId); setMessage("");
  }

  function move(item: CompanyWatchlistItem, direction: -1 | 1) {
    const index = overview.items.findIndex(({ itemId }) => itemId === item.itemId);
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= overview.items.length) return;
    const ordered = [...overview.items];
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex]!, ordered[index]!];
    void mutate(
      `/api/job-targets/${overview.target.targetId}/company-watchlist/reorders`,
      { expectedVersion: overview.version, orderedItemIds: ordered.map(({ itemId }) => itemId) },
      "Watchlist 优先级已更新。",
    );
  }

  return <main className="container workbench-main company-watchlist-main">
    <section aria-labelledby="company-watchlist-title" className="company-watchlist-intro">
      <p className="workbench-kicker">求职目标 · 公开来源台账</p>
      <h1 id="company-watchlist-title">{overview.target.roleFamily}的目标公司 Watchlist</h1>
      <p>为已确认的求职目标维护可验证的公开招聘来源。顺序决定优先级，已停用来源不会进入新的运行范围。</p>
      <p className="company-watchlist-version">Watchlist 版本 {overview.version}</p>
      {inactive ? <p className="profile-status" role="status">该求职目标已停用，不能维护 Watchlist。</p> : null}
    </section>

    <section aria-labelledby="company-watchlist-form-title" className="company-watchlist-section">
      <h2 id="company-watchlist-form-title">{editingItem ? `编辑 ${editingItem.canonicalCompanyName}` : "添加目标公司"}</h2>
      <p className="company-watchlist-notice">{safetyNotice}</p>
      <form className="company-watchlist-form" onSubmit={save}>
        <label>公司规范名称<input aria-invalid={message === "请填写公司规范名称。"} disabled={inactive || isSaving} onChange={(event) => updateDraft("canonicalCompanyName", event.target.value)} value={draft.canonicalCompanyName} /></label>
        <label>公开招聘入口<input aria-invalid={message.includes("公开招聘入口") || message.includes("有效的公开招聘入口")} disabled={inactive || isSaving} inputMode="url" onChange={(event) => updateDraft("careersUrl", event.target.value)} value={draft.careersUrl} /></label>
        <label>允许域<input disabled={inactive || isSaving} onChange={(event) => updateDraft("allowedDomains", event.target.value)} placeholder="careers.example.com，jobs.example.com" value={draft.allowedDomains} /></label>
        <label>来源备注<textarea disabled={inactive || isSaving} onChange={(event) => updateDraft("sourceNote", event.target.value)} value={draft.sourceNote} /></label>
        <div className="company-watchlist-form-actions">
          <button className="workbench-touch-target" disabled={inactive || isSaving} type="submit">{editingItem ? "保存修改" : "保存目标公司"}</button>
          {editingItem ? <button className="workbench-touch-target" disabled={isSaving} onClick={() => { setEditingItemId(null); setDraft(emptyDraft); setMessage(""); }} type="button">取消编辑</button> : null}
        </div>
      </form>
      {message ? <p aria-live="polite" className="profile-status" role="status">{message}</p> : null}
    </section>

    <section aria-labelledby="company-watchlist-ledger-title" className="company-watchlist-section">
      <h2 id="company-watchlist-ledger-title">已登记来源</h2>
      {overview.items.length ? <ol className="company-watchlist-list">{overview.items.map((item, index) => <li key={item.itemId}>
        <article aria-label={`目标公司来源：${item.canonicalCompanyName}`}>
          <p className="company-watchlist-priority">优先级 {String(item.position).padStart(2, "0")}</p>
          <div className="company-watchlist-row-heading"><div><h3>{item.canonicalCompanyName}</h3><p>{item.state === "enabled" ? "已启用" : "已停用"}</p></div><p>来源状态</p></div>
          <p className="company-watchlist-url">{item.careersUrl}</p>
          <p>允许域：{item.allowedDomains.join("、")}</p>
          {item.sourceNote ? <p>{item.sourceNote}</p> : null}
          <div className="company-watchlist-actions">
            <button aria-label={`编辑 ${item.canonicalCompanyName}`} className="workbench-touch-target" disabled={inactive || isSaving} onClick={() => startEditing(item)} type="button">编辑</button>
            <button aria-label={`上移 ${item.canonicalCompanyName}`} className="workbench-touch-target" disabled={inactive || isSaving || index === 0} onClick={() => move(item, -1)} type="button">上移</button>
            <button aria-label={`下移 ${item.canonicalCompanyName}`} className="workbench-touch-target" disabled={inactive || isSaving || index === overview.items.length - 1} onClick={() => move(item, 1)} type="button">下移</button>
            <button aria-label={`${item.state === "enabled" ? "停用" : "启用"} ${item.canonicalCompanyName}`} className="workbench-touch-target" disabled={inactive || isSaving} onClick={() => void mutate(`/api/job-targets/${overview.target.targetId}/company-watchlist/items/${item.itemId}/state-changes`, { expectedVersion: overview.version, state: item.state === "enabled" ? "disabled" : "enabled" }, item.state === "enabled" ? "来源已停用。" : "来源已启用。")} type="button">{item.state === "enabled" ? "停用" : "启用"}</button>
          </div>
        </article>
      </li>)}</ol> : <p className="profile-next-step">尚未登记目标公司。添加第一个公开来源后，它会成为优先级 01。</p>}
    </section>
    {capabilitySources.length ? <section aria-labelledby="source-capabilities-title" className="company-watchlist-section" id="source-capabilities">
      <h2 id="source-capabilities-title">来源能力</h2>
      <p>能力是来源稳定支持边界，不会因本次诊断结果扩大或缩小。</p>
      <ol className="company-watchlist-list">{capabilitySources.map((source) => {
        const declaration = source.declaration;
        return <li key={`${source.watchlistItemId}:${declaration.sourceId}`}>
          <article aria-label={`${source.name} 来源能力`}>
            <p>{source.name}</p>
            <p>契约版本：{declaration.contractVersion}</p>
            <p>支持动作：{declaration.capabilities.map((capability) => capabilityLabels[capability]).join("、")}</p>
          </article>
        </li>;
      })}</ol>
    </section> : capabilityRefreshFailure ? <section aria-labelledby="source-capabilities-title" className="company-watchlist-section" id="source-capabilities">
      <h2 id="source-capabilities-title">来源能力</h2><p>{initialCapabilityRefreshMessage}</p>
      <button className="workbench-touch-target" disabled={isSaving} onClick={() => void retrySourceCapabilities()} type="button">重新加载来源能力</button>
    </section> : null}
    {sourceHealth ? <section aria-labelledby="source-health-title" className="company-watchlist-section" id="source-health">
      <h2 id="source-health-title">来源诊断</h2>
      <p>显示当前 Watchlist 来源最近一次受控检查；尚未检查的启用来源不会被视为健康。</p>
      <ol className="company-watchlist-list">{sourceHealth.sources.map((source) => <li key={`${source.watchlistItemId}:${source.sourceId}`}>
        <article aria-label={`${source.name} 来源诊断`}>
          <h3>{source.name}</h3>
          <p>状态：{healthLabels[source.status ?? "unchecked"]}</p>
          <p>最后检查：{source.lastCheckedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(source.lastCheckedAt)) : "尚未检查"}</p>
          <p>影响范围：{source.impact.scope === "none" ? "无" : source.impact.scope === "entire_source" ? "整个来源" : `岗位详情（${source.impact.affectedCount} 项）`}</p>
          <p>建议动作：{actionLabels[source.suggestedAction]}</p>
        </article>
      </li>)}</ol>
    </section> : healthRefreshFailure ? <section aria-labelledby="source-health-title" className="company-watchlist-section" id="source-health">
      <h2 id="source-health-title">来源诊断</h2>
      <p>{healthRefreshMessage}</p>
      <button className="workbench-touch-target" disabled={isSaving} onClick={() => void retrySourceHealth()} type="button">重新加载来源诊断</button>
    </section> : null}
  </main>;
}
