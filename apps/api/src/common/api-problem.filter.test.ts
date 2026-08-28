import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ApiProblemFilter } from "./api-problem.filter.js";

describe("ApiProblemFilter multipart 限制", () => {
  it.each([
    ["FST_FIELDS_LIMIT", "CAREER_DOCUMENT_REQUIRED", "请选择一份 Markdown、DOCX 或 PDF 职业资料"],
    ["FST_FILES_LIMIT", "TOO_MANY_CAREER_DOCUMENTS", "一次只能上传一份 Markdown、DOCX 或 PDF 职业资料"],
    ["FST_PARTS_LIMIT", "TOO_MANY_CAREER_DOCUMENTS", "一次只能上传一份 Markdown、DOCX 或 PDF 职业资料"],
  ])("将插件 %s 映射为完整中文上传提示", (code, expectedCode, message) => {
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: "a7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0" }),
        getResponse: () => ({ status }),
      }),
    };

    new ApiProblemFilter().catch({ code }, host as never);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(send).toHaveBeenCalledWith({
      code: expectedCode,
      message,
      requestId: "a7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0",
    });
  });
});
