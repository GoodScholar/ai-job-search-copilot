import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createJobImport: vi.fn(),
  createJobTriageVersion: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));

vi.mock("@/lib/server/api-client", () => ({ api: { createJobImport: mocks.createJobImport, createJobTriageVersion: mocks.createJobTriageVersion } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { createJobImportAction, createJobTriageAction } from "./actions";

afterEach(() => vi.clearAllMocks());

const initialState = { ok: false, code: "", message: "" } as const;

it("每次提交都验证会话，并且仅向 API 转发岗位导入命令", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createJobImport.mockResolvedValue({ importId: "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", inputType: "pasted_text", originalFilename: null, status: "imported", failureCode: null, createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:00:00.000Z", detailUrl: "/v1/job-imports/b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98" });
  const pasted = new FormData();
  pasted.set("content", "岗位正文");
  pasted.set("ignored", "不可信字段");

  await expect(createJobImportAction(initialState, pasted)).resolves.toMatchObject({ ok: true, import: { status: "imported" } });
  expect(mocks.createJobImport).toHaveBeenCalledWith("a".repeat(43), { inputType: "pasted_text", content: "岗位正文" });
});

it("解码 Markdown 上传并重定向未登录用户", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(createJobImportAction(initialState, new FormData())).rejects.toThrow("redirect:/login?returnTo=%2Fjobs%2Fimport");

  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createJobImport.mockResolvedValue({ status: "imported" });
  const upload = new FormData();
  upload.set("file", new File(["# 岗位\n\n前端工程师"], "frontend.md", { type: "text/markdown" }));

  await createJobImportAction(initialState, upload);
  expect(mocks.createJobImport).toHaveBeenCalledWith("a".repeat(43), {
    inputType: "markdown_upload", originalFilename: "frontend.md", content: "# 岗位\n\n前端工程师",
  });
});

it("拒绝非法 UTF-8 Markdown，且不会调用 API", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const upload = new FormData();
  upload.set("file", new File([new Uint8Array([0xc3, 0x28])], "broken.md", { type: "text/markdown" }));

  await expect(createJobImportAction(initialState, upload)).resolves.toEqual({
    ok: false, code: "JOB_IMPORT_CONTENT_INVALID", message: "岗位描述不能为空且不能超过 512 KiB。",
  });
  expect(mocks.createJobImport).not.toHaveBeenCalled();
});

it("拒绝非法岗位链接，且显示链接专属提示", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const formData = new FormData();
  formData.set("url", "not-a-url");

  await expect(createJobImportAction(initialState, formData)).resolves.toEqual({
    ok: false, code: "JOB_PAGE_URL_INVALID", message: "岗位链接格式无效。",
  });
  expect(mocks.createJobImport).not.toHaveBeenCalled();
});

it("将未受信任的 API 错误码映射为固定中文提示", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createJobImport.mockRejectedValue({ problem: { code: "constructor", message: "internal host secret" } });

  const formData = new FormData();
  formData.set("content", "岗位正文");
  await expect(createJobImportAction(initialState, formData)).resolves.toEqual({
    ok: false, code: "JOB_IMPORT_UNAVAILABLE", message: "岗位导入暂时不可用，请稍后重试。",
  });
});

it("评估 action 严格转发目标并隐藏 API 错误细节", async () => {
  const opportunityId = "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
  const targetId = "c0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createJobTriageVersion.mockResolvedValue({ triageVersionId: "d0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98" });
  await expect(createJobTriageAction(opportunityId, targetId)).resolves.toMatchObject({ ok: true });
  expect(mocks.createJobTriageVersion).toHaveBeenCalledWith("a".repeat(43), opportunityId, { targetId });

  mocks.createJobTriageVersion.mockRejectedValue(new Error("internal api secret"));
  await expect(createJobTriageAction(opportunityId, targetId)).resolves.toEqual({ ok: false, message: "岗位评估暂时不可用，请稍后重试。" });
});
