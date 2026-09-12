import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountRunControlState, AccountRunPolicyResponse } from "@job-copilot/contracts/account-run-policies";
import { AccountRunPolicyView } from "./account-run-policy-view";

const publicDiscoveryBudget = {
  maxActiveDurationMs: 180_000,
  maxAttempts: 3,
  maxToolCalls: 60,
  maxResults: 5,
  maxModelCalls: 0,
  maxTokens: 0,
};

const deepMatchBudget = {
  maxActiveDurationMs: 180_000,
  maxAttempts: 3,
  maxToolCalls: 0,
  maxResults: 10,
  maxModelCalls: 10,
  maxTokens: 20_000,
};

const fakeBudget = {
  maxActiveDurationMs: 60_000,
  maxAttempts: 3,
  maxToolCalls: 10,
  maxResults: 5,
  maxModelCalls: 0,
  maxTokens: 0,
};

const initialPolicy: AccountRunPolicyResponse = {
  revision: {
    revisionNumber: 4,
    isSystemBaseline: false,
    createdAt: "2026-09-05T01:00:00.000Z",
    settings: {
      discovery: { trustedSourceLimit: 20, publicQueryLimit: 3, verificationCandidateLimit: 6, enabledProviders: ["anysearch"] },
      budgets: { publicDiscovery: publicDiscoveryBudget, deepMatch: deepMatchBudget, fake: fakeBudget },
      backgroundWindow: { start: "08:00", end: "22:00", timeZone: "Asia/Shanghai" },
    },
  },
  system: {
    defaults: {
      discovery: { trustedSourceLimit: 50, publicQueryLimit: 5, verificationCandidateLimit: 10, enabledProviders: ["anysearch"] },
      budgets: { publicDiscovery: publicDiscoveryBudget, deepMatch: deepMatchBudget, fake: fakeBudget },
      backgroundWindow: { start: "08:00", end: "22:00", timeZone: "Asia/Shanghai" },
    },
    hardLimits: {
      discovery: { trustedSourceLimit: 50, publicQueryLimit: 10, verificationCandidateLimit: 10, enabledProviders: ["anysearch"] },
      budgets: { publicDiscovery: publicDiscoveryBudget, deepMatch: deepMatchBudget, fake: fakeBudget },
      backgroundWindow: { timeZone: "Asia/Shanghai", allowsAllDay: true },
    },
  },
  userSettings: {
    discovery: { trustedSourceLimit: 20, publicQueryLimit: 3, verificationCandidateLimit: 6, enabledProviders: ["anysearch"] },
    budgets: { publicDiscovery: publicDiscoveryBudget, deepMatch: deepMatchBudget, fake: fakeBudget },
    backgroundWindow: { start: "08:00", end: "22:00", timeZone: "Asia/Shanghai" },
  },
  effective: {
    discovery: { trustedSourceLimit: 20, publicQueryLimit: 3, verificationCandidateLimit: 6, enabledProviders: ["anysearch"] },
    budgets: { publicDiscovery: publicDiscoveryBudget, deepMatch: deepMatchBudget, fake: fakeBudget },
    backgroundWindow: { start: "08:00", end: "22:00", timeZone: "Asia/Shanghai" },
  },
};

const activeControl: AccountRunControlState = { stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null };

afterEach(() => vi.restoreAllMocks());

it("停止全部运行后重新读取权威状态，并说明安全检查点与在途费用", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ applied: true, state: { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null } }))
    .mockResolvedValueOnce(Response.json({ stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null }));

  render(<AccountRunPolicyView initialControl={activeControl} initialPolicy={initialPolicy} />);
  const button = screen.getByRole("button", { name: "停止全部运行" });
  expect(button).toBeEnabled();
  await user.click(button);

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/account/run-policy/controls", expect.objectContaining({ method: "POST" })));
  expect(await screen.findByRole("button", { name: "解除全局停止" })).toBeEnabled();
  expect(screen.getByText(/已停止新动作，正在运行的任务将在安全检查点暂停。已发出的请求可能仍产生费用/u)).toBeInTheDocument();
});

