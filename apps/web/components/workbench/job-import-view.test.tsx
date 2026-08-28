import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createJobImportAction: vi.fn() }));
vi.mock("@/app/(workbench)/jobs/import/actions", () => ({ createJobImportAction: mocks.createJobImportAction }));

import { JobImportView } from "./job-import-view";

const importId = "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
const failedImportId = "c0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
const imported = { importId, inputType: "pasted_text" as const, originalFilename: null, status: "imported" as const, failureCode: null, createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:00:00.000Z" };
const completed = { ...imported, status: "completed" as const, opportunity: { opportunityId: "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", company: "好学科技", title: "前端工程师", location: null, postedAt: null, deadline: null, description: "负责 Web 体验", evidence: { sourcePostingId: "f4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", sourcePostingVersionId: "e4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", version: 1, sourceType: "user_import" as const, retrievedAt: "2026-08-28T08:00:00.000Z", originalFilename: null } } };
const failed = { ...imported, importId: failedImportId, originalFilename: "failed.md", status: "failed" as const, failureCode: "JOB_IMPORT_PERSIST_FAILED" as const, opportunity: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => { resolve = next; }), resolve };
}

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("提供粘贴和 Markdown 上传入口、未知字段与可访问状态", async () => {
  const user = userEvent.setup();
  render(<JobImportView initialImports={[]} />);
  expect(screen.getByRole("textbox", { name: "岗位描述" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "上传 Markdown" }));
  expect(screen.getByLabelText("上传 Markdown 岗位文件")).toHaveAttribute("accept", ".md,text/markdown");
  expect(screen.getAllByText("未知", { selector: "dd" })[0]).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("尚未导入岗位。");
});

it("按导入类型显示来源标签", async () => {
  const urlImport = { ...imported, importId: "a0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", inputType: "url" as const };
  const uploadImport = { ...imported, importId: "c0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", inputType: "markdown_upload" as const, originalFilename: "frontend.md" };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...completed, inputType: "url" }));
  render(<JobImportView initialImports={[urlImport, uploadImport, imported]} />);

  expect(screen.getByRole("button", { name: /岗位链接/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /frontend\.md/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /粘贴的岗位描述/ })).toBeInTheDocument();
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
  await waitFor(() => expect(screen.getByText("已复用已有岗位导入记录。")).toBeInTheDocument());
  expect(screen.getByRole("status")).toHaveTextContent("导入完成");
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

it("初始选择 API 返回的最新导入，并在刷新当前记录时重新读取详情", async () => {
  const user = userEvent.setup();
  const newest = { ...completed, importId: "d0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", originalFilename: "newest.md", createdAt: "2026-08-29T08:00:00.000Z" };
  const older = { ...completed, importId: "e0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", originalFilename: "older.md", createdAt: "2026-08-28T08:00:00.000Z" };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(newest))
    .mockResolvedValueOnce(new Response("最新原文", { headers: { "content-type": "text/plain" } }))
    .mockResolvedValueOnce(Response.json(newest))
    .mockResolvedValueOnce(new Response("刷新后的最新原文", { headers: { "content-type": "text/plain" } }));
  render(<JobImportView initialImports={[newest, older]} />);

  expect(screen.getAllByRole("button", { name: /\.md/ })[0]).toHaveAccessibleName(/newest\.md/);
  await screen.findByText("最新原文");
  await user.click(screen.getByRole("button", { name: /newest\.md/ }));
  await screen.findByText("刷新后的最新原文");
  expect(fetchMock.mock.calls.filter(([url]) => url === `/api/job-imports/${newest.importId}`)).toHaveLength(2);
});

it("展示已知发布时间，并单独标记未知截止日期", async () => {
  const dated = { ...completed, opportunity: { ...completed.opportunity, postedAt: "2026-08-01T00:00:00.000Z", deadline: null } };
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(dated))
    .mockResolvedValueOnce(new Response("原文", { headers: { "content-type": "text/plain" } }));
  render(<JobImportView initialImports={[dated]} />);

  const posted = await screen.findByText("发布时间");
  expect(posted.parentElement).toHaveTextContent("2026");
  const deadline = screen.getByText("截止日期");
  expect(deadline.parentElement).toHaveTextContent("未知");
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

it("再次点击当前终态记录时显式重新读取详情和原始证据", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response("第一次原文", { headers: { "content-type": "text/plain" } }))
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response("第二次原文", { headers: { "content-type": "text/plain" } }));
  render(<JobImportView initialImports={[completed]} />);

  await screen.findByText("第一次原文");
  await user.click(screen.getByRole("button", { name: /粘贴的岗位描述/ }));
  await screen.findByText("第二次原文");
  expect(fetchMock.mock.calls.filter(([url]) => url === `/api/job-imports/${importId}`)).toHaveLength(2);
});

it("同一记录重读时保留先完成的原始证据，直到延迟详情返回", async () => {
  const user = userEvent.setup();
  const refreshedDetail = deferred<Response>();
  const refreshedRaw = deferred<Response>();
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response("初始原文", { headers: { "content-type": "text/plain" } }))
    .mockImplementationOnce(() => refreshedDetail.promise)
    .mockImplementationOnce(() => refreshedRaw.promise);
  render(<JobImportView initialImports={[completed]} />);

  await screen.findByText("初始原文");
  await user.click(screen.getByRole("button", { name: /粘贴的岗位描述/ }));
  await act(async () => { refreshedRaw.resolve(new Response("先完成的新原文", { headers: { "content-type": "text/plain" } })); });
  expect(await screen.findByText("先完成的新原文")).toBeInTheDocument();
  await act(async () => { refreshedDetail.resolve(Response.json(completed)); });
  await waitFor(() => expect(screen.getByText("先完成的新原文")).toBeInTheDocument());
});

