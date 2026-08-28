import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PdfCareerProcessingError extends Error {
    constructor(readonly code: "TOO_LARGE" | "INVALID_PDF" | "ENCRYPTED_PDF" | "NO_TEXT" | "TOO_COMPLEX") {
      super(code);
    }
  }

  return {
    createCareerImportAction: vi.fn(),
    extractCanonicalPdfPageText: vi.fn(),
    PdfCareerProcessingError,
  };
});

vi.mock("@/app/(workbench)/profile/actions", () => ({
  createCareerImportAction: mocks.createCareerImportAction,
}));

vi.mock("@/lib/pdf-career-processing", () => ({
  extractCanonicalPdfPageText: mocks.extractCanonicalPdfPageText,
  PdfCareerProcessingError: mocks.PdfCareerProcessingError,
}));

import { ProfileImportView } from "./profile-import-view";

const importId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const documentId = "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";
const queuedImport = {
  importId, documentId, sourceFilename: "career.md", sourceFormat: "markdown" as const, privacyStatus: "sanitized_only" as const,
  status: "queued" as const, failureCode: null,
  createdAt: "2026-08-27T08:00:00.000Z", updatedAt: "2026-08-27T08:00:00.000Z", candidateFactCount: 0,
};

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(file);
  });
}
const completedDetail = {
  ...queuedImport,
  status: "completed" as const,
  facts: [{
    factId: "75ff2891-df0c-4e35-a95d-44f1be3fbdb7", factType: "skill" as const,
    factValue: { name: "TypeScript" }, confidenceBasisPoints: 10_000, confirmationStatus: "pending" as const,
    createdAt: "2026-08-27T08:00:02.000Z",
    evidence: { documentId, sourceFilename: "career.md", locatorType: "markdown_lines" as const, startLine: 6, endLine: 6, excerpt: "- TypeScript" },
  }],
};

const replacementImportId = "3e7c3ba2-70fe-47c4-93d6-1a030e87f1ab";
const replacementDetail = {
  ...completedDetail,
  importId: replacementImportId,
  documentId: "cf2824ce-04d7-45a6-a462-4b1bf11aa286",
  sourceFilename: "replacement.md",
  facts: [{
    ...completedDetail.facts[0],
    factId: "6e4fc79c-35b2-4405-b3de-4e5a8a93f6e1",
    factValue: { name: "React" },
    evidence: { ...completedDetail.facts[0].evidence, documentId: "cf2824ce-04d7-45a6-a462-4b1bf11aa286", sourceFilename: "replacement.md" },
  }],
};

const completedImport = {
  ...queuedImport,
  importId: "ffdb0ddf-6e75-4c72-9f31-b8514e8fc28d",
  sourceFilename: "completed.md",
  status: "completed" as const,
  candidateFactCount: 1,
};

const pdfCompletedImport = {
  ...completedImport,
  importId: "6fdb0ddf-6e75-4c72-9f31-b8514e8fc28d",
  documentId: "b1b4a7c1-9a17-4a8c-8b36-0f815d042e9a",
  sourceFilename: "completed.pdf",
  sourceFormat: "pdf" as const,
};
const pdfCompletedDetail = {
  ...completedDetail,
  ...pdfCompletedImport,
  facts: [{
    ...completedDetail.facts[0],
    evidence: { documentId: pdfCompletedImport.documentId, sourceFilename: "completed.pdf", locatorType: "pdf_pages" as const, startPage: 2, endPage: 2, excerpt: "- TypeScript" },
  }],
};

