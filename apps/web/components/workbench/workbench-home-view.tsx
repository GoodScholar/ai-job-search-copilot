"use client";

import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import type { JobTargetOverview } from "@job-copilot/contracts/job-targets";
import type { RunPreflightReport } from "@job-copilot/contracts/run-preflight";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AgentRunPanel } from "./agent-run-panel";
import { AgentInboxPanel, loadAgentInbox } from "./agent-inbox-panel";

type UnavailableSection = "summary" | "targets" | "run" | "inbox" | "preflight";
type WorkbenchHomeViewProps = {
  home: WorkbenchHome | null;
  targets: JobTargetOverview | null;
  initialRun: AgentRunDetail | null;
  preflight?: RunPreflightReport | null;
  inbox: { items: AgentInboxItem[] };
  unavailableSections?: UnavailableSection[];
};

const summaryItems = [
  ["今日推荐", "todayRecommendations"], ["待确认事实", "pendingFacts"], ["运行中的求职代理", "activeAgentRuns"], ["失败的求职代理", "failedAgentRuns"], ["需要关注的来源", "sourceFailures"], ["待决定事项", "pendingDecisions"],
] as const;

export async function loadOpenAgentInbox(): Promise<AgentInboxItem[] | false> {
  return loadAgentInbox("pending");
}

function subscribeToOnlineState(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); };
}

function readOnlineState() { return navigator.onLine; }
function readServerOnlineState() { return true; }

export function WorkbenchHomeView({ home, targets, initialRun, preflight = null, inbox, unavailableSections = [] }: WorkbenchHomeViewProps) {
  return <WorkbenchHomeContent home={home} inbox={inbox} initialRun={initialRun} preflight={preflight} targets={targets} unavailableSections={unavailableSections} />;
}

