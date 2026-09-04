import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DiscoverySchedulePanel } from "./discovery-schedule-panel";

const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const ready = { schedule: null, sourceSupport: { status: "executable", supportedSourceCount: 2 } };
const enabled = { schedule: { scheduleId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", targetId, version: 3, state: "enabled" as const, dailyTime: "09:30", timeZone: "Asia/Shanghai" as const, nextRunAt: "2026-08-31T01:30:00.000Z", updatedAt: "2026-08-30T02:00:00.000Z" } };
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

it("没有计划提示时不占用工作台的状态区域", async () => {
  load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  await screen.findByText("可每日检查 2 个岗位来源");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("保存中禁用动作，并在策略冲突后显示待接入且禁止继续保存", async () => {
  let resolvePut!: (value: Response) => void;
  const fetchMock = load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  expect(await screen.findByText("可每日检查 2 个岗位来源")).toBeInTheDocument();
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolvePut = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
  resolvePut(response({ code: "SOURCE_POLICY_REQUIRED" }, 409));
  expect((await screen.findAllByText("待接入：需允许 boards-api.greenhouse.io")).length).toBeGreaterThan(0);
  await waitFor(() => expect(screen.getByRole("button", { name: "启用" })).toBeDisabled());
  await waitFor(() => expect(screen.getByRole("button", { name: "保存每日检查" })).toBeDisabled());
});

it("NO_SUPPORTED_SOURCE 冲突后显示待接入且禁止继续保存", async () => {
  const fetchMock = load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  await screen.findByText("可每日检查 2 个岗位来源");
  fetchMock.mockResolvedValueOnce(response({ code: "NO_SUPPORTED_SOURCE" }, 409));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  expect((await screen.findAllByText("待接入")).length).toBeGreaterThan(0);
  await waitFor(() => expect(screen.getByRole("button", { name: "启用" })).toBeDisabled());
  await waitFor(() => expect(screen.getByRole("button", { name: "保存每日检查" })).toBeDisabled());
});

it("TARGET_INACTIVE 冲突后显示目标停用且禁止继续保存", async () => {
  const fetchMock = load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  await screen.findByText("可每日检查 2 个岗位来源");
  fetchMock.mockResolvedValueOnce(response({ code: "JOB_DISCOVERY_SCHEDULE_TARGET_INACTIVE" }, 409));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  expect((await screen.findAllByText("该求职目标已停用，不能启用每日检查。")).length).toBeGreaterThan(0);
  await waitFor(() => expect(screen.getByRole("button", { name: "启用" })).toBeDisabled());
  await waitFor(() => expect(screen.getByRole("button", { name: "保存每日检查" })).toBeDisabled());
});

it.each([
  ["policy_required", { status: "policy_required", message: "需允许 boards-api.greenhouse.io" }],
  ["unsupported", { status: "unsupported" }],
])("已有启用计划在 %s 后仍可停用并保存", async (_status, sourceSupport) => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ ...enabled, sourceSupport }));
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  await screen.findByText(sourceSupport.status === "policy_required" ? "待接入：需允许 boards-api.greenhouse.io" : "待接入");
  expect(screen.getByRole("button", { name: "启用" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "停用" })).toBeEnabled();
  fetchMock.mockResolvedValueOnce(response({ schedule: { ...enabled.schedule, state: "disabled", nextRunAt: null }, sourceSupport }));
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`/api/job-targets/${targetId}/discovery-schedule`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ expectedVersion: 3, state: "disabled", dailyTime: "09:30" }) })));
});