const conflictId = "98ff2891-df0c-4e35-a95d-44f1be3fbdb7";
const conflictDetail = {
  ...completedDetail,
  conflicts: [{
    conflictId, kind: "date" as const, status: "pending" as const, resolution: null, profileVersion: null, resolvedAt: null,
    existingFact: {
      factId: "85ff2891-df0c-4e35-a95d-44f1be3fbdb7", factType: "experience" as const,
      factValue: { summary: "AI 工程师｜示例科技｜2023" }, confidenceBasisPoints: 9000, confirmationStatus: "pending" as const,
      createdAt: "2026-08-27T08:00:01.000Z",
      evidence: { documentId, sourceFilename: "career.md", locatorType: "markdown_lines" as const, startLine: 4, endLine: 4, excerpt: "- AI 工程师｜示例科技｜2023" },
    },
    incomingFact: {
      factId: "65ff2891-df0c-4e35-a95d-44f1be3fbdb7", factType: "experience" as const,
      factValue: { summary: "AI 工程师｜示例科技｜2024" }, confidenceBasisPoints: 9000, confirmationStatus: "pending" as const,
      createdAt: "2026-08-27T08:00:02.000Z",
      evidence: { documentId: "cf2824ce-04d7-45a6-a462-4b1bf11aa286", sourceFilename: "career.docx", locatorType: "docx_paragraphs" as const, startParagraph: 2, endParagraph: 3, excerpt: "AI 工程师｜示例科技｜2024" },
    },
  }],
};

async function prepareFile() {
  fireEvent.change(screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料"), {
    target: { files: [new File(["## 技能\n- TypeScript"], "career.md", { type: "text/markdown" })] },
  });
  fireEvent.click(await screen.findByRole("checkbox", { name: /我已检查该文件/ }));
}

function submitPreparedFile() {
  fireEvent.submit(screen.getByRole("button", { name: "上传并解析" }).closest("form")!);
}

async function submitFile() {
  await prepareFile();
  submitPreparedFile();
}

async function confirmSanitizedFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("checkbox", { name: /我已检查该文件/ }));
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.createCareerImportAction.mockReset();
  mocks.extractCanonicalPdfPageText.mockReset();
  vi.useRealTimers();
});

it("detects private information before upload and submits only the sanitized processing copy", async () => {
  let submitted: FormData | undefined;
  mocks.createCareerImportAction.mockImplementation(async (_previous, formData: FormData) => {
    submitted = formData;
    return { ok: true, import: { ...queuedImport, reused: false, detailUrl: `/v1/career-documents/imports/${importId}` } };
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...queuedImport, facts: [] }));
  const user = userEvent.setup();
  const original = "姓名：张三\n邮箱：secret@example.com\n电话：13800000000\n## 技能\n- TypeScript";

  render(<ProfileImportView initialImports={[]} />);
  expect(screen.getByText(/姓名、手机号、邮箱、详细住址、证件号码、照片、二维码和社交账号/)).toBeInTheDocument();
  await user.upload(screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料"), new File([original], "career.md", { type: "text/markdown" }));

  expect(await screen.findByText("发现 3 项敏感信息")).toBeInTheDocument();
  expect(screen.getByText("张*")).toBeInTheDocument();
  expect(screen.getByText("s***@example.com")).toBeInTheDocument();
  expect(screen.getByText("138****0000")).toBeInTheDocument();
  expect(screen.getByText(/姓名：\[姓名\]/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "上传并解析" })).toBeDisabled();

  await user.click(screen.getByRole("radio", { name: "仅上传脱敏副本（原件不离开浏览器）" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(mocks.createCareerImportAction).toHaveBeenCalledTimes(1));
  expect(submitted?.get("privacyMode")).toBe("sanitized_only");
  expect(submitted?.get("protectedOriginal")).toBeNull();
  expect(await readFile(submitted?.get("file") as File)).toBe(
    "姓名：[姓名]\n邮箱：[邮箱]\n电话：[手机号]\n## 技能\n- TypeScript",
  );
});

it("拒绝超限 DOCX，且不会创建上传请求", async () => {
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[]} />);
  await user.upload(screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料"), new File(["x".repeat(524_289)], "too-large.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
  expect(await screen.findByRole("status")).toHaveTextContent("职业资料不能超过 512 KiB");
  expect(mocks.createCareerImportAction).not.toHaveBeenCalled();
});