it("解除后说明旧运行需逐个继续且错过的计划不会补跑", async () => {
  const user = userEvent.setup();
  const stopped: AccountRunControlState = { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null };
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ applied: true, state: { stoppedAt: null, controlVersion: 2, scheduleResumeAfter: "2026-09-12T00:01:00.000Z" } }))
    .mockResolvedValueOnce(Response.json({ stoppedAt: null, controlVersion: 2, scheduleResumeAfter: "2026-09-12T00:01:00.000Z" }));

  render(<AccountRunPolicyView initialControl={stopped} initialPolicy={initialPolicy} />);
  await user.click(screen.getByRole("button", { name: "解除全局停止" }));

  expect(await screen.findByText(/旧运行需逐个继续，错过的计划不会补跑/u)).toBeInTheDocument();
});

it("旧停止命令重放后以重新读取的解除状态为准", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ applied: true, state: { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null } }))
    .mockResolvedValueOnce(Response.json({ stoppedAt: null, controlVersion: 2, scheduleResumeAfter: "2026-09-12T00:01:00.000Z" }));
  render(<AccountRunPolicyView initialControl={activeControl} initialPolicy={initialPolicy} />);

  await user.click(screen.getByRole("button", { name: "停止全部运行" }));

  expect(await screen.findByRole("button", { name: "停止全部运行" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent("已解除全局停止。旧运行需逐个继续，错过的计划不会补跑");
});

it("未停止时仅说明停止效果，不把当前状态说成已停止", () => {
  render(<AccountRunPolicyView initialControl={activeControl} initialPolicy={initialPolicy} />);
  expect(screen.queryByText("已停止新动作，正在运行的任务将在安全检查点暂停。已发出的请求可能仍产生费用")).not.toBeInTheDocument();
  expect(screen.getByText("停止后将阻止新的运行和外部动作，正在运行的任务会在安全检查点暂停；已发出的请求可能仍产生费用。")).toBeInTheDocument();
});

it("控制状态不可用时禁用按钮，不阻塞既有策略编辑", () => {
  render(<AccountRunPolicyView initialControl={null} initialPolicy={initialPolicy} />);
  expect(screen.getByRole("button", { name: "停止全部运行" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存运行策略" })).toBeEnabled();
});

it("保存更保守的可信来源上限时携带完整设置和当前修订，并显示新修订", async () => {
  const user = userEvent.setup();
  const savedPolicy: AccountRunPolicyResponse = {
    ...initialPolicy,
    revision: {
      ...initialPolicy.revision,
      revisionNumber: 5,
      createdAt: "2026-09-05T02:00:00.000Z",
      settings: { ...initialPolicy.effective, discovery: { ...initialPolicy.effective.discovery, trustedSourceLimit: 12 } },
    },
    userSettings: { ...initialPolicy.effective, discovery: { ...initialPolicy.effective.discovery, trustedSourceLimit: 12 } },
    effective: { ...initialPolicy.effective, discovery: { ...initialPolicy.effective.discovery, trustedSourceLimit: 12 } },
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(savedPolicy));

  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  const trustedSourceLimit = screen.getByRole("spinbutton", { name: "每次运行来源数量" });
  await user.clear(trustedSourceLimit);
  await user.type(trustedSourceLimit, "12");
  await user.click(screen.getByRole("button", { name: "保存运行策略" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/account/run-policy", expect.objectContaining({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: 4,
      settings: { ...initialPolicy.effective, discovery: { ...initialPolicy.effective.discovery, trustedSourceLimit: 12 } },
    }),
  })));
  expect(await screen.findByRole("status")).toHaveTextContent("运行策略已保存。");
  expect(screen.getByText("当前修订：5")).toBeInTheDocument();
});

it("超过系统硬上限时在保存前说明允许值，不发送请求", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.spyOn(globalThis, "fetch");

  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  const trustedSourceLimit = screen.getByRole("spinbutton", { name: "每次运行来源数量" });
  await user.clear(trustedSourceLimit);
  await user.type(trustedSourceLimit, "51");
  await user.click(screen.getByRole("button", { name: "保存运行策略" }));

  expect(screen.getByText("每次运行来源数量不得超过 50，请调整后再保存。")).toBeInTheDocument();
  expect(trustedSourceLimit).toHaveAttribute("aria-invalid", "true");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("最长运行时长的硬上限按分钟说明，不暴露内部毫秒", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.spyOn(globalThis, "fetch");
  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  const duration = screen.getByRole("spinbutton", { name: /公开岗位发现最长运行时长/ });
  await user.clear(duration);
  await user.type(duration, "4");
  await user.click(screen.getByRole("button", { name: "保存运行策略" }));

  expect(screen.getByText("最长运行时长不得超过 3 分钟，请调整后再保存。")).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("保存遇到版本冲突时允许重新读取最新策略", async () => {
  const user = userEvent.setup();
  const reloadedPolicy: AccountRunPolicyResponse = {
    ...initialPolicy,
    revision: { ...initialPolicy.revision, revisionNumber: 6, createdAt: "2026-09-05T03:00:00.000Z" },
  };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ code: "ACCOUNT_RUN_POLICY_VERSION_CONFLICT", message: "策略已更新" }, { status: 409 }))
    .mockResolvedValueOnce(Response.json(reloadedPolicy));

  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  await user.click(screen.getByRole("button", { name: "保存运行策略" }));
  expect(await screen.findByRole("status")).toHaveTextContent("策略已在其他位置更新，请重新读取后再保存。");
  await user.click(screen.getByRole("button", { name: "重新读取最新策略" }));

  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/account/run-policy", { cache: "no-store" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已重新读取最新运行策略。");
  expect(screen.getByText("当前修订：6")).toBeInTheDocument();
});

