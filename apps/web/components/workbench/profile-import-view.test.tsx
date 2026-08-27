import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createCareerImportAction: vi.fn(), createCareerImportFormAction: vi.fn() }));

vi.mock("@/app/(workbench)/profile/actions", () => ({
  createCareerImportAction: mocks.createCareerImportAction,
  createCareerImportFormAction: mocks.createCareerImportFormAction,
  initialUploadActionState: { ok: false, code: "", message: "" },
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  render(<ProfileImportView initialImport={null} />);
  const input = screen.getByLabelText("选择 Markdown 职业资料");
  expect(input).toHaveAttribute("accept", ".md,text/markdown,text/plain");
  await user.upload(input, new File(["## 技能\\n- TypeScript"], "career.md", { type: "text/markdown" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/等待解析|解析中/));
  await waitFor(() => expect(screen.getByText("解析完成")).toBeInTheDocument());
  expect(screen.getByText("待确认")).toBeInTheDocument();
  expect(screen.getByText("技能")).toBeInTheDocument();
  expect(screen.getByText("TypeScript")).toBeInTheDocument();
  expect(screen.getAllByText(/career\.md/).length).toBeGreaterThan(0);
  expect(screen.getByText(/第 6 行/)).toBeInTheDocument();
  expect(screen.getByText("- TypeScript")).toBeInTheDocument();
  expect(screen.getByText("确认、修改和拒绝将在下一阶段开放")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(`/api/career-imports/${importId}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it("maps failures to a fixed Chinese message without exposing internal values", async () => {
  mocks.createCareerImportAction.mockResolvedValue({ ok: false, code: "NO_SUPPORTED_FACTS", message: "职业资料暂时无法处理，请稍后重试。" });
  const user = userEvent.setup();

  render(<ProfileImportView initialImport={null} />);
  await user.upload(screen.getByLabelText("选择 Markdown 职业资料"), new File(["# empty"], "career.md", { type: "text/markdown" }));
  await user.click(screen.getByRole("button", { name: "上传并解析" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("职业资料暂时无法处理，请稍后重试。"));
  expect(screen.queryByText("NO_SUPPORTED_FACTS")).not.toBeInTheDocument();
});

it("stops polling on terminal status and aborts in-flight work on unmount", async () => {
  const abortSpy = vi.spyOn(AbortController.prototype, "abort");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(completedDetail));

  const rendered = render(<ProfileImportView initialImport={queuedImport} />);
  await waitFor(() => expect(screen.getByText("解析完成")).toBeInTheDocument());
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  rendered.unmount();
  expect(abortSpy).toHaveBeenCalled();
});