it("can retain a protected original without sending it as the processing copy", async () => {
  let submitted: FormData | undefined;
  mocks.createCareerImportAction.mockImplementation(async (_previous, formData: FormData) => {
    submitted = formData;
    return { ok: true, import: {
      ...queuedImport,
      privacyStatus: "sanitized_with_protected_original" as const,
      reused: false,
      detailUrl: `/v1/career-documents/imports/${importId}`,
    } };
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...completedDetail, facts: [] }));
  const user = userEvent.setup();
  const original = "邮箱：secret@example.com\n## 技能\n- TypeScript";

  render(<ProfileImportView initialImports={[]} />);
  await user.upload(screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料"), new File([original], "career.md", { type: "text/markdown" }));
  await user.click(await screen.findByRole("radio", { name: "保留受保护原件（下游仍只使用脱敏副本）" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(mocks.createCareerImportAction).toHaveBeenCalledTimes(1));
  expect(submitted?.get("privacyMode")).toBe("retain_protected_original");
  expect(await readFile(submitted?.get("protectedOriginal") as File)).toBe(original);
  expect(await readFile(submitted?.get("file") as File)).toContain("邮箱：[邮箱]");
});

it("shows recent imports and loads the selected import detail", async () => {
  const selectedDetail = {
    ...completedDetail,
    importId: completedImport.importId,
    sourceFilename: completedImport.sourceFilename,
    facts: [{ ...completedDetail.facts[0], evidence: { ...completedDetail.facts[0].evidence, sourceFilename: completedImport.sourceFilename } }],
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json(selectedDetail)));

  render(<ProfileImportView initialImports={[queuedImport, completedImport]} />);

  expect(screen.getByRole("heading", { name: "最近导入" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /career\.md/ })).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: /completed\.md/ }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    `/api/career-imports/${completedImport.importId}`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  ));
  await waitFor(() => expect(screen.getByText("TypeScript")).toBeInTheDocument());
  expect(screen.getAllByRole("button", { name: /career\.md|completed\.md/ })[0]).toHaveAccessibleName(/career\.md/);
});

it("以页码显示 PDF 候选事实证据", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(pdfCompletedDetail));
  render(<ProfileImportView initialImports={[pdfCompletedImport]} />);

  expect(await screen.findByText("第 2 页", { exact: true })).toBeInTheDocument();
});

it("选择无文本层 PDF 时优先显示本次解析错误，且不会提交上传", async () => {
  mocks.extractCanonicalPdfPageText.mockRejectedValue(new mocks.PdfCareerProcessingError("NO_TEXT"));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(completedDetail));
  const user = userEvent.setup();

  render(<ProfileImportView initialImports={[completedImport]} />);
  await user.upload(
    screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料"),
    new File(["%PDF-empty"], "scanned.pdf", { type: "application/pdf" }),
  );

  expect(await screen.findByRole("status")).toHaveTextContent("该 PDF 没有可读取的文本层，请上传文本型 PDF。");
  expect(screen.getByRole("button", { name: "上传并解析" })).toBeDisabled();
  expect(mocks.createCareerImportAction).not.toHaveBeenCalled();
});

it("deduplicates an uploaded reused import and moves it to the top of recent imports", async () => {
  mocks.createCareerImportAction.mockResolvedValue({
    ok: true,
    import: { ...completedImport, reused: true, detailUrl: `/v1/career-documents/imports/${completedImport.importId}` },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...completedDetail, importId: completedImport.importId, facts: [] }));

  render(<ProfileImportView initialImports={[queuedImport, completedImport]} />);
  await submitFile();

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("解析完成"));
  expect(screen.getAllByRole("button", { name: /career\.md|completed\.md/ })[0]).toHaveAccessibleName(/completed\.md/);
  expect(screen.getAllByRole("button", { name: /career\.md|completed\.md/ })).toHaveLength(2);
});

