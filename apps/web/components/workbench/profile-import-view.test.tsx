import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createCareerImportAction: vi.fn(), createCareerImportFormAction: vi.fn() }));

vi.mock("@/app/(workbench)/profile/actions", () => ({
  createCareerImportAction: mocks.createCareerImportAction,
  createCareerImportFormAction: mocks.createCareerImportFormAction,
}));

import { ProfileImportView } from "./profile-import-view";

const importId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const documentId = "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";
const queuedImport = {
  importId, documentId, sourceFilename: "career.md", status: "queued" as const, failureCode: null,
  createdAt: "2026-08-27T08:00:00.000Z", updatedAt: "2026-08-27T08:00:00.000Z", candidateFactCount: 0,
};
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

function submitFile() {
  fireEvent.change(screen.getByLabelText("选择 Markdown 职业资料"), {
    target: { files: [new File(["# 资料"], "career.md", { type: "text/markdown" })] },
  });
  fireEvent.submit(screen.getByRole("button", { name: "上传并解析" }).closest("form")!);
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.createCareerImportAction.mockReset();
  mocks.createCareerImportFormAction.mockReset();
  vi.useRealTimers();
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

it("deduplicates an uploaded reused import and moves it to the top of recent imports", async () => {
  mocks.createCareerImportAction.mockResolvedValue({
    ok: true,
    import: { ...completedImport, reused: true, detailUrl: `/v1/career-documents/imports/${completedImport.importId}` },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...completedDetail, importId: completedImport.importId, facts: [] }));

  render(<ProfileImportView initialImports={[queuedImport, completedImport]} />);
  submitFile();

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
  const input = screen.getByLabelText("选择 Markdown 职业资料");
  expect(input).toHaveAttribute("accept", ".md,text/markdown,text/plain");
  await user.upload(input, new File(["## 技能\\n- TypeScript"], "career.md", { type: "text/markdown" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/等待解析|解析中/));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("解析完成"), { timeout: 2_000 });
  expect(screen.getByText("待确认")).toBeInTheDocument();
  expect(screen.getByText("技能")).toBeInTheDocument();
  expect(screen.getByText("TypeScript")).toBeInTheDocument();
  expect(screen.getAllByText(/career\.md/).length).toBeGreaterThan(0);
  expect(screen.getByText("第 6 行", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("- TypeScript")).toBeInTheDocument();
  expect(screen.getByText("确认、修改和拒绝将在下一阶段开放")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(`/api/career-imports/${importId}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it("maps failures to a fixed Chinese message without exposing internal values", async () => {
  mocks.createCareerImportAction.mockResolvedValue({ ok: false, code: "NO_SUPPORTED_FACTS", message: "职业资料暂时无法处理，请稍后重试。" });
  const user = userEvent.setup();

  render(<ProfileImportView initialImports={[]} />);
  await user.upload(screen.getByLabelText("选择 Markdown 职业资料"), new File(["# empty"], "career.md", { type: "text/markdown" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("职业资料暂时无法处理，请稍后重试。"));
  expect(screen.queryByText("NO_SUPPORTED_FACTS")).not.toBeInTheDocument();
});

it("gives a new upload failure priority over an existing queued import", async () => {
  mocks.createCareerImportAction.mockResolvedValue({ ok: false, code: "NO_SUPPORTED_FACTS", message: "没有找到可确认的职业资料事实，请检查 Markdown 内容后重试。" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...queuedImport, facts: [] }));
  const user = userEvent.setup();

  render(<ProfileImportView initialImports={[queuedImport]} />);
  await user.upload(screen.getByLabelText("选择 Markdown 职业资料"), new File(["# empty"], "career.md", { type: "text/markdown" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("没有找到可确认的职业资料事实，请检查 Markdown 内容后重试。"));
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

it("replaces an initial query failure after a successful new upload", async () => {
  mocks.createCareerImportAction
    .mockResolvedValueOnce({ ok: true, import: { ...queuedImport, reused: false, detailUrl: `/v1/career-documents/imports/${importId}` } });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(completedDetail));
  const user = userEvent.setup();

  render(<ProfileImportView initialErrorMessage="Markdown 文件不能为空。" initialImports={[]} />);
  expect(screen.getByRole("status")).toHaveTextContent("Markdown 文件不能为空。");
  await user.upload(screen.getByLabelText("选择 Markdown 职业资料"), new File(["# retry"], "career.md", { type: "text/markdown" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("解析完成"));
  expect(screen.getByRole("status")).not.toHaveTextContent("Markdown 文件不能为空。");
});

it("shows uploading while retrying after an action failure", async () => {
  let resolveRetry: ((value: { ok: true; import: typeof queuedImport & { reused: boolean; detailUrl: string } }) => void) | undefined;
  mocks.createCareerImportAction
    .mockResolvedValueOnce({ ok: false, code: "CAREER_DOCUMENT_EMPTY", message: "Markdown 文件不能为空。" })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
  const user = userEvent.setup();

  render(<ProfileImportView initialImports={[]} />);
  await user.upload(screen.getByLabelText("选择 Markdown 职业资料"), new File(["# retry"], "career.md", { type: "text/markdown" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Markdown 文件不能为空。"));

  await user.click(screen.getByRole("button", { name: "上传并解析" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("上传中"));
  resolveRetry?.({ ok: true, import: { ...queuedImport, reused: false, detailUrl: `/v1/career-documents/imports/${importId}` } });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("等待解析"));
});

it("restarts the same import ID from failed through queued polling to completed facts", async () => {
  vi.useFakeTimers();
  let resolveOldFetch: ((response: Response) => void) | undefined;
  mocks.createCareerImportAction.mockResolvedValue({ ok: true, import: { ...queuedImport, reused: true, detailUrl: `/v1/career-documents/imports/${importId}` } });
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOldFetch = resolve; }))
    .mockResolvedValueOnce(Response.json({ ...queuedImport, facts: [] }))
    .mockResolvedValueOnce(Response.json(completedDetail));

  render(<ProfileImportView initialImports={[{ ...queuedImport, status: "failed" }]} />);
  await act(async () => { await Promise.resolve(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  submitFile();
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
  vi.useFakeTimers();
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

  submitFile();
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

  submitFile();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(screen.getByText("TypeScript")).toBeInTheDocument();
});