it("按修订查看运行策略历史及关键设置", async () => {
  const user = userEvent.setup();
  const earlierRevision = {
    ...initialPolicy.revision,
    revisionNumber: 3,
    createdAt: "2026-09-04T01:00:00.000Z",
    settings: { ...initialPolicy.effective, discovery: { ...initialPolicy.effective.discovery, trustedSourceLimit: 18 } },
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ revisions: [initialPolicy.revision, earlierRevision] }));

  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  await user.click(screen.getByRole("button", { name: "查看修订历史" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/account/run-policy/history", { cache: "no-store" }));
  expect(await screen.findByText("修订 3")).toBeInTheDocument();
  expect(screen.getByText("2026-09-04 09:00")).toBeInTheDocument();
  await user.click(screen.getAllByText("查看完整设置")[1]);
  expect(screen.getByText("每次运行来源数量：18")).toBeInTheDocument();
  expect(screen.getAllByText("验证候选数上限：6").length).toBeGreaterThan(0);
    expect(screen.getAllByText("公开岗位发现保留岗位结果数：5").length).toBeGreaterThan(0);
    expect(screen.getAllByText("深度匹配最多生成推荐数：10").length).toBeGreaterThan(0);
});

it("编辑公开发现、深度匹配和跨日后台窗口，并保持内部兼容预算不向用户展示", async () => {
  const user = userEvent.setup();
  const changedSettings = {
    ...initialPolicy.effective,
    discovery: { ...initialPolicy.effective.discovery, publicQueryLimit: 4, enabledProviders: [] },
    budgets: { ...initialPolicy.effective.budgets, deepMatch: { ...initialPolicy.effective.budgets.deepMatch, maxResults: 8 } },
    backgroundWindow: { start: "23:00", end: "02:00", timeZone: "Asia/Shanghai" as const },
  };
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    ...initialPolicy,
    revision: { ...initialPolicy.revision, revisionNumber: 5, settings: changedSettings },
    userSettings: changedSettings,
    effective: changedSettings,
  }));

  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  const publicQueryLimit = screen.getByRole("spinbutton", { name: "每次运行最多执行公开查询" });
  await user.clear(publicQueryLimit);
  await user.type(publicQueryLimit, "4");
  await user.click(screen.getByRole("checkbox", { name: "启用 AnySearch 公开查询" }));
  const deepMatchResults = screen.getByRole("spinbutton", { name: "深度匹配最多生成推荐数" });
  await user.clear(deepMatchResults);
  await user.type(deepMatchResults, "8");
  await user.clear(screen.getByLabelText("后台允许开始时间"));
  await user.type(screen.getByLabelText("后台允许开始时间"), "23:00");
  await user.clear(screen.getByLabelText("后台允许结束时间"));
  await user.type(screen.getByLabelText("后台允许结束时间"), "02:00");
  await user.click(screen.getByRole("button", { name: "保存运行策略" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/account/run-policy", expect.objectContaining({
    body: JSON.stringify({ expectedVersion: 4, settings: changedSettings }),
  })));
  expect(screen.queryByText(/fake/i)).not.toBeInTheDocument();
});