it("已有启用计划在目标停用后仍可停用并保存", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ ...enabled, sourceSupport: ready.sourceSupport }));
  render(<DiscoverySchedulePanel targetId={targetId} targetState="inactive" />);
  await screen.findByText("该求职目标已停用，不能启用每日检查。");
  expect(screen.getByRole("button", { name: "启用" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "停用" })).toBeEnabled();
  fetchMock.mockResolvedValueOnce(response({ schedule: { ...enabled.schedule, state: "disabled", nextRunAt: null }, sourceSupport: ready.sourceSupport }));
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`/api/job-targets/${targetId}/discovery-schedule`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ expectedVersion: 3, state: "disabled", dailyTime: "09:30" }) })));
});

it("非时间字段的成功、网络和 CAS 消息不标记时间输入无效", async () => {
  const fetchMock = load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  await screen.findByText("可每日检查 2 个岗位来源");
  const time = screen.getByLabelText("每日检查时间（北京时间 / Asia/Shanghai）");
  const saveButton = async () => {
    const button = await screen.findByRole("button", { name: "保存每日检查" });
    await waitFor(() => expect(button).toBeEnabled());
    return button;
  };
  fetchMock.mockResolvedValueOnce(response({ schedule: { ...enabled.schedule, state: "disabled", nextRunAt: null }, sourceSupport: ready.sourceSupport }));
  fireEvent.click(await saveButton());
  await screen.findByText("每日检查已停用。");
  const afterSuccess = await saveButton();
  expect(time).toHaveAttribute("aria-invalid", "false");
  fetchMock.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(afterSuccess);
  await screen.findByText("网络暂时不可用，未保存每日检查。请稍后重试。");
  const afterNetworkFailure = await saveButton();
  expect(time).toHaveAttribute("aria-invalid", "false");
  fetchMock.mockResolvedValueOnce(response({ code: "JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT" }, 409));
  fireEvent.click(afterNetworkFailure);
  await screen.findByText("每日检查已在其他位置更新，请刷新后重试。");
  await saveButton();
  expect(time).toHaveAttribute("aria-invalid", "false");
});

it("仅时间字段校验错误标记时间输入并关联具体说明", async () => {
  const fetchMock = load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  await screen.findByText("可每日检查 2 个岗位来源");
  const time = screen.getByLabelText("每日检查时间（北京时间 / Asia/Shanghai）");
  fireEvent.change(time, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  const error = await screen.findByText("请输入有效的北京时间（HH:mm）。");
  expect(time).toHaveAttribute("aria-invalid", "true");
  expect(time).toHaveAttribute("aria-describedby", expect.stringContaining(error.id));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("CAS 冲突提示其他位置更新，但保持当前资格和操作", async () => {
  const fetchMock = load();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  await screen.findByText("可每日检查 2 个岗位来源");
  fetchMock.mockResolvedValueOnce(response({ code: "JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT" }, 409));
  fireEvent.click(screen.getByRole("button", { name: "保存每日检查" }));
  expect(await screen.findByText("每日检查已在其他位置更新，请刷新后重试。")).toBeInTheDocument();
  expect(screen.getByText("可每日检查 2 个岗位来源")).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "启用" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存每日检查" })).toBeEnabled();
  });
});

it("读取尚未完成时明确显示加载态，随后按时间、启用、停用、保存顺序获得焦点", async () => {
  let resolveGet!: (value: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise((resolve) => { resolveGet = resolve; }));
  const user = userEvent.setup();
  render(<DiscoverySchedulePanel targetId={targetId} targetState="active" />);
  expect(screen.getByText("正在读取每日检查…")).toBeInTheDocument();
  resolveGet(response(ready));
  await screen.findByText("可每日检查 2 个岗位来源");
  await user.tab(); expect(screen.getByLabelText("每日检查时间（北京时间 / Asia/Shanghai）")).toHaveFocus();
  await user.tab(); expect(screen.getByRole("button", { name: "启用" })).toHaveFocus();
  await user.tab(); expect(screen.getByRole("button", { name: "停用" })).toHaveFocus();
  await user.tab(); expect(screen.getByRole("button", { name: "保存每日检查" })).toHaveFocus();
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
  expect(screen.getByText("待接入")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
