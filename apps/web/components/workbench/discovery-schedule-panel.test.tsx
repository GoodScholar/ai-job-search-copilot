import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiscoverySchedulePanel } from "./discovery-schedule-panel";

const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const executable = { schedule: null, sourceSupport: { status: "executable", supportedSourceCount: 2 } } as const;

afterEach(() => vi.restoreAllMocks());

it("以北京时间的可键盘访问控件保存每日检查，并在请求中保留首次版本 0", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    schedule: { scheduleId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", targetId, version: 1, state: "enabled", dailyTime: "10:30", timeZone: "Asia/Shanghai", nextRunAt: "2026-08-31T02:30:00.000Z", updatedAt: "2026-08-30T02:00:00.000Z" },
    sourceSupport: executable.sourceSupport,
  })));
  render(<DiscoverySchedulePanel initialSchedule={executable} targetId={targetId} targetState="active" />);
  const time = screen.getByLabelText("每日检查时间（北京时间 / Asia/Shanghai）");
  expect(time).toHaveValue("09:30");
  fireEvent.change(time, { target: { value: "10:30" } });
  fireEvent.click(screen.getByRole("button", { name: "启用" }));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/job-targets/${targetId}/discovery-schedule`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ expectedVersion: 0, state: "enabled", dailyTime: "10:30" }) })));
  expect(await screen.findByText("每日检查已保存。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用" }).className).toContain("workbench-touch-target");
});

it("对待接入与停用目标明确禁用启用操作，不以颜色表示状态", () => {
  const { rerender } = render(<DiscoverySchedulePanel initialSchedule={{ schedule: null, sourceSupport: { status: "unsupported" } }} targetId={targetId} targetState="active" />);
  expect(screen.getByText("待接入")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用" })).toBeDisabled();
  rerender(<DiscoverySchedulePanel initialSchedule={{ schedule: null, sourceSupport: { status: "executable", supportedSourceCount: 1 } }} targetId={targetId} targetState="inactive" />);
  expect(screen.getByText("该求职目标已停用，不能启用每日检查。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "启用" })).toBeDisabled();
});

it("以明确的实时消息处理冲突与网络失败", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 409 }));
  render(<DiscoverySchedulePanel initialSchedule={executable} targetId={targetId} targetState="active" />);
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  expect(await screen.findByText("每日检查已在其他位置更新，请刷新后的版本后重试。")).toBeInTheDocument();
  fetchMock.mockRejectedValueOnce(new Error("network"));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  expect(await screen.findByText("网络暂时不可用，未保存每日检查。请稍后重试。")).toBeInTheDocument();
});
