import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createJobImport: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));

vi.mock("@/lib/server/api-client", () => ({ api: { createJobImport: mocks.createJobImport } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { createJobImportAction } from "./actions";

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

it("将未受信任的 API 错误码映射为固定中文提示", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createJobImport.mockRejectedValue({ problem: { code: "constructor", message: "internal host secret" } });

  const formData = new FormData();
  formData.set("content", "岗位正文");
  await expect(createJobImportAction(initialState, formData)).resolves.toEqual({
    ok: false, code: "JOB_IMPORT_UNAVAILABLE", message: "岗位导入暂时不可用，请稍后重试。",
  });
});