it("开始和结束时间相同会提供可见且关联到时间输入的错误，不发送请求", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.spyOn(globalThis, "fetch");
  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  const end = screen.getByLabelText("后台允许结束时间");
  await user.clear(end);
  await user.type(end, "08:00");
  await user.click(screen.getByRole("button", { name: "保存运行策略" }));

  expect(screen.getByText("开始和结束时间不能相同，请调整后再保存。")).toBeInTheDocument();
  expect(end).toHaveAttribute("aria-invalid", "true");
  expect(end).toHaveAttribute("aria-describedby", "background-window-error");
  expect(fetchMock).not.toHaveBeenCalled();
});

  it("服务端硬上限原因会回写到对应字段", async () => {
  const user = userEvent.setup();
  const hardLimit = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
    code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED",
    message: "不得超过系统硬上限",
    issues: [{ reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", path: ["settings", "discovery", "trustedSourceLimit"], maximum: 50, suggestedAction: "reduce_to_system_hard_limit" }],
  }, { status: 400 }));
  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  await user.click(screen.getByRole("button", { name: "保存运行策略" }));
  expect(await screen.findByText("每次运行来源数量不得超过 50，请调整后再保存。")).toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: /每次运行来源数量/ })).toHaveAttribute("aria-invalid", "true");
  expect(hardLimit).toHaveBeenCalledOnce();
});

it("已保存的公开查询禁用会明确显示未启用", () => {
  const disabledPolicy: AccountRunPolicyResponse = {
    ...initialPolicy,
    userSettings: { ...initialPolicy.userSettings!, discovery: { ...initialPolicy.userSettings!.discovery, enabledProviders: [] } },
    effective: { ...initialPolicy.effective, discovery: { ...initialPolicy.effective.discovery, enabledProviders: [] } },
  };
  render(<AccountRunPolicyView initialPolicy={disabledPolicy} />);

  expect(screen.getByRole("row", { name: /公开查询.*已启用.*可启用.*未启用.*未启用/ })).toBeInTheDocument();
});

it("未知的保存冲突使用通用错误，不提供重新读取入口", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ code: "ACCOUNT_RUN_POLICY_WRITE_FAILED", message: "暂时不可用" }, { status: 409 }));
  render(<AccountRunPolicyView initialPolicy={initialPolicy} />);

  await user.click(screen.getByRole("button", { name: "保存运行策略" }));
  expect(await screen.findByRole("status")).toHaveTextContent("暂时无法保存运行策略，请稍后重试。");
  expect(screen.queryByRole("button", { name: "重新读取最新策略" })).not.toBeInTheDocument();
});
