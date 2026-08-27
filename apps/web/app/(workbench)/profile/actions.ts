"use server";

import type { CreateCareerImportResponse } from "@job-copilot/contracts/career-import";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

export type UploadActionState =
  | { ok: false; code: string; message: string }
  | { ok: true; import: CreateCareerImportResponse };

export const initialUploadActionState: UploadActionState = {
  ok: false,
  code: "",
  message: "",
};

const failureMessages: Record<string, string> = {
  CAREER_DOCUMENT_REQUIRED: "请选择一个 Markdown 文件。",
  TOO_MANY_CAREER_DOCUMENTS: "一次只能上传一个 Markdown 文件。",
  UNSUPPORTED_CAREER_DOCUMENT_TYPE: "仅支持 UTF-8 Markdown 文件。",
  CAREER_DOCUMENT_TOO_LARGE: "Markdown 文件不能超过 512 KiB。",
  CAREER_DOCUMENT_INVALID_UTF8: "Markdown 文件必须使用 UTF-8 编码。",
  CAREER_DOCUMENT_EMPTY: "Markdown 文件不能为空。",
  CAREER_DOCUMENT_STORAGE_UNAVAILABLE: "职业资料暂时无法保存，请稍后重试。",
  CAREER_IMPORT_QUEUE_UNAVAILABLE: "解析任务暂时不可用，请稍后重试。",
};

export async function createCareerImportAction(
  _previousState: UploadActionState,
  formData: FormData,
): Promise<UploadActionState> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) {
    redirect("/login?returnTo=%2Fprofile");
  }

  const file = formData.get("file");
  const upload = new FormData();
  if (file instanceof File) {
    upload.set("file", file);
  }

  try {
    return { ok: true, import: await api.createCareerImport(sessionToken, upload) };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "problem" in error
      && typeof error.problem === "object" && error.problem !== null && "code" in error.problem
      && typeof error.problem.code === "string"
      ? error.problem.code
      : "CAREER_IMPORT_UNAVAILABLE";
    return {
      ok: false,
      code,
      message: failureMessages[code] ?? "职业资料暂时无法处理，请稍后重试。",
    };
  }
}

export async function createCareerImportFormAction(formData: FormData): Promise<void> {
  const result = await createCareerImportAction(initialUploadActionState, formData);
  if (result.ok) {
    redirect("/profile");
  }
  const failureCode = failureMessages[result.code] ? result.code : "CAREER_IMPORT_UNAVAILABLE";
  redirect(`/profile?importError=${failureCode}`);
}
