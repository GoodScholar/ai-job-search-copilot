import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCareerImport: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));

vi.mock("@/lib/server/api-client", () => ({ api: { createCareerImport: mocks.createCareerImport } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { createCareerImportAction, createCareerImportFormAction, initialUploadActionState } from "./actions";

afterEach(() => vi.clearAllMocks());

it("reauthenticates every upload and forwards only the selected file", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createCareerImport.mockResolvedValue({
    importId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08",
    documentId: "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a",
    sourceFilename: "career.md", status: "queued", failureCode: null,
    createdAt: "2026-08-27T08:00:00.000Z", updatedAt: "2026-08-27T08:00:00.000Z",
    reused: false, detailUrl: "/v1/career-documents/imports/d194d0ce-fc7e-45db-9425-e8ff4eaf8c08",
  });
  const formData = new FormData();
  const file = new File(["# 资料"], "career.md", { type: "text/markdown" });
  formData.set("file", file);
  formData.set("ignored", "untrusted");

  await expect(createCareerImportAction(initialUploadActionState, formData)).resolves.toMatchObject({ ok: true, import: { status: "queued" } });
  expect(mocks.createCareerImport).toHaveBeenCalledWith("a".repeat(43), expect.any(FormData));
  const forwarded = mocks.createCareerImport.mock.calls[0]![1] as FormData;
  expect(forwarded.get("file")).toBe(file);
  expect(forwarded.get("ignored")).toBeNull();
});

it("redirects without a session and maps API failures to fixed Chinese messages", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(createCareerImportAction(initialUploadActionState, new FormData())).rejects.toThrow("redirect:/login?returnTo=%2Fprofile");

  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createCareerImport.mockRejectedValue({ status: 503, problem: { code: "CAREER_IMPORT_QUEUE_UNAVAILABLE", requestId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", message: "internal failure" } });
  await expect(createCareerImportAction(initialUploadActionState, new FormData())).resolves.toEqual({
    ok: false, code: "CAREER_IMPORT_QUEUE_UNAVAILABLE", message: "解析任务暂时不可用，请稍后重试。",
  });
});

it("redirects no-JavaScript form failures through a whitelisted profile query", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createCareerImport.mockRejectedValue({ problem: { code: "CAREER_DOCUMENT_EMPTY", message: "internal failure" } });

  await expect(createCareerImportFormAction(new FormData())).rejects.toThrow("redirect:/profile?importError=CAREER_DOCUMENT_EMPTY");
  expect(mocks.redirect).toHaveBeenCalledWith("/profile?importError=CAREER_DOCUMENT_EMPTY");
});

it.each(["unknown", "toString", "constructor", "__proto__"])("drops unsafe API failure code %s", async (code) => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.createCareerImport.mockRejectedValue({ problem: { code, message: "internal failure" } });

  await expect(createCareerImportFormAction(new FormData())).rejects.toThrow("redirect:/profile?importError=CAREER_IMPORT_UNAVAILABLE");
  await expect(createCareerImportAction(initialUploadActionState, new FormData())).resolves.toEqual({
    ok: false,
    code: "CAREER_IMPORT_UNAVAILABLE",
    message: "职业资料暂时无法处理，请稍后重试。",
  });
});
