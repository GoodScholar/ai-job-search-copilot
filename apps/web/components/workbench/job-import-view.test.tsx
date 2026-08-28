import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createJobImportAction: vi.fn() }));
vi.mock("@/app/(workbench)/jobs/import/actions", () => ({ createJobImportAction: mocks.createJobImportAction }));

import { JobImportView } from "./job-import-view";

const importId = "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
const imported = { importId, inputType: "pasted_text" as const, originalFilename: null, status: "imported" as const, failureCode: null, createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:00:00.000Z" };
const completed = { ...imported, status: "completed" as const, opportunity: { opportunityId: "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", company: "好学科技", title: "前端工程师", location: null, postedAt: null, deadline: null, description: "负责 Web 体验", evidence: { sourcePostingId: "f4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", sourcePostingVersionId: "e4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", version: 1, sourceType: "user_import" as const, retrievedAt: "2026-08-28T08:00:00.000Z", originalFilename: null } } };

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("提供粘贴和 Markdown 上传入口、未知字段与可访问状态", async () => {
  const user = userEvent.setup();
  render(<JobImportView initialImports={[]} />);
  expect(screen.getByRole("textbox", { name: "岗位描述" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "上传 Markdown" }));
  expect(screen.getByLabelText("上传 Markdown 岗位文件")).toHaveAttribute("accept", ".md,text/markdown");
  expect(screen.getAllByText("未知", { selector: "dd" })[0]).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(/已导入|规范化中|导入完成|导入失败/);
});

it("将复用通知告知用户，并以 literal pre 展示不可信 Markdown", async () => {
  const user = userEvent.setup();
  mocks.createJobImportAction.mockResolvedValue({ ok: true, import: { ...imported, reused: true } });
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response("<img src=x onerror=alert(1)>\n# 不执行", { headers: { "content-type": "text/plain" } }));
  render(<JobImportView initialImports={[]} />);

  await user.type(screen.getByRole("textbox", { name: "岗位描述" }), "岗位正文");
  await user.click(screen.getByRole("button", { name: "导入岗位" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已复用已有岗位导入记录。"));
  const evidence = await screen.findByText((_, element) => element?.tagName === "PRE" && element.textContent?.includes("<img src=x onerror=alert(1)>") === true);
  expect(evidence).toBeInTheDocument();
  expect(evidence.closest("pre")).not.toBeNull();
  expect(document.querySelector("img")).toBeNull();
});

it("对非终态导入轮询，并在终态后停止", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ ...imported, status: "normalizing", opportunity: null }))
    .mockResolvedValueOnce(Response.json(completed));
  render(<JobImportView initialImports={[imported]} />);

  await act(async () => { await Promise.resolve(); });
  expect(fetchMock.mock.calls.filter(([url]) => url === `/api/job-imports/${importId}`)).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(fetchMock.mock.calls.filter(([url]) => url === `/api/job-imports/${importId}`)).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(fetchMock.mock.calls.filter(([url]) => url === `/api/job-imports/${importId}`)).toHaveLength(2);
  expect(screen.getByRole("status")).toHaveTextContent("导入完成");
});

it("用简短中文提示轮询和提交失败", async () => {
  mocks.createJobImportAction.mockResolvedValue({ ok: false, code: "JOB_IMPORT_UNAVAILABLE", message: "岗位导入暂时不可用，请稍后重试。" });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network failure"));
  const user = userEvent.setup();
  render(<JobImportView initialImports={[imported]} />);

  await user.type(screen.getByRole("textbox", { name: "岗位描述" }), "岗位正文");
  await user.click(screen.getByRole("button", { name: "导入岗位" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("岗位导入暂时不可用，请稍后重试。"));
  expect(screen.getByText("暂时无法读取导入状态，请稍后重试。")).toBeInTheDocument();
});
