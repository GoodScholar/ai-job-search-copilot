"use server";

import type { CreateCareerImportResponse } from "@job-copilot/contracts/career-import";
import { isCareerPrivacyMode } from "@job-copilot/contracts/career-document-privacy";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

export type UploadActionState =
  | { ok: false; code: string; message: string }
  | { ok: true; import: CreateCareerImportResponse };

const failureMessages: Record<string, string> = {
  CAREER_DOCUMENT_REQUIRED: "请选择一个 Markdown 文件。",
  TOO_MANY_CAREER_DOCUMENTS: "一次只能上传一个 Markdown 文件。",
  UNSUPPORTED_CAREER_DOCUMENT_TYPE: "仅支持 UTF-8 Markdown 文件。",
  CAREER_DOCUMENT_TOO_LARGE: "Markdown 文件不能超过 512 KiB。",
  CAREER_DOCUMENT_INVALID_UTF8: "Markdown 文件必须使用 UTF-8 编码。",
  CAREER_DOCUMENT_EMPTY: "Markdown 文件不能为空。",
  CAREER_PRIVACY_DECISION_REQUIRED: "请先完成隐私检查并选择处理方式。",
  PROTECTED_CAREER_DOCUMENT_REQUIRED: "选择保留原件时，必须同时提交受保护原件。",
  CAREER_PROCESSING_COPY_NOT_SANITIZED: "脱敏副本仍包含敏感信息，请检查后重试。",
  CAREER_PROCESSING_COPY_MISMATCH: "脱敏副本与原件不一致，请重新选择文件后再试。",
  CAREER_DOCUMENT_STORAGE_UNAVAILABLE: "职业资料暂时无法保存，请稍后重试。",
  CAREER_IMPORT_QUEUE_UNAVAILABLE: "解析任务暂时不可用，请稍后重试。",
  CAREER_IMPORT_UNAVAILABLE: "职业资料暂时无法处理，请稍后重试。",
};

function safeFailureCode(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(failureMessages, value)
    ? value
    : "CAREER_IMPORT_UNAVAILABLE";
}

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
  const privacyMode = formData.get("privacyMode");
  if (isCareerPrivacyMode(privacyMode)) {
    upload.set("privacyMode", privacyMode);
  }
  const protectedOriginal = formData.get("protectedOriginal");
  if (protectedOriginal instanceof File) {
    upload.set("protectedOriginal", protectedOriginal);
  }

  try {
    return { ok: true, import: await api.createCareerImport(sessionToken, upload) };
  } catch (error) {
    const rawCode = typeof error === "object" && error !== null && "problem" in error
      && typeof error.problem === "object" && error.problem !== null && "code" in error.problem
      && typeof error.problem.code === "string"
      ? error.problem.code
      : null;
    const code = safeFailureCode(rawCode);
    return {
      ok: false,
      code,
      message: failureMessages[code],
    };
  }
}
