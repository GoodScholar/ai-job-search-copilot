"use client";

import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import type { JobTargetOverview } from "@job-copilot/contracts/job-targets";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AgentRunPanel } from "./agent-run-panel";
import { AgentInboxPanel, loadAgentInbox } from "./agent-inbox-panel";

type UnavailableSection = "summary" | "targets" | "run" | "inbox";
type WorkbenchHomeViewProps = {
  home: WorkbenchHome | null;
  targets: JobTargetOverview | null;
  initialRun: AgentRunDetail | null;
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
function inboxKey(items: AgentInboxItem[]) { return JSON.stringify(items); }

export function WorkbenchHomeView({ home, targets, initialRun, inbox, unavailableSections = [] }: WorkbenchHomeViewProps) {
  return <WorkbenchHomeContent key={inboxKey(inbox.items)} home={home} inbox={inbox} initialRun={initialRun} targets={targets} unavailableSections={unavailableSections} />;
}

function WorkbenchHomeContent({ home, targets, initialRun, inbox, unavailableSections = [] }: WorkbenchHomeViewProps) {
  const router = useRouter();
  const [runRefreshVersion, setRunRefreshVersion] = useState(0);
  const [inboxRefresh, setInboxRefresh] = useState<{ source: typeof inbox; items: AgentInboxItem[] } | null>(null);
  const inboxItems = inboxRefresh?.source === inbox ? inboxRefresh.items : inbox.items;
  const online = useSyncExternalStore(subscribeToOnlineState, readOnlineState, readServerOnlineState);
  const [refreshRequestedFor, setRefreshRequestedFor] = useState<typeof inbox | null>(null);
  const stale = refreshRequestedFor === inbox;
  const summaryUnavailable = unavailableSections.includes("summary") || home === null;
  const inboxUnavailable = unavailableSections.includes("inbox");
  const targetsUnavailable = unavailableSections.includes("targets") || targets === null;
  const runUnavailable = unavailableSections.includes("run");
  const pendingDecisions = home?.summary.pendingDecisions ?? 0;
  const hasPendingFacts = (home?.summary.pendingFacts ?? 0) > 0;

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
        <p className="workbench-kicker">求职行动内参 · 今日优先</p>
        <h1 id="workbench-home-title">{summaryUnavailable ? "待决定事项暂时无法读取" : pendingDecisions > 0 ? "先处理需要你决定的事项" : "今天暂无待决定事项"}</h1>
        <p>{summaryUnavailable ? "今日摘要暂时无法读取，其余可用内容仍会保留。" : pendingDecisions > 0 ? "先完成待决定事项，再查看今天的推荐、运行和来源状态。" : "当前没有等待你确认的事项；新的确认、异常或推荐会显示在这里。"}</p>
      </section>

      {summaryUnavailable ? <section aria-label="今日摘要不可用" className="workbench-summary workbench-summary-unavailable"><p>今日摘要暂时无法读取。请稍后刷新重试。</p></section> : <>
        <dl aria-label="当前求职记录摘要" className="workbench-summary">
          {summaryItems.map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{home.summary[key]}</dd></div>)}
          <div><dt>投递记录（尚未启用）</dt><dd>0</dd></div>
        </dl>
        <p className="workbench-summary-note">投递记录功能尚未启用，当前不会保存或显示投递数据。</p>
      </>}

      {inboxUnavailable ? <section aria-labelledby="agent-inbox-unavailable-title" className="workbench-ledger"><h2 id="agent-inbox-unavailable-title">待决定事项暂时无法读取</h2><p>请稍后刷新重试。</p></section> : <AgentInboxPanel key={inboxKey(inboxItems)} items={inboxItems} onResolved={() => undefined} onRunUpdated={() => setRunRefreshVersion((version) => version + 1)} />}

      {targetsUnavailable && <section aria-labelledby="targets-unavailable-title" className="workbench-ledger"><h2 id="targets-unavailable-title">求职目标暂时无法读取</h2><p>已成功读取的运行状态仍会保留。请稍后刷新重试。</p></section>}
      {runUnavailable && <section aria-labelledby="run-unavailable-title" className="workbench-ledger"><h2 id="run-unavailable-title">运行状态暂时无法读取</h2><p>已成功读取的求职目标仍可继续使用。请稍后刷新重试。</p></section>}
      {(!targetsUnavailable || !runUnavailable) && <AgentRunPanel initialRun={initialRun} onInboxRefresh={refreshInbox} refreshVersion={runRefreshVersion} showDiscoverySchedule targets={targetsUnavailable ? null : targets?.targets ?? []} />}

      <section aria-labelledby="ledger-title" className="workbench-ledger">
        <div className="workbench-ledger-heading"><p>档案纸 · 当前状态</p><h2 id="ledger-title">{hasPendingFacts ? "职业资料等待确认" : "职业资料尚未建立"}</h2></div>
        <div className="workbench-ledger-row"><div><h3>下一步</h3><p>{hasPendingFacts ? "检查候选事实的来源和证据，确认后再让它们进入求职画像。" : "上传一份 Markdown 或 DOCX 职业资料，系统会从原文中提取带证据的候选事实。"}</p></div><Link className="workbench-ledger-link workbench-touch-target" href="/profile">{hasPendingFacts ? "查看待确认事实" : "导入职业资料"}</Link></div>
        <p className="workbench-ledger-note">{hasPendingFacts ? "待确认事实尚未进入求职画像，不能用于推荐或材料生成。" : "在资料建立前，Copilot 不会生成岗位推荐、启动求职代理或创建投递记录。"}</p>
      </section>

      <section aria-labelledby="job-import-entry-title" className="workbench-ledger workbench-job-import-entry">
        <div className="workbench-ledger-heading"><p>岗位机会 · 主动导入</p><h2 id="job-import-entry-title">已有岗位描述？</h2></div>
        <div className="workbench-ledger-row"><div><h3>导入一条岗位机会</h3><p>粘贴岗位描述或上传 Markdown 文件，系统会保留原始证据并规范化可查看的岗位信息。</p></div><Link className="workbench-ledger-link workbench-touch-target" href="/jobs/import">导入岗位</Link></div>
      </section>
    </main>
  );
}