it("uploads only Markdown files and renders quoted pending facts after polling", async () => {
  const user = userEvent.setup();
  mocks.createCareerImportAction.mockResolvedValue({
    ok: true,
    import: { ...queuedImport, reused: false, detailUrl: `/v1/career-documents/imports/${importId}` },
  });
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ ...queuedImport, facts: [] }))
    .mockResolvedValueOnce(Response.json(completedDetail));

  render(<ProfileImportView initialImports={[]} />);
  const input = screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料");
  expect(input).toHaveAttribute("accept", ".md,.docx,.pdf,text/markdown,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf");
  await user.upload(input, new File(["## 技能\\n- TypeScript"], "career.md", { type: "text/markdown" }));
  await confirmSanitizedFile(user);
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/等待解析|解析中/));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("解析完成"), { timeout: 2_000 });
  expect(screen.getByText("待确认")).toBeInTheDocument();
  expect(screen.getAllByText("技能").length).toBeGreaterThan(0);
  expect(screen.getByText("TypeScript")).toBeInTheDocument();
  expect(screen.getAllByText(/career\.md/).length).toBeGreaterThan(0);
  expect(screen.getByText("第 6 行", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("- TypeScript")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认 TypeScript" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(`/api/career-imports/${importId}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it("keeps pending candidates separate from the current trusted profile", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(completedDetail));
  render(<ProfileImportView
    initialImports={[completedImport]}
    initialProfile={{
      profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 1,
      facts: [{
        factId: "680d3e96-5402-4d28-86aa-087cc4e088a5",
        revisionId: "8cc49f65-05f6-4472-b962-53de26c9a584",
        factType: "skill", factValue: { name: "React" }, source: "user_confirmed", candidateFactId: null,
        createdAt: "2026-08-27T08:00:03.000Z",
      }],
    }}
  />);

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(await screen.findByRole("heading", { name: "待确认事实" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认 TypeScript" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "当前可信画像" })).toBeInTheDocument();
  expect(screen.getByText("React", { exact: true })).toBeInTheDocument();
  expect(screen.queryByText("确认、修改和拒绝将在下一阶段开放")).not.toBeInTheDocument();
});

it("confirms a candidate with the current profile version and moves it into trusted facts", async () => {
  const updatedProfile = {
    profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 1,
    facts: [{
      factId: "680d3e96-5402-4d28-86aa-087cc4e088a5",
      revisionId: "8cc49f65-05f6-4472-b962-53de26c9a584",
      factType: "skill", factValue: { name: "TypeScript" }, source: "candidate_fact", candidateFactId: completedDetail.facts[0]!.factId,
      createdAt: "2026-08-27T08:00:03.000Z",
    }],
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(completedDetail))
    .mockResolvedValueOnce(Response.json(updatedProfile));
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[completedImport]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);

  await user.click(await screen.findByRole("button", { name: "确认 TypeScript" }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/profile/candidate-facts/${completedDetail.facts[0]!.factId}/decisions`,
    expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedVersion: 0, decision: "confirmed" }) }),
  ));
  expect(await screen.findByText("TypeScript", { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认 TypeScript" })).not.toBeInTheDocument();
});

it("requires a reason when correcting a candidate and records the user-confirmed value", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(completedDetail))
    .mockResolvedValueOnce(Response.json({
      profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 1,
      facts: [{
        factId: "680d3e96-5402-4d28-86aa-087cc4e088a5", revisionId: "8cc49f65-05f6-4472-b962-53de26c9a584",
        factType: "skill", factValue: { name: "React" }, source: "user_confirmed", candidateFactId: completedDetail.facts[0]!.factId,
        createdAt: "2026-08-27T08:00:03.000Z",
      }],
    }));
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[completedImport]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);

  await user.click(await screen.findByRole("button", { name: "纠正 TypeScript" }));
  const submit = screen.getByRole("button", { name: "保存纠正" });
  expect(submit).toBeDisabled();
  await user.type(screen.getByLabelText("纠正后的内容"), "React");
  await user.type(screen.getByLabelText("纠正原因"), "实际技术栈是 React");
  await user.click(submit);

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/profile/candidate-facts/${completedDetail.facts[0]!.factId}/decisions`,
    expect.objectContaining({ method: "POST", body: JSON.stringify({
      expectedVersion: 0, decision: "corrected", factValue: { name: "React" }, reason: "实际技术栈是 React",
    }) }),
  ));
  expect(await screen.findByText("React", { exact: true })).toBeInTheDocument();
});

it("manually adds, revises, and removes a trusted profile fact with reasons", async () => {
  const factId = "680d3e96-5402-4d28-86aa-087cc4e088a5";
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 1, facts: [{
      factId, revisionId: "8cc49f65-05f6-4472-b962-53de26c9a584", factType: "work_eligibility", factValue: { summary: "可在中国大陆工作" },
      source: "user_confirmed", candidateFactId: null, createdAt: "2026-08-27T08:00:03.000Z",
    }] }))
    .mockResolvedValueOnce(Response.json({ profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 2, facts: [{
      factId, revisionId: "8cc49f65-05f6-4472-b962-53de26c9a584", factType: "work_eligibility", factValue: { summary: "可在中国大陆和新加坡工作" },
      source: "user_confirmed", candidateFactId: null, createdAt: "2026-08-27T08:00:03.000Z",
    }] }))
    .mockResolvedValueOnce(Response.json({ profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 3, facts: [] }));
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);

  await user.selectOptions(screen.getByLabelText("画像事实类型"), "work_eligibility");
  await user.type(screen.getByLabelText("画像事实内容"), "可在中国大陆工作");
  await user.click(screen.getByRole("button", { name: "新增画像事实" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/profile/facts", expect.objectContaining({
    method: "POST", body: JSON.stringify({ expectedVersion: 0, factType: "work_eligibility", factValue: { summary: "可在中国大陆工作" } }),
  })));

  await user.click(await screen.findByRole("button", { name: "修改 工作资格" }));
  await user.clear(screen.getByLabelText("修改后的内容"));
  await user.type(screen.getByLabelText("修改后的内容"), "可在中国大陆和新加坡工作");
  await user.type(screen.getByLabelText("修改原因"), "签证状态更新");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`/api/profile/facts/${factId}/revisions`, expect.objectContaining({
    method: "POST", body: JSON.stringify({ expectedVersion: 1, factValue: { summary: "可在中国大陆和新加坡工作" }, reason: "签证状态更新" }),
  })));

  await user.click(await screen.findByRole("button", { name: "移除 工作资格" }));
  await user.type(screen.getByLabelText("移除原因"), "不再适用");
  await user.click(screen.getByRole("button", { name: "确认移除" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`/api/profile/facts/${factId}/removals`, expect.objectContaining({
    method: "POST", body: JSON.stringify({ expectedVersion: 2, reason: "不再适用" }),
  })));
  expect(screen.getByText("尚无已验证画像事实。")).toBeInTheDocument();
});