function WorkbenchHomeContent({ home, targets, initialRun, preflight: initialPreflight = null, inbox, unavailableSections = [] }: WorkbenchHomeViewProps) {
  const router = useRouter();
  const [runRefreshVersion, setRunRefreshVersion] = useState(0);
  const [preflight, setPreflight] = useState(initialPreflight);
  const [inboxRefresh, setInboxRefresh] = useState<{ source: typeof inbox; items: AgentInboxItem[] } | null>(null);
  const inboxItems = inboxRefresh?.source === inbox ? inboxRefresh.items : inbox.items;
  const online = useSyncExternalStore(subscribeToOnlineState, readOnlineState, readServerOnlineState);
  const [refreshRequestedFor, setRefreshRequestedFor] = useState<typeof inbox | null>(null);
  const [summaryAdjustment, setSummaryAdjustment] = useState({ source: home, pendingDecisions: 0 });
  const stale = refreshRequestedFor === inbox;
  const summaryUnavailable = unavailableSections.includes("summary") || home === null;
  const inboxUnavailable = unavailableSections.includes("inbox");
  const targetsUnavailable = unavailableSections.includes("targets") || targets === null;
  const runUnavailable = unavailableSections.includes("run");
  const preflightUnavailable = unavailableSections.includes("preflight");
  const adjustment = summaryAdjustment.source === home ? summaryAdjustment : { pendingDecisions: 0 };
  const summary = home ? {
    ...home.summary,
    pendingDecisions: Math.max(0, home.summary.pendingDecisions - adjustment.pendingDecisions),
  } : null;
  const pendingDecisions = summary?.pendingDecisions ?? 0;
  const hasPendingFacts = (summary?.pendingFacts ?? 0) > 0;

  useEffect(() => {
    const onlineListener = () => { setRefreshRequestedFor(inbox); router.refresh(); };
    window.addEventListener("online", onlineListener);
    return () => window.removeEventListener("online", onlineListener);
  }, [inbox, router]);

  const refreshInbox = useCallback(async () => {
    const nextItems = await loadOpenAgentInbox();
    if (nextItems === false) return false;
    setInboxRefresh({ source: inbox, items: nextItems });
    return true;
  }, [inbox]);

  return (
    <main className="container workbench-main">
      {(!online || stale || unavailableSections.length > 0) && <p className="workbench-connection" role="status">{!online ? "离线：正在显示上次成功读取的数据，可能已过期。" : stale ? "网络已恢复，正在等待最新数据。" : "部分内容暂时无法读取，其余可用内容仍会保留。"}</p>}
      <section aria-labelledby="workbench-home-title" className="workbench-intro">
        <h1 id="workbench-home-title">{summaryUnavailable ? "待决定事项暂时无法读取" : pendingDecisions > 0 ? "先处理需要你决定的事项" : "今天暂无待决定事项"}</h1>
        <p>{summaryUnavailable ? "今日摘要暂时无法读取，其余可用内容仍会保留。" : pendingDecisions > 0 ? "先完成待决定事项，再查看今天的推荐、运行和来源状态。" : "当前没有等待你确认的事项；新的确认、异常或推荐会显示在这里。"}</p>
      </section>

      {summaryUnavailable ? <section aria-label="今日摘要不可用" className="workbench-summary workbench-summary-unavailable"><p>今日摘要暂时无法读取。请稍后刷新重试。</p></section> : <>
        <dl aria-label="当前求职记录摘要" className="workbench-summary">
          {summaryItems.map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{summary![key]}</dd></div>)}
          <div className="workbench-summary-disabled"><dt>投递记录（尚未启用）</dt><dd>0</dd></div>
        </dl>
        <p className="workbench-summary-note">投递记录功能尚未启用，当前不会保存或显示投递数据。</p>
      </>}

      {inboxUnavailable ? <section aria-labelledby="agent-inbox-unavailable-title" className="workbench-ledger"><h2 id="agent-inbox-unavailable-title">待决定事项暂时无法读取</h2><p>请稍后刷新重试。</p></section> : <AgentInboxPanel items={inboxItems} onResolved={() => {
        setSummaryAdjustment((current) => current.source === home
          ? { ...current, pendingDecisions: current.pendingDecisions + 1 }
          : { source: home, pendingDecisions: 1 });
        router.refresh();
      }} onRunUpdated={() => setRunRefreshVersion((version) => version + 1)} />}

      {targetsUnavailable && <section aria-labelledby="targets-unavailable-title" className="workbench-ledger"><h2 id="targets-unavailable-title">求职目标暂时无法读取</h2><p>已成功读取的运行状态仍会保留。请稍后刷新重试。</p></section>}
      {runUnavailable && <section aria-labelledby="run-unavailable-title" className="workbench-ledger"><h2 id="run-unavailable-title">运行状态暂时无法读取</h2><p>已成功读取的求职目标仍可继续使用。请稍后刷新重试。</p></section>}
      {(!targetsUnavailable || !runUnavailable) && <AgentRunPanel currentReport={preflight} initialRun={initialRun} onInboxRefresh={refreshInbox} onPreflightChange={setPreflight} preflightUnavailable={preflightUnavailable} refreshVersion={runRefreshVersion} showDiscoverySchedule targets={targetsUnavailable ? null : targets?.targets ?? []} />}

      <section aria-labelledby="run-policy-entry-title" className="workbench-ledger">
        <div className="workbench-ledger-heading"><p>运行设置 · 账户级</p><h2 id="run-policy-entry-title">管理运行策略</h2></div>
        <div className="workbench-ledger-row"><div><h3>控制后台运行范围</h3><p>查看系统默认和硬上限，设置每次运行的额度与后台运行时间。</p></div><Link className="workbench-ledger-link workbench-touch-target" href="/profile/run-policy">管理运行策略</Link></div>
        <div className="workbench-ledger-row"><div><h3>检查模型连接</h3><p>确认当前模型功能是否可用，并查看下一步建议。</p></div><Link className="workbench-ledger-link workbench-touch-target" href="/profile/model-connection">检查模型连接</Link></div>
      </section>

      <section aria-labelledby="ledger-title" className="workbench-ledger">
        <div className="workbench-ledger-heading"><p>档案纸 · 当前状态</p><h2 id="ledger-title">{hasPendingFacts ? "职业资料等待确认" : "当前无待确认事实"}</h2></div>
        <div className="workbench-ledger-row"><div><h3>下一步</h3><p>{hasPendingFacts ? "检查候选事实的来源和证据，确认后再让它们进入求职画像。" : "你可以查看或导入职业资料，继续完善求职画像。"}</p></div><Link className="workbench-ledger-link workbench-touch-target" href="/profile">{hasPendingFacts ? "查看待确认事实" : "查看职业资料"}</Link></div>
        <p className="workbench-ledger-note">{hasPendingFacts ? "待确认事实尚未进入求职画像，不能用于推荐或材料生成。" : "导入或更新职业资料后，新的候选事实会先等待确认，再用于推荐或材料生成。"}</p>
      </section>

      <section aria-labelledby="job-import-entry-title" className="workbench-ledger workbench-job-import-entry">
        <div className="workbench-ledger-heading"><p>岗位机会 · 主动导入</p><h2 id="job-import-entry-title">已有岗位描述？</h2></div>
        <div className="workbench-ledger-row"><div><h3>导入一条岗位机会</h3><p>粘贴岗位描述或上传 Markdown 文件，系统会保留原始证据并规范化可查看的岗位信息。</p></div><Link className="workbench-ledger-link workbench-touch-target" href="/jobs/import">导入岗位</Link></div>
      </section>
    </main>
  );
}
