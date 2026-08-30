import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import { WorkbenchHomeView } from "@/components/workbench/workbench-home-view";
import { unstable_rethrow } from "next/navigation";
import { getWorkbenchHome } from "@/lib/server/workbench";
import { getJobTargets } from "@/lib/server/job-targets";
import { getAgentRun, getLatestAgentRun } from "@/lib/server/agent-runs";
import { getOpenAgentInbox } from "@/lib/server/agent-inbox";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "工作台 | AI Job Search Copilot",
};

type WorkbenchHomePageProps = { searchParams: Promise<{ runId?: string | string[] }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default async function WorkbenchHomePage({ searchParams }: WorkbenchHomePageProps = { searchParams: Promise.resolve({}) }) {
  let home: WorkbenchHome;
  let targets;
  let initialRun;
  let inbox;

  try {
    const requestedRunId = (await searchParams).runId;
    const hasRequestedRun = requestedRunId !== undefined;
    const runPromise = typeof requestedRunId === "string" && uuid.test(requestedRunId)
      ? getAgentRun(requestedRunId)
      : hasRequestedRun ? Promise.resolve(null) : getLatestAgentRun().then((response) => response.run);
    [home, targets, initialRun, inbox] = await Promise.all([
      getWorkbenchHome(), getJobTargets(), runPromise, getOpenAgentInbox(),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    return (
      <main className="container workbench-main">
        <section aria-labelledby="workbench-error-title" className="workbench-error" role="status">
          <p className="workbench-kicker">求职行动账本 · 暂未读取</p>
          <h1 id="workbench-error-title">无法读取当前求职记录</h1>
          <p>暂时无法确认你的真实求职数据。请稍后重新尝试。</p>
          <a href="/home">重新尝试</a>
        </section>
      </main>
    );
  }

  return <WorkbenchHomeView home={home} inbox={inbox} initialRun={initialRun} targets={targets} />;
}