it("creates language facts with a level and preserves or changes that level during revision", async () => {
  const factId = "b1c249f8-0d42-41f6-8a7a-7b8c0ce063b2";
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 1, facts: [{
      factId, revisionId: "8cc49f65-05f6-4472-b962-53de26c9a584", factType: "language", factValue: { name: "英语", level: "B2" },
      source: "user_confirmed", candidateFactId: null, createdAt: "2026-08-27T08:00:03.000Z",
    }] }))
    .mockResolvedValueOnce(Response.json({ profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 2, facts: [{
      factId, revisionId: "8cc49f65-05f6-4472-b962-53de26c9a584", factType: "language", factValue: { name: "英语", level: "C1" },
      source: "user_confirmed", candidateFactId: null, createdAt: "2026-08-27T08:00:03.000Z",
    }] }));
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);

  await user.selectOptions(screen.getByLabelText("画像事实类型"), "language");
  await user.type(screen.getByLabelText("画像事实内容"), "英语");
  await user.type(screen.getByLabelText("画像事实语言级别"), "B2");
  await user.click(screen.getByRole("button", { name: "新增画像事实" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/profile/facts", expect.objectContaining({
    body: JSON.stringify({ expectedVersion: 0, factType: "language", factValue: { name: "英语", level: "B2" } }),
  })));

  await user.click(await screen.findByRole("button", { name: "修改 语言" }));
  expect(screen.getByLabelText("修改后的语言级别")).toHaveValue("B2");
  await user.clear(screen.getByLabelText("修改后的语言级别"));
  await user.type(screen.getByLabelText("修改后的语言级别"), "C1");
  await user.type(screen.getByLabelText("修改原因"), "考试成绩更新");
  await user.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`/api/profile/facts/${factId}/revisions`, expect.objectContaining({
    body: JSON.stringify({ expectedVersion: 1, factValue: { name: "英语", level: "C1" }, reason: "考试成绩更新" }),
  })));
});

