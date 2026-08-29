import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiscoverySchedulePanel } from "./discovery-schedule-panel";

const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const ready = { schedule: null, sourceSupport: { status: "executable", supportedSourceCount: 2 } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const load = () => vi.spyOn(globalThis, "fetch").mockResolvedValue(response(ready));
afterEach(() => vi.restoreAllMocks());

it("只读取当前目标的计划，并以北京时间保存首次 version 0", async () => {
  const fetchMock = load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  await screen.findByText("可每日检查 2 个岗位来源");
  fireEvent.change(screen.getByLabelText("每日检查时间（北京时间 / Asia/Shanghai）"), { target: { value: "10:30" } });
  fetchMock.mockResolvedValueOnce(response({ schedule: { scheduleId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", targetId, version: 1, state: "enabled", dailyTime: "10:30", timeZone: "Asia/Shanghai", nextRunAt: null, updatedAt: "2026-08-30T02:00:00.000Z" }, sourceSupport: ready.sourceSupport }));
  fireEvent.click(screen.getByRole("button", { name: "启用" }));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`/api/job-targets/${targetId}/discovery-schedule`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ expectedVersion: 0, state: "enabled", dailyTime: "10:30" }) })));
});

it("显示加载态，精确处理策略、停用与待接入错误，且保存中禁用动作", async () => {
  let resolvePut!: (value: Response) => void;
  const fetchMock = load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  expect(await screen.findByText("可每日检查 2 个岗位来源")).toBeInTheDocument();
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePut = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
  resolvePut(response({ code: "SOURCE_POLICY_REQUIRED" }, 409));
  expect((await screen.findAllByText("待接入：需允许 boards-api.greenhouse.io")).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "启用" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存每日检查" })).toBeDisabled();
});

it("目标切换时取消旧请求，迟到的 A 不覆盖 B", async () => {
  let resolveA!: (value: Response) => void;
  const targetB = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; })).mockResolvedValueOnce(response({ schedule: null, sourceSupport: { status: "unsupported" } }));
  const view = render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  view.rerender(<DiscoverySchedulePanel targetId={targetB} targetState="active" />);
  expect(await screen.findByText("待接入")).toBeInTheDocument();
  resolveA(response(ready));
  await Promise.resolve();
  expect(screen.queryByText("可每日检查 2 个岗位来源")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
