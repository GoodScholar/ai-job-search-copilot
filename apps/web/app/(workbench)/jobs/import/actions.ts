"use server";

import {
  CreateJobImportCommandSchema,
  type CreateJobImportResponse,
} from "@job-copilot/contracts/job-imports";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

export type JobImportActionState =
  | { ok: false; code: string; message: string }
  | { ok: true; import: CreateJobImportResponse & { reused: boolean } };

const failureMessages: Record<string, string> = {
  JOB_IMPORT_CONTENT_INVALID: "岗位描述不能为空且不能超过 512 KiB。",
  JOB_IMPORT_OBJECT_STORAGE_FAILED: "岗位正文暂时无法保存，请稍后重试。",
  JOB_IMPORT_QUEUE_UNAVAILABLE: "岗位导入任务暂时不可用，请稍后重试。",
  JOB_IMPORT_UNAVAILABLE: "岗位导入暂时不可用，请稍后重试。",
  JOB_PAGE_URL_INVALID: "岗位链接格式无效。", JOB_PAGE_TARGET_REJECTED: "该岗位链接不允许访问。",
  JOB_PAGE_REDIRECT_INVALID: "岗位链接跳转异常。", JOB_PAGE_TIMEOUT: "岗位页面读取超时，请稍后重试。",
  JOB_PAGE_UNREACHABLE: "岗位页面暂时无法访问。", JOB_PAGE_RESPONSE_TOO_LARGE: "岗位页面内容过大。",
  JOB_PAGE_CONTENT_TYPE_INVALID: "该链接不是可导入的岗位页面。", JOB_PAGE_LISTING: "该链接是岗位列表，请提交具体岗位页面。",
  JOB_PAGE_LOGIN_REQUIRED: "该岗位页面需要登录后访问。", JOB_PAGE_EXPIRED: "该岗位已过期或下架。",
  JOB_PAGE_RATE_LIMITED: "岗位网站暂时限制访问，请稍后重试。", JOB_PAGE_UNRECOGNIZED: "无法识别为有效岗位页面。",
};

async function decodeMarkdownUpload(file: File): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
}

function safeFailureCode(value: unknown): keyof typeof failureMessages {
  return typeof value === "string" && Object.hasOwn(failureMessages, value)
    ? value as keyof typeof failureMessages
    : "JOB_IMPORT_UNAVAILABLE";
}

export async function createJobImportAction(
  _previousState: JobImportActionState,
  formData: FormData,
): Promise<JobImportActionState> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Fjobs%2Fimport");

  const file = formData.get("file");
  let command;
  try {
    command = file instanceof File
      ? { inputType: "markdown_upload" as const, originalFilename: file.name, content: await decodeMarkdownUpload(file) }
      : typeof formData.get("url") === "string" && formData.get("url")
        ? { inputType: "url" as const, url: formData.get("url") }
      : { inputType: "pasted_text" as const, content: typeof formData.get("content") === "string" ? formData.get("content") : "" };
  } catch {
    return { ok: false, code: "JOB_IMPORT_CONTENT_INVALID", message: failureMessages.JOB_IMPORT_CONTENT_INVALID };
  }
  const parsed = CreateJobImportCommandSchema.safeParse(command);
  if (!parsed.success) {
    const code = command.inputType === "url" ? "JOB_PAGE_URL_INVALID" : "JOB_IMPORT_CONTENT_INVALID";
    return { ok: false, code, message: failureMessages[code] };
  }

  try {
    return { ok: true, import: await api.createJobImport(sessionToken, parsed.data) };
  } catch (error) {
    const rawCode = typeof error === "object" && error !== null && "problem" in error
      && typeof error.problem === "object" && error.problem !== null && "code" in error.problem
      ? error.problem.code
      : null;
    const code = safeFailureCode(rawCode);
    return { ok: false, code, message: failureMessages[code] };
  }
}
