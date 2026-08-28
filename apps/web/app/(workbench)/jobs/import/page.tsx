import { JobImportView } from "@/components/workbench/job-import-view";
import { getJobImports } from "@/lib/server/job-imports";
import { unstable_rethrow } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "导入岗位 | AI Job Search Copilot" };

export default async function JobImportPage() {
  const importsResult = await Promise.allSettled([getJobImports()]);
  const imports = importsResult[0];
  if (imports.status === "rejected") {
    unstable_rethrow(imports.reason);
    return (
      <main className="container workbench-main">
        <section aria-labelledby="job-import-error-title" className="workbench-error" role="status">
          <p className="workbench-kicker">岗位导入 · 暂未读取</p>
          <h1 id="job-import-error-title">无法读取岗位导入</h1>
          <p>暂时无法读取你的岗位导入记录。请稍后重新尝试。</p>
          <a href="/jobs/import">重新尝试</a>
        </section>
      </main>
    );
  }

  return <JobImportView initialImports={imports.value.imports} />;
}
