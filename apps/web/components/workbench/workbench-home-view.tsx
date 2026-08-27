import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import Link from "next/link";

type WorkbenchHomeViewProps = {
  home: WorkbenchHome;
};

const summaryItems = [
  ["今日推荐", "recommendations"],
  ["待确认事实", "pendingFacts"],
  ["运行中的求职代理", "runningAgentRuns"],
  ["投递记录", "applications"],
] as const;

export function WorkbenchHomeView({ home }: WorkbenchHomeViewProps) {
  const hasPendingFacts = home.summary.pendingFacts > 0;

  return (
    <main className="container workbench-main">
      <section aria-labelledby="workbench-home-title" className="workbench-intro">
        <p className="workbench-kicker">求职行动账本 · 当前记录</p>
        <h1 id="workbench-home-title">从真实职业资料开始</h1>
        <p>{hasPendingFacts
          ? "当前账号已有待确认的候选事实。完成确认后，它们才能成为可用于推荐和材料生成的求职画像。"
          : "当前账号还没有可供推荐、核对或投递的职业资料。所有计数均来自你的当前记录。"}</p>
      </section>

      <dl aria-label="当前求职记录摘要" className="workbench-summary">
        {summaryItems.map(([label, key]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{home.summary[key]}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="ledger-title" className="workbench-ledger">
        <div className="workbench-ledger-heading">
          <p>档案纸 · 当前状态</p>
          <h2 id="ledger-title">{hasPendingFacts ? "职业资料等待确认" : "职业资料尚未建立"}</h2>
        </div>
        <div className="workbench-ledger-row">
          <div>
            <h3>下一步</h3>
            <p>{hasPendingFacts
              ? "检查候选事实的来源和证据，确认后再让它们进入求职画像。"
              : "上传一份 Markdown 或 DOCX 职业资料，系统会从原文中提取带证据的候选事实。"}</p>
          </div>
          <Link className="workbench-ledger-link workbench-touch-target" href="/profile">{hasPendingFacts ? "查看待确认事实" : "导入职业资料"}</Link>
        </div>
        {hasPendingFacts ? (
          <p className="workbench-ledger-note">待确认事实尚未进入求职画像，不能用于推荐或材料生成。</p>
        ) : (
          <p className="workbench-ledger-note">在资料建立前，Copilot 不会生成岗位推荐、启动求职代理或创建投递记录。</p>
        )}
      </section>
    </main>
  );
}