it("corrects a language candidate without dropping its level", async () => {
  const languageDetail = {
    ...completedDetail,
    facts: [{
      ...completedDetail.facts[0], factId: "a31aa3a3-9cfd-46b0-b63d-d06e6f467230", factType: "language" as const,
      factValue: { name: "英语", level: "B2" }, evidence: { ...completedDetail.facts[0]!.evidence, excerpt: "- 英语：B2" },
    }],
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(languageDetail))
    .mockResolvedValueOnce(Response.json({
      profileId: "fa7753f2-2ff3-4bd6-9fbd-6b4ae41d8364", version: 1, facts: [{
        factId: "680d3e96-5402-4d28-86aa-087cc4e088a5", revisionId: "8cc49f65-05f6-4472-b962-53de26c9a584",
        factType: "language", factValue: { name: "英语", level: "C1" }, source: "user_confirmed", candidateFactId: languageDetail.facts[0]!.factId,
        createdAt: "2026-08-27T08:00:03.000Z",
      }],
    }));
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[completedImport]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);

  await user.click(await screen.findByRole("button", { name: "纠正 英语 · B2" }));
  await user.type(screen.getByLabelText("纠正后的内容"), "英语");
  expect(screen.getByLabelText("纠正后的语言级别")).toHaveValue("B2");
  await user.clear(screen.getByLabelText("纠正后的语言级别"));
  await user.type(screen.getByLabelText("纠正后的语言级别"), "C1");
  await user.type(screen.getByLabelText("纠正原因"), "考试成绩更新");
  await user.click(screen.getByRole("button", { name: "保存纠正" }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/profile/candidate-facts/${languageDetail.facts[0]!.factId}/decisions`,
    expect.objectContaining({ body: JSON.stringify({ expectedVersion: 0, decision: "corrected", factValue: { name: "英语", level: "C1" }, reason: "考试成绩更新" }) }),
  ));
});

it("maps failures to a fixed Chinese message without exposing internal values", async () => {
  mocks.createCareerImportAction.mockResolvedValue({ ok: false, code: "NO_SUPPORTED_FACTS", message: "职业资料暂时无法处理，请稍后重试。" });
  const user = userEvent.setup();

  render(<ProfileImportView initialImports={[]} />);
  await user.upload(screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料"), new File(["# empty"], "career.md", { type: "text/markdown" }));
  await confirmSanitizedFile(user);
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("职业资料暂时无法处理，请稍后重试。"));
  expect(screen.queryByText("NO_SUPPORTED_FACTS")).not.toBeInTheDocument();
});

it("explains the fact-count limit and tells the candidate how to retry", () => {
  render(<ProfileImportView initialImports={[{
    ...queuedImport,
    status: "failed",
    failureCode: "CAREER_IMPORT_FACT_LIMIT_EXCEEDED" as never,
  }]} />);

  expect(screen.getByText("最多提取 500 条候选事实，请精简职业资料后重试。"))
    .toBeInTheDocument();
});

it("gives a new upload failure priority over an existing queued import", async () => {
  mocks.createCareerImportAction.mockResolvedValue({ ok: false, code: "NO_SUPPORTED_FACTS", message: "没有找到可确认的职业资料事实，请检查职业资料内容后重试。" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...queuedImport, facts: [] }));
  const user = userEvent.setup();

  render(<ProfileImportView initialImports={[queuedImport]} />);
  await user.upload(screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料"), new File(["# empty"], "career.md", { type: "text/markdown" }));
  await confirmSanitizedFile(user);
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("没有找到可确认的职业资料事实，请检查职业资料内容后重试。"));
  expect(screen.getByRole("status")).not.toHaveTextContent("等待解析");
});

it("waits one full second between serialized intermediate polling requests", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...queuedImport, facts: [] }));

  render(<ProfileImportView initialImports={[queuedImport]} />);
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("retries a polling transport failure after one second and recovers on a completed response", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("network failed"))
    .mockResolvedValueOnce(Response.json(completedDetail));

  render(<ProfileImportView initialImports={[queuedImport]} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("暂时无法读取解析状态，请稍后重试。");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("解析完成");
});

it("does not overlap a pending poll when more than one interval elapses", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));

  render(<ProfileImportView initialImports={[queuedImport]} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not schedule another request after a terminal response", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(completedDetail));

  render(<ProfileImportView initialImports={[queuedImport]} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("解析完成");
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("aborts a pending request when the view unmounts", async () => {
  const abortSpy = vi.spyOn(AbortController.prototype, "abort");
  let resolveFetch: ((response: Response) => void) | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));

  const rendered = render(<ProfileImportView initialImports={[queuedImport]} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal;
  expect(signal?.aborted).toBe(false);
  rendered.unmount();
  expect(abortSpy).toHaveBeenCalled();
  expect(signal?.aborted).toBe(true);
  resolveFetch?.(Response.json(completedDetail));
});

it("shows uploading while retrying after an action failure", async () => {
  let resolveRetry: ((value: { ok: true; import: typeof queuedImport & { reused: boolean; detailUrl: string } }) => void) | undefined;
  mocks.createCareerImportAction
    .mockResolvedValueOnce({ ok: false, code: "CAREER_DOCUMENT_EMPTY", message: "职业资料不能为空。" })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
  const user = userEvent.setup();

  render(<ProfileImportView initialImports={[]} />);
  await user.upload(screen.getByLabelText("选择 Markdown、DOCX 或 PDF 职业资料"), new File(["# retry"], "career.md", { type: "text/markdown" }));
  await confirmSanitizedFile(user);
  await user.click(screen.getByRole("button", { name: "上传并解析" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("职业资料不能为空。"));

  await user.click(screen.getByRole("button", { name: "上传并解析" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("上传中"));
  resolveRetry?.({ ok: true, import: { ...queuedImport, reused: false, detailUrl: `/v1/career-documents/imports/${importId}` } });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("等待解析"));
});

it("restarts the same import ID from failed through queued polling to completed facts", async () => {
  let resolveOldFetch: ((response: Response) => void) | undefined;
  mocks.createCareerImportAction.mockResolvedValue({ ok: true, import: { ...queuedImport, reused: true, detailUrl: `/v1/career-documents/imports/${importId}` } });
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOldFetch = resolve; }))
    .mockResolvedValueOnce(Response.json({ ...queuedImport, facts: [] }))
    .mockResolvedValueOnce(Response.json(completedDetail));

  render(<ProfileImportView initialImports={[{ ...queuedImport, status: "failed" }]} />);
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await prepareFile();
  vi.useFakeTimers();
  submitPreparedFile();
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(screen.getByText("TypeScript")).toBeInTheDocument();
  resolveOldFetch?.(Response.json(completedDetail));
});

it("ignores a late old-generation terminal response while the new import retries", async () => {
  let resolveOldFetch: ((response: Response) => void) | undefined;
  let resolveAction: ((value: { ok: true; import: typeof queuedImport & { reused: boolean; detailUrl: string } }) => void) | undefined;
  let rejectNewFetch: ((reason?: unknown) => void) | undefined;
  mocks.createCareerImportAction.mockImplementation(() => new Promise((resolve) => { resolveAction = resolve; }));
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOldFetch = resolve; }))
    .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectNewFetch = reject; }))
    .mockResolvedValueOnce(Response.json(replacementDetail));

  render(<ProfileImportView initialImports={[queuedImport]} />);
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await prepareFile();
  vi.useFakeTimers();
  submitPreparedFile();
  resolveAction?.({
    ok: true,
    import: { ...queuedImport, importId: replacementImportId, documentId: replacementDetail.documentId, sourceFilename: "replacement.md", reused: false, detailUrl: `/v1/career-documents/imports/${replacementImportId}` },
  });
  resolveOldFetch?.(Response.json(completedDetail));
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("TypeScript")).not.toBeInTheDocument();
  rejectNewFetch?.(new TypeError("transient"));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole("status")).toHaveTextContent("暂时无法读取解析状态，请稍后重试。");
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(screen.getByText("React")).toBeInTheDocument();
});

it("refetches completed facts after a repeated completed upload with the same import ID", async () => {
  mocks.createCareerImportAction.mockResolvedValue({ ok: true, import: { ...queuedImport, status: "completed", reused: true, detailUrl: `/v1/career-documents/imports/${importId}` } });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json(completedDetail)));

  render(<ProfileImportView initialImports={[queuedImport]} />);
  await waitFor(() => expect(screen.getByText("TypeScript")).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await submitFile();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByText("TypeScript")).toBeInTheDocument());
});

it.each([
  ["采用已有", "use_existing"],
  ["采用新导入", "use_incoming"],
  ["两者都有效", "keep_both"],
] as const)("展示双方 DOCX/Markdown 证据，并以当前版本提交%s", async (label, resolution) => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(conflictDetail))
    .mockResolvedValueOnce(Response.json({
      profile: { profileId: null, version: 1, facts: [] },
      conflict: { conflictId, kind: "date", status: "resolved", resolution, profileVersion: 1, resolvedAt: "2026-08-27T08:00:03.000Z" },
    }));
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[completedImport]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);

  expect(await screen.findByRole("heading", { name: "职业事实冲突" })).toBeInTheDocument();
  const conflictArticle = screen.getByText("日期不一致 · 待处理").closest("article")!;
  expect(conflictArticle).toHaveTextContent("第 4-4 行");
  expect(conflictArticle).toHaveTextContent("第 2-3 段");
  expect(conflictArticle).toHaveTextContent("- AI 工程师｜示例科技｜2023");
  expect(conflictArticle).toHaveTextContent("AI 工程师｜示例科技｜2024");
  await user.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/profile/fact-conflicts/${conflictId}/resolutions`,
    expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedVersion: 0, resolution }) }),
  ));
  expect(await screen.findByText("日期不一致 · 已解决")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
  expect(screen.getByText("版本 1")).toBeInTheDocument();
});

