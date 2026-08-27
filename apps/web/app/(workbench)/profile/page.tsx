import type { CareerImportList } from "@job-copilot/contracts/career-import";
import { ProfileImportView } from "@/components/workbench/profile-import-view";
import { unstable_rethrow } from "next/navigation";
import { getCareerImports } from "@/lib/server/career-imports";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "画像 | AI Job Search Copilot",
};

export default async function ProfilePage() {
  const careerImportsPromise = getCareerImports();
  let careerImports: CareerImportList;

  try {
    careerImports = await careerImportsPromise;
  } catch (error) {
    unstable_rethrow(error);
    return (
      <main className="container workbench-main">
        <section aria-labelledby="profile-error-title" className="workbench-error" role="status">
          <p className="workbench-kicker">职业资料 · 暂未读取</p>
          <h1 id="profile-error-title">无法读取职业资料</h1>
          <p>暂时无法确认你的职业资料。请稍后重新尝试。</p>
          <a href="/profile">重新尝试</a>
        </section>
      </main>
    );
  }

  return <ProfileImportView initialImports={careerImports.imports} />;
}
