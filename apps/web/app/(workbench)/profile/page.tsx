import type { CareerImportList } from "@job-copilot/contracts/career-import";
import { ProfileImportView } from "@/components/workbench/profile-import-view";
import { unstable_rethrow } from "next/navigation";
import { getCareerImports } from "@/lib/server/career-imports";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "画像 | AI Job Search Copilot",
};

type ProfilePageProps = {
  searchParams: Promise<{ importError?: string | string[] }>;
};

const formFailureMessages: Record<string, string> = {
  CAREER_DOCUMENT_REQUIRED: "请选择一个 Markdown 文件。",
  TOO_MANY_CAREER_DOCUMENTS: "一次只能上传一个 Markdown 文件。",
  UNSUPPORTED_CAREER_DOCUMENT_TYPE: "仅支持 UTF-8 Markdown 文件。",
  CAREER_DOCUMENT_TOO_LARGE: "Markdown 文件不能超过 512 KiB。",
  CAREER_DOCUMENT_INVALID_UTF8: "Markdown 文件必须使用 UTF-8 编码。",
  CAREER_DOCUMENT_EMPTY: "Markdown 文件不能为空。",
  CAREER_DOCUMENT_STORAGE_UNAVAILABLE: "职业资料暂时无法保存，请稍后重试。",
  CAREER_IMPORT_QUEUE_UNAVAILABLE: "解析任务暂时不可用，请稍后重试。",
  CAREER_IMPORT_UNAVAILABLE: "职业资料暂时无法处理，请稍后重试。",
};

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const careerImportsPromise = getCareerImports();
  const { importError } = await searchParams;
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

  const initialErrorMessage = typeof importError === "string" ? formFailureMessages[importError] ?? null : null;
  return <ProfileImportView initialErrorMessage={initialErrorMessage} initialImport={careerImports.imports[0] ?? null} />;
}
