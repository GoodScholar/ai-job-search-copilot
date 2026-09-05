import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelDiagnosticPublicResponse } from "@job-copilot/contracts/model-diagnostics";
import { ModelConnectionView } from "./model-connection-view";

const unverified: ModelDiagnosticPublicResponse = {
  status: "unverified", checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" }, reasonCode: "MODEL_DIAGNOSTIC_CONFIGURATION_MISSING", reasonSummary: "尚未完成模型连接检查", impact: "当前无法确认模型功能是否可用。", suggestedActions: ["请运行模型连接检查。"], checkedAt: null, latencyBucket: null, retryAt: null,
};
const checking: ModelDiagnosticPublicResponse = { ...unverified, status: "checking", reasonSummary: "模型连接正在检查", suggestedActions: ["请稍后刷新。"] };
const available: ModelDiagnosticPublicResponse = { ...unverified, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", reasonSummary: "模型连接正常", impact: "模型功能可用。", suggestedActions: [], checkedAt: "2026-09-05T00:00:00.000Z", latencyBucket: "under_1s" };
const failed: ModelDiagnosticPublicResponse = { ...unverified, status: "failed", reasonCode: "MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED", reasonSummary: "模型服务认证失败", impact: "模型功能暂不可用。", suggestedActions: ["请联系部署管理员检查服务凭据。"], checkedAt: "2026-09-05T00:00:00.000Z", latencyBucket: "under_1s", retryAt: "2099-09-05T00:01:00.000Z" };
const temporarilyUnavailable: ModelDiagnosticPublicResponse = { ...unverified, status: "temporarily_unavailable", reasonCode: "MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE", reasonSummary: "模型服务暂不可用", impact: "模型功能暂时不可用。", suggestedActions: ["请稍后重试。"], checkedAt: "2026-09-05T00:00:00.000Z", latencyBucket: "5_to_10s" };

afterEach(() => vi.useRealTimers());

it.each([
  [unverified, "尚未完成模型连接检查"], [checking, "模型连接正在检查"], [available, "模型连接正常"], [failed, "模型服务认证失败"], [temporarilyUnavailable, "模型服务暂不可用"],
] as const)("用文字、标题和实时区域展示 %s 状态", (initial, title) => {
  render(<ModelConnectionView initialDiagnostics={initial} />);
  expect(screen.getByRole("heading", { name: "模型连接" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(title);
  expect(screen.getByText("身份验证")).toBeInTheDocument();
  expect(screen.getByText("模型可用性")).toBeInTheDocument();
  expect(screen.getByText("结构化输出")).toBeInTheDocument();
  expect(screen.getByText("响应时限")).toBeInTheDocument();
});

it("退避期间禁用重复检查并说明可重试时间", () => {
  render(<ModelConnectionView initialDiagnostics={failed} />);
  expect(screen.getByRole("button", { name: "检查模型连接" })).toBeDisabled();
  expect(screen.getByText(/可在.*后重试/u)).toBeInTheDocument();
});

it("检查进行中每秒读取一次且最多 25 次后明确停止", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json(checking)));
  render(<ModelConnectionView initialDiagnostics={unverified} />);

  fireEvent.click(screen.getByRole("button", { name: "检查模型连接" }));
  await act(async () => { await Promise.resolve(); });
  for (let second = 0; second < 26; second += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  }

  expect(fetchMock).toHaveBeenCalledTimes(26);
  expect(screen.getByRole("status")).toHaveTextContent("检查仍在进行，可稍后刷新");
  expect(screen.getByRole("button", { name: "检查模型连接" })).toBeEnabled();
});

it("完成检查后展示安全结果并停止轮询", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(available));
  render(<ModelConnectionView initialDiagnostics={unverified} />);
  await user.click(screen.getByRole("button", { name: "检查模型连接" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("模型连接正常"));
  expect(fetchMock).toHaveBeenCalledWith("/api/model-diagnostics", expect.objectContaining({ method: "POST" }));
});

it("卸载页面时取消进行中的检查请求", () => {
  let requestSignal: AbortSignal | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    return new Promise<Response>(() => {});
  });
  const view = render(<ModelConnectionView initialDiagnostics={unverified} />);

  fireEvent.click(screen.getByRole("button", { name: "检查模型连接" }));
  view.unmount();

  expect(requestSignal?.aborted).toBe(true);
});
