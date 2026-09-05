import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ApiProblemFilter } from "./api-problem.filter.js";
import { ApiException } from "./api-problem.filter.js";
import type { RunPreflightReport } from "@job-copilot/contracts/run-preflight";

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

it("仅白名单预检报告，绝不序列化异常或堆栈", () => {
  const send = vi.fn(); const status = vi.fn(() => ({ send }));
  const host = { switchToHttp: () => ({ getRequest: () => ({ requestId: "a7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0" }), getResponse: () => ({ status }) }) };
  const preflight: RunPreflightReport = { version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId: null, status: "blocked", warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z", items: [{ code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: "缺少主求职目标", impact: "请先创建主求职目标。", retryable: false, suggestedActions: ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: "2026-09-05T00:00:00.000Z" } }] };
  const error = new Error("private error"); error.stack = "private stack";
  new ApiProblemFilter().catch(Object.assign(new ApiException("RUN_PREFLIGHT_BLOCKED", HttpStatus.CONFLICT, "运行前检查未通过", { preflight }), { error, stack: "private stack", raw: "private raw" }), host as never);
  const body = send.mock.calls[0]?.[0];
  expect(body).toEqual({ code: "RUN_PREFLIGHT_BLOCKED", message: "运行前检查未通过", requestId: "a7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0", preflight });
  expect(JSON.stringify(body)).not.toMatch(/private (error|stack|raw)/);
});
