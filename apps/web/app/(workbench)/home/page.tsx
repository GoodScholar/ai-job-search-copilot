import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import { WorkbenchHomeView } from "@/components/workbench/workbench-home-view";
import { unstable_rethrow } from "next/navigation";
import { getWorkbenchHome } from "@/lib/server/workbench";

export default async function WorkbenchHomePage() {
  let home: WorkbenchHome;

  try {
    home = await getWorkbenchHome();
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

  return <WorkbenchHomeView home={home} />;
}