it("冲突解决返回 409 时保持待处理并提示刷新", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(conflictDetail))
    .mockResolvedValueOnce(new Response(null, { status: 409 }));
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[completedImport]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);
  await user.click(await screen.findByRole("button", { name: "采用已有" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(screen.getByText("画像已在其他位置更新，请刷新后重试。")).toBeInTheDocument();
  expect(screen.getByText("日期不一致 · 待处理")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "采用已有" })).toBeInTheDocument();
});

it("待处理职业事实冲突会隐藏双方候选事实的单独审核动作", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    ...conflictDetail,
    facts: [conflictDetail.conflicts[0].existingFact, conflictDetail.conflicts[0].incomingFact],
  }));
  render(<ProfileImportView initialImports={[completedImport]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);
  await screen.findByRole("heading", { name: "职业事实冲突" });
  expect(screen.queryByRole("button", { name: /确认 AI 工程师/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /纠正 AI 工程师/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /拒绝 AI 工程师/ })).not.toBeInTheDocument();
});

it("旧导入详情也能解决关联冲突，且解决后仍不显示单事实审核动作", async () => {
  const oldImportDetail = {
    ...conflictDetail,
    importId: completedImport.importId,
    documentId,
    sourceFilename: "career-one.docx",
    sourceFormat: "docx" as const,
    facts: [conflictDetail.conflicts[0].existingFact],
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(oldImportDetail))
    .mockResolvedValueOnce(Response.json({
      profile: { profileId: "bde72a59-a440-4fb0-9dbd-535c8e2df1f2", version: 1, facts: [{ factId: "d4f34e3c-e720-48e2-8c91-7711e12d6266", revisionId: "ab9e32e0-6f5d-4ace-906e-54e6a55cb560", factType: "experience", factValue: { summary: "AI 工程师｜示例科技｜2023" }, source: "candidate_fact", candidateFactId: conflictDetail.conflicts[0].existingFact.factId, createdAt: "2026-08-27T08:00:03.000Z" }] },
      conflict: { conflictId, kind: "date", status: "resolved", resolution: "use_existing", profileVersion: 1, resolvedAt: "2026-08-27T08:00:03.000Z" },
    }));
  const user = userEvent.setup();
  render(<ProfileImportView initialImports={[completedImport]} initialProfile={{ profileId: null, version: 0, facts: [] }} />);

  await screen.findByRole("heading", { name: "职业事实冲突" });
  expect(screen.getByText(/已有（career.md）/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /确认 AI 工程师/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "采用已有" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/profile/fact-conflicts/${conflictId}/resolutions`,
    expect.objectContaining({ body: JSON.stringify({ expectedVersion: 0, resolution: "use_existing" }) }),
  ));
  expect(await screen.findByText("日期不一致 · 已解决")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /确认 AI 工程师/ })).not.toBeInTheDocument();
});
