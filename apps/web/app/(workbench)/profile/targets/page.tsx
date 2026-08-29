import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { JobTargetsView } from "@/components/workbench/job-targets-view";
import { getJobTargets } from "@/lib/server/job-targets";

export const metadata: Metadata = {
  title: "求职目标 | AI Job Search Copilot",
};

export default async function JobTargetsPage() {
  let overview;
  try {
    overview = await getJobTargets();
  } catch (error) {
    unstable_rethrow(error);
    return (
      <main className="container workbench-main">
        <section aria-labelledby="job-targets-error-title" className="workbench-error" role="status">
          <p className="workbench-kicker">求职目标 · 暂未读取</p>
          <h1 id="job-targets-error-title">无法读取求职目标</h1>
          <p>暂时无法读取你的求职目标。请稍后重新尝试。</p>
          <a href="/profile/targets">重新尝试</a>
        </section>
      </main>
    );
  }
  return <JobTargetsView initialOverview={overview} />;
}
