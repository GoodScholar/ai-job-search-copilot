import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JobExportPanel } from "./job-export-panel";

const snapshot = { id: "00000000-0000-4000-8000-000000000056", filter: "active" as const, fieldVersion: 1 as const, status: "ready" as const, rowCount: 3, createdAt: "2026-09-19T10:00:00.000Z", expiresAt: "2099-09-20T10:00:00.000Z", failureCode: null };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("按当前筛选导出全部匹配岗位，并可包含已归档岗位", async () => {
  const fetcher = vi.fn().mockResolvedValue(response(snapshot));
  vi.stubGlobal("fetch", fetcher);
  render(<JobExportPanel filter="active" initialExports={[]} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "包含已归档岗位" }));
  fireEvent.click(screen.getByRole("button", { name: "生成 CSV 快照" }));
  await screen.findByRole("button", { name: "下载 CSV" });
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({ filter: "all", fieldVersion: 1 });
  expect(screen.getByText(/3 个岗位/)).toBeVisible();
});

it("请求失败保留原始幂等键和筛选，即使当前筛选已经变化", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(response(snapshot));
  vi.stubGlobal("fetch", fetcher);
  const view = render(<JobExportPanel filter="active" initialExports={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "生成 CSV 快照" }));
  await screen.findByRole("button", { name: "重试上次导出请求" });
  view.rerender(<JobExportPanel filter="archived" initialExports={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "重试上次导出请求" }));
  await screen.findByRole("button", { name: "下载 CSV" });
  expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
});

it("展示稳定失败原因、建议动作和过期状态，不允许下载过期快照", async () => {
  render(<JobExportPanel filter="archived" initialExports={[
    { ...snapshot, status: "failed", failureCode: "JOB_EXPORT_GENERATION_FAILED" },
    { ...snapshot, id: "00000000-0000-4000-8000-000000000057", status: "expired" },
  ]} />);
  expect(screen.getByText(/文件生成失败/)).toBeVisible();
  expect(screen.getByText("文件生成失败，请使用上方按钮重新生成快照。")).toBeVisible();
  expect(screen.getByText(/已过期/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "下载 CSV" })).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "包含已归档岗位" })).toBeChecked();
});

it("下载时服务端返回过期后更新可见状态并移除下载动作", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 410 })));
  render(<JobExportPanel filter="active" initialExports={[snapshot]} />);
  fireEvent.click(screen.getByRole("button", { name: "下载 CSV" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "下载 CSV" })).not.toBeInTheDocument());
  expect(screen.getByText(/快照已过期，请重新生成/)).toBeVisible();
});

it("后台完成后自动更新下载动作，刷新无需重新创建快照", async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ items: [snapshot] }));
  vi.stubGlobal("fetch", fetcher);
  render(<JobExportPanel filter="active" initialExports={[{ ...snapshot, status: "generating" }]} />);
  expect(screen.getByText(/生成中，可离开页面/)).toBeVisible();
  expect(await screen.findByRole("button", { name: "下载 CSV" }, { timeout: 4_500 })).toBeVisible();
  expect(fetcher).toHaveBeenCalledWith("/api/job-exports", expect.objectContaining({ cache: "no-store" }));
});

it("较早开始的刷新不能覆盖刚刚创建的快照", async () => {
  let resolveRefresh!: (value: Response) => void;
  const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>((resolve) => { resolveRefresh = resolve; })).mockResolvedValueOnce(response(snapshot));
  vi.stubGlobal("fetch", fetcher);
  render(<JobExportPanel filter="active" initialExports={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "刷新导出状态" }));
  fireEvent.click(screen.getByRole("button", { name: "生成 CSV 快照" }));
  await screen.findByRole("button", { name: "下载 CSV" });
  await act(async () => { resolveRefresh(response({ items: [] })); });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "下载 CSV" })).toBeVisible();
});
