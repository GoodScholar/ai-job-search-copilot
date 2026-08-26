import type { WorkbenchHome } from "@job-copilot/contracts/workbench";

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
  return (
    <main className="container workbench-main">
      <section aria-labelledby="workbench-home-title" className="workbench-intro">
        <p className="workbench-kicker">求职行动账本 · 当前记录</p>
        <h1 id="workbench-home-title">从真实职业资料开始</h1>
        <p>当前账号还没有可供推荐、核对或投递的职业资料。所有计数均来自你的当前记录。</p>
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
          <h2 id="ledger-title">职业资料尚未建立</h2>
        </div>
        <div className="workbench-ledger-row">
          <div>
            <h3>下一步</h3>
            <p>职业资料入口将在后续切片开放</p>
          </div>
          <p className="workbench-ledger-status">暂不可操作</p>
        </div>
        <p className="workbench-ledger-note">在资料建立前，Copilot 不会生成岗位推荐、启动求职代理或创建投递记录。</p>
      </section>
    </main>
  );
}
