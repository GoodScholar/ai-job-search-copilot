import { ProfileImportView } from "@/components/workbench/profile-import-view";
import { unstable_rethrow } from "next/navigation";
import { getCareerImports } from "@/lib/server/career-imports";
import { getProfile } from "@/lib/server/profile-review";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "画像 | AI Job Search Copilot",
};

export default async function ProfilePage() {
  const [careerImportsResult, profileResult] = await Promise.allSettled([getCareerImports(), getProfile()]);

  try {
    if (careerImportsResult.status === "rejected") throw careerImportsResult.reason;
    if (profileResult.status === "rejected") throw profileResult.reason;
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

  return <ProfileImportView initialImports={careerImportsResult.value.imports} initialProfile={profileResult.value} />;
}