it("同一记录重读时保留先完成的原始证据读取失败", async () => {
  const user = userEvent.setup();
  const refreshedDetail = deferred<Response>();
  const refreshedRaw = deferred<Response>();
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response("初始原文", { headers: { "content-type": "text/plain" } }))
    .mockImplementationOnce(() => refreshedDetail.promise)
    .mockImplementationOnce(() => refreshedRaw.promise);
  render(<JobImportView initialImports={[completed]} />);

  await screen.findByText("初始原文");
  await user.click(screen.getByRole("button", { name: /粘贴的岗位描述/ }));
  await act(async () => { refreshedRaw.resolve(new Response(null, { status: 503 })); });
  expect(await screen.findByText("原始证据暂时无法读取，请稍后重试。")).toBeInTheDocument();
  await act(async () => { refreshedDetail.resolve(Response.json(completed)); });
  await waitFor(() => expect(screen.getByText("原始证据暂时无法读取，请稍后重试。")).toBeInTheDocument());
});

it("raw 重试成功后忽略较旧详情的 loading 回写", async () => {
  const user = userEvent.setup();
  const oldDetail = deferred<Response>();
  const oldRaw = deferred<Response>();
  const retriedRaw = deferred<Response>();
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response("初始原文", { headers: { "content-type": "text/plain" } }))
    .mockImplementationOnce(() => oldDetail.promise)
    .mockImplementationOnce(() => oldRaw.promise)
    .mockImplementationOnce(() => retriedRaw.promise);
  render(<JobImportView initialImports={[completed]} />);

  await screen.findByText("初始原文");
  await user.click(screen.getByRole("button", { name: /粘贴的岗位描述/ }));
  await act(async () => { oldRaw.resolve(new Response(null, { status: 503 })); });
  await user.click(await screen.findByRole("button", { name: "重试读取原始证据" }));
  await act(async () => { retriedRaw.resolve(new Response("重试后的原文", { headers: { "content-type": "text/plain" } })); });
  expect(await screen.findByText("重试后的原文")).toBeInTheDocument();
  await act(async () => { oldDetail.resolve(Response.json(completed)); });
  await waitFor(() => expect(screen.getByText("重试后的原文")).toBeInTheDocument());
});

it("复用当前记录后仍显示真实的终态，且提示不会遮蔽切换后的状态", async () => {
  const user = userEvent.setup();
  mocks.createJobImportAction.mockResolvedValue({ ok: true, import: { ...imported, reused: true } });
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response("原文", { headers: { "content-type": "text/plain" } }))
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response("复用后原文", { headers: { "content-type": "text/plain" } }))
    .mockResolvedValueOnce(Response.json(failed))
    .mockResolvedValueOnce(new Response("失败原文", { headers: { "content-type": "text/plain" } }));
  render(<JobImportView initialImports={[completed, failed]} />);
  await screen.findByText("原文");

  await user.type(screen.getByRole("textbox", { name: "岗位描述" }), "重复岗位正文");
  await user.click(screen.getByRole("button", { name: "导入岗位" }));
  expect(await screen.findByText("已复用已有岗位导入记录。")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("导入完成");
  await screen.findByText("复用后原文");

  await user.click(screen.getByRole("button", { name: /failed\.md/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("导入失败"));
  expect(screen.queryByText("已复用已有岗位导入记录。")).not.toBeInTheDocument();
});

it("在非终态等待原始证据，并可重试失败的原始证据读取", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ ...imported, status: "normalizing", opportunity: null }));
  const { unmount } = render(<JobImportView initialImports={[imported]} />);
  expect(await screen.findByText("岗位完成后可以查看原始证据。")).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/raw"))).toBe(false);
  unmount();

  fetchMock.mockReset()
    .mockResolvedValueOnce(Response.json(completed))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response("重试成功原文", { headers: { "content-type": "text/plain" } }));
  render(<JobImportView initialImports={[completed]} />);
  expect(await screen.findByText("原始证据暂时无法读取，请稍后重试。")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重试读取原始证据" }));
  expect(await screen.findByText("重试成功原文")).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/raw"))).toHaveLength(2);
});

it("按 WAI-ARIA roving tabIndex 用键盘切换导入方式", async () => {
  const user = userEvent.setup();
  render(<JobImportView initialImports={[]} />);
  const pasteTab = screen.getByRole("tab", { name: "粘贴岗位描述" });
  const uploadTab = screen.getByRole("tab", { name: "上传 Markdown" });

  expect(pasteTab).toHaveAttribute("tabindex", "0");
  expect(uploadTab).toHaveAttribute("tabindex", "-1");
  pasteTab.focus();
  await user.keyboard("{ArrowRight}");
  expect(uploadTab).toHaveFocus();
  expect(uploadTab).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Home}");
  expect(pasteTab).toHaveFocus();
  expect(pasteTab).toHaveAttribute("aria-selected", "true");
});
