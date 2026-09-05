import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import type { JobTarget } from "@job-copilot/contracts/job-targets";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AgentRunPanel } from "./agent-run-panel";
import { AgentInboxPanel } from "./agent-inbox-panel";

const runId = "9a5a0c80-2a73-4e61-8b14-d80f6e345af0";
const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const secondTargetId = "de8f94ae-e5ca-4112-b2e8-00cc2920bc80";
const idempotencyKey = "355eec35-befa-44ee-ac34-1e3614975d4f";
const now = "2026-08-29T08:00:00.000Z";

function target(id = targetId, roleFamily = "AI 应用工程师", priority: JobTarget["priority"] = "primary"): JobTarget {
  return {
    targetId: id,
    version: 1,
    priority,
    state: "active",
    constraints: {
      roleFamily,
      seniority: "高级",
      locations: ["上海"],
      workModes: ["hybrid"],
      relocation: "conditional",
      salary: null,
      industries: ["AI"],
      dealBreakers: {
        excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: true,
        excludeDispatch: true, excludeHeadhunter: false, other: [],
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function detail(status: AgentRunDetail["status"] = "running"): AgentRunDetail {
  const terminal = status === "completed";
  const failed = status === "failed";
  return {
    runId,
    targetId,
    targetVersion: 1,
    accountPolicyRevisionNumber: null,
    preflightSnapshot: null,
    targetSnapshot: { targetId, version: 1, priority: "primary", state: "active", constraints: target().constraints },
    sourceScope: {
      kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1",
      watchlistVersion: 0,
      sources: ["fake:aurora-careers", "fake:orbit-careers"],
    },
    workflowVersion: "job-discovery-workflow-v1",
    adapter: "fake",
    adapterVersion: "fake-job-discovery-v1",
    outputSchemaVersion: "job-discovery-result-v1",
    budget: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
    status,
    currentStep: terminal ? "completed" : failed ? "failed" : "batch_search",
    version: terminal ? 8 : 2,
    attemptCount: 1,
    failureCode: failed ? "AGENT_RUN_BUDGET_EXCEEDED" : null,
    queuedAt: now,
    startedAt: now,
    completedAt: terminal ? "2026-08-29T08:00:03.000Z" : null,
    failedAt: failed ? "2026-08-29T08:00:03.000Z" : null,
    cancelledAt: null,
    updatedAt: terminal ? "2026-08-29T08:00:03.000Z" : now,
    executionSpec: {
      targetSnapshot: { targetId, version: 1, priority: "primary", state: "active", constraints: target().constraints },
      sourceScope: { kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1", watchlistVersion: 0, sources: ["fake:aurora-careers", "fake:orbit-careers"] },
      workflowVersion: "job-discovery-workflow-v1", ruleVersion: "fake-job-discovery-rules-v1", adapter: "fake", adapterVersion: "fake-job-discovery-v1",
      outputSchemaVersion: "job-discovery-result-v1", toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"], model: null,
      budget: { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
    },
    controlState: "none",
    usage: { activeDurationMs: 1200, attempts: 1, toolCalls: 2, sourceRequests: 2, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, results: terminal ? 1 : 0, complete: true },
    termination: terminal ? { kind: "completed", failureCode: null, budgetDimension: null } : failed ? { kind: "budget_exhausted", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "attempts" } : null,
    retryOfRunId: null,
    steps: [
      { stepKey: "batch_search", ordinal: 1, status: terminal ? "completed" : failed ? "failed" : "running", attemptCount: 1, startedAt: now, completedAt: terminal ? now : null, failedAt: failed ? "2026-08-29T08:00:03.000Z" : null, failureCode: failed ? "AGENT_RUN_BUDGET_EXCEEDED" : null },
      { stepKey: "fetch_details", ordinal: 2, status: terminal ? "completed" : "pending", attemptCount: terminal ? 1 : 0, startedAt: terminal ? now : null, completedAt: terminal ? now : null, failedAt: null, failureCode: null },
      { stepKey: "persist_results", ordinal: 3, status: terminal ? "completed" : "pending", attemptCount: terminal ? 1 : 0, startedAt: terminal ? now : null, completedAt: terminal ? now : null, failedAt: null, failureCode: null },
    ],
    events: [
      { sequence: 1, runVersion: 1, eventType: "run.queued", data: { eventType: "run.queued", status: "queued", currentStep: "queued", attemptCount: 0 }, createdAt: now },
      { sequence: 2, runVersion: 2, eventType: "run.started", data: { eventType: "run.started", status: "running", currentStep: "batch_search", attemptCount: 1 }, createdAt: now },
      ...(terminal ? [{ sequence: 8, runVersion: 8, eventType: "run.completed" as const, data: { eventType: "run.completed" as const, status: "completed" as const, currentStep: "completed" as const, attemptCount: 1, resultCount: 1 }, createdAt: "2026-08-29T08:00:03.000Z" }] : []),
    ],
    results: terminal ? [{
      resultId: "6ad34054-8226-4887-b85a-48077bdd64c6",
      ordinal: 1,
      opportunityId: "d9cfaadb-14d8-4659-9bed-2314aeb41b09",
      sourcePostingId: "433c77d2-d0bc-4f8d-a133-2c55d4ffdb83",
      sourcePostingVersionId: "8dd953c5-041e-4195-99b8-c47c45e53592",
      company: "极光智联", title: "高级 AI 应用工程师", location: "上海", postedAt: "2026-08-28T00:00:00.000Z",
      deadline: null, sourceType: "company_careers", isOfficial: true,
    }] : [],
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  closed = false;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  close() { this.closed = true; }
  dispatch(type: string, event: Event) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
  emit(type: string, id: string, data: unknown, runVersion = Number(id)) {
    const event = new MessageEvent(type, { data: JSON.stringify({ id, event: type, runVersion, data }), lastEventId: id });
    this.dispatch(type, event);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
  window.sessionStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

it("来源问题完成显示诊断状态、问题来源数量和锚点链接", () => {
  const partial = {
    ...detail("completed"),
    workflowVersion: "job-discovery-workflow-v3",
    adapter: "greenhouse",
    adapterVersion: "greenhouse-job-board-v2",
    outputSchemaVersion: "job-discovery-result-v3",
    termination: { kind: "completed_with_source_issues", failureCode: null, budgetDimension: null },
    sourceChecks: [{ status: "rate_limited" }, { status: "healthy" }],
  } as unknown as AgentRunDetail;
  render(<AgentRunPanel targets={[target()]} initialRun={partial} />);
  expect(screen.getByText("岗位发现部分完成")).toBeVisible();
  expect(screen.getByText("问题来源 1 个。", { exact: false })).toBeVisible();
  expect(screen.getByRole("link", { name: "查看来源诊断" })).toHaveAttribute("href", `/profile/targets/${targetId}/watchlist#source-health`);
  expect(screen.getByRole("link", { name: "查看来源诊断" })).toHaveClass("workbench-touch-target");
});

it("能力拒绝显示稳定影响、受影响公司、不可重试和有限建议", () => {
  const partial = { ...detail("completed"), workflowVersion: "job-discovery-workflow-v3", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", outputSchemaVersion: "job-discovery-result-v3", sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", watchlistVersion: 1, sources: [{ sourceId: "greenhouse:denied", watchlistItemId: "11111111-1111-4111-8111-111111111111", canonicalCompanyName: "受影响公司", careersUrl: "https://boards.greenhouse.io/denied", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "denied" }] }, termination: { kind: "completed_with_source_issues", failureCode: null, budgetDimension: null }, sourceChecks: [], sourceIssues: [{ provider: "greenhouse", code: "SOURCE_CAPABILITY_UNSUPPORTED", affectedCount: 1, impact: { scope: "entire_source", affectedCount: null }, retryable: false, suggestedActions: ["review_source_capabilities"] }] } as unknown as AgentRunDetail;
  render(<AgentRunPanel targets={[target()]} initialRun={partial} />);
  expect(screen.getByText(/影响范围：整个来源；不可重试。建议：检查来源能力声明/u)).toBeVisible();
  expect(screen.getByText(/受影响来源 1 个（受影响公司）/u)).toBeVisible();
  expect(screen.getByRole("link", { name: "查看来源能力" })).toHaveAttribute("href", `/profile/targets/${targetId}/watchlist#source-capabilities`);
});

it("失败运行以中文说明声明失配且不暴露内部代码", () => {
  const failed = { ...detail("failed"), workflowVersion: "job-discovery-workflow-v3", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", outputSchemaVersion: "job-discovery-result-v3", termination: { kind: "source_failed", failureCode: "AGENT_RUN_ADAPTER_FAILED", budgetDimension: null }, sourceChecks: [], sourceIssues: [{ provider: "greenhouse", code: "SOURCE_CAPABILITY_DECLARATION_MISMATCH", affectedCount: 2, impact: { scope: "entire_source", affectedCount: null }, retryable: false, suggestedActions: ["review_source_capabilities"] }] } as unknown as AgentRunDetail;
  render(<AgentRunPanel targets={[target()]} initialRun={failed} />);
  expect(screen.getByText(/该来源声明与本次冻结执行规格不一致；受影响来源 2 个/u)).toBeVisible();
  expect(screen.queryByText(/SOURCE_CAPABILITY_DECLARATION_MISMATCH/u)).not.toBeInTheDocument();
  expect(screen.getByText(/影响范围：整个来源；不可重试。建议：检查来源能力声明/u)).toBeVisible();
});

it("能力影响达到聚合上限时标示至少数量", () => {
  const partial = { ...detail("completed"), workflowVersion: "job-discovery-workflow-v3", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", outputSchemaVersion: "job-discovery-result-v3", termination: { kind: "completed_with_source_issues", failureCode: null, budgetDimension: null }, sourceChecks: [], sourceIssues: [{ provider: "greenhouse", code: "SOURCE_CAPABILITY_UNSUPPORTED", affectedCount: 10, impact: { scope: "entire_source", affectedCount: null }, retryable: false, suggestedActions: ["review_source_capabilities"] }] } as unknown as AgentRunDetail;
  render(<AgentRunPanel targets={[target()]} initialRun={partial} />);
  expect(screen.getByText(/该来源未声明所需能力；受影响来源 至少 10 个/u)).toBeVisible();
});

it("收到 Inbox 已处理通知后重新读取权威运行详情", async () => {
  const paused = { ...detail(), status: "paused" as const, currentStep: "batch_search" as const, version: 4 };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(detail("completed"))));
  const view = render(<AgentRunPanel initialRun={paused} refreshVersion={0} targets={[target()]} />);

  view.rerender(<AgentRunPanel initialRun={paused} refreshVersion={1} targets={[target()]} />);

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("岗位发现完成，共保存 1 个岗位机会"));
});

it("求职目标暂时不可读取时仍以只读方式保留成功的运行记录", () => {
  render(<AgentRunPanel initialRun={detail("completed")} targets={null as unknown as JobTarget[]} />);

  expect(screen.getByRole("heading", { name: "发现新的岗位机会" })).toBeVisible();
  expect(screen.getByText("岗位发现完成，共保存 1 个岗位机会")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "先确认求职目标" })).not.toBeInTheDocument();
});

it.each([
  ["运行中", { ...detail(), status: "running" as const, controlState: "none" as const }, ["暂停岗位发现", "取消岗位发现"], "暂停岗位发现"],
  ["已暂停", { ...detail(), status: "paused" as const, controlState: "none" as const }, ["继续本次岗位发现", "取消岗位发现"], "继续本次岗位发现"],
])("目标暂时不可读取时，%s运行仍保留 run-id 控制", async (_state, run, controls, action) => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ applied: true, run: { runId, status: run.status, currentStep: run.currentStep, controlState: "none", version: run.version + 1 } })));
  render(<AgentRunPanel initialRun={run} targets={null} />);

  expect(screen.getByRole("heading", { name: "发现新的岗位机会" })).toBeVisible();
  expect(screen.getByText("求职目标暂时无法读取；以下仅显示已成功读取的本次运行记录。")).toBeVisible();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "发现岗位" })).not.toBeInTheDocument();
  controls.forEach((name) => expect(screen.getByRole("button", { name })).toBeVisible());
  await user.click(screen.getByRole("button", { name: action }));
  expect(fetch).toHaveBeenCalledWith(`/api/agent-runs/${runId}/controls`, expect.objectContaining({ method: "POST" }));
});

it("没有活动目标时仍展示已完成历史运行，但不渲染空选择器或启动操作", () => {
  render(<AgentRunPanel initialRun={detail("completed")} targets={[]} />);

  expect(screen.getByRole("heading", { name: "发现新的岗位机会" })).toBeVisible();
  expect(screen.getByText("岗位发现完成，共保存 1 个岗位机会")).toBeVisible();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "发现岗位" })).not.toBeInTheDocument();
});

it("lets the user choose an active target and exposes a touch-sized discovery action", async () => {
  render(<AgentRunPanel initialRun={null} targets={[
    target(), target(secondTargetId, "前端工程师", "secondary"),
  ]} />);

  expect(screen.getByRole("combobox", { name: "用于发现岗位的求职目标" })).toHaveValue(targetId);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "用于发现岗位的求职目标" }), secondTargetId);
  expect(screen.getByRole("button", { name: "发现岗位" })).toHaveClass("workbench-touch-target");
});

it("按稳定失败码解释固定预算，而不泄露异常正文或误导为稍后重试", () => {
  render(<AgentRunPanel initialRun={detail("failed")} targets={[target()]} />);

  expect(screen.getByText("本次发现超过固定处理预算，请缩小求职目标后重新发起。")).toBeInTheDocument();
  expect(screen.queryByText(/Error|exception|稍后重新尝试/u)).not.toBeInTheDocument();
});

it("显示冻结的执行规格、模型说明和预算账本", () => {
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);

  expect(screen.getByText("fake-job-discovery-rules-v1")).toBeVisible();
  expect(screen.getByText("本流程未使用模型")).toBeVisible();
  expect(screen.getByText("2 / 10 次来源请求")).toBeVisible();
  expect(screen.getByRole("button", { name: "暂停岗位发现" })).toBeEnabled();
  expect(screen.getByText("搜索岗位来源")).toBeVisible();
  expect(screen.getByText("job-discovery-result-v1")).toBeVisible();
  expect(screen.getByText("执行流程版本")).toBeVisible();
  expect(screen.getByText("匹配规则版本")).toBeVisible();
  expect(screen.getByText("岗位来源连接版本")).toBeVisible();
  expect(screen.getByText("结果格式版本")).toBeVisible();
  expect(screen.getByText("允许的操作范围")).toBeVisible();
});

it("对深度匹配运行保留匹配记录，同时仍允许发起下一次岗位发现", () => {
  const matching = {
    ...detail("completed"), workflowVersion: "deep-match-v1", currentStep: "completed",
    usage: { ...detail("completed").usage, results: 7 },
    executionSpec: {
      ...detail("completed").executionSpec,
      workflowVersion: "deep-match-v1", sourceScope: { kind: "deep_match", trigger: "automatic", opportunityId: null, discoveryRunId: "00000000-0000-4000-8000-000000000009" },
      adapter: "fake-deep-match", adapterVersion: "fake-deep-match-v1", outputSchemaVersion: "deep-match-result-v1",
      model: { provider: "fake", model: "fake-deep-match-model-v1" }, toolAllowlist: [],
      budget: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 10, maxModelCalls: 10, maxTokens: 20_000 },
    },
  } as AgentRunDetail;
  render(<AgentRunPanel initialRun={matching} targets={[target()]} />);

  expect(screen.getByRole("status")).toHaveTextContent("岗位匹配完成");
  expect(screen.getByRole("status")).toHaveTextContent("已生成 7 项推荐");
  expect(screen.getByRole("heading", { name: "评估候选岗位匹配" })).toBeVisible();
  expect(screen.getByLabelText("用于发现岗位的求职目标")).toBeVisible();
  expect(screen.getByRole("button", { name: "发现岗位" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "开始岗位匹配" })).not.toBeInTheDocument();
  expect(screen.getByText("岗位匹配会在岗位发现完成后自动开始；如需重新评估，请在推荐清单中选择具体岗位。")).toBeVisible();
  expect(screen.getByLabelText("本次岗位匹配执行规格")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "本次发现的岗位" })).not.toBeInTheDocument();
  expect(screen.getByText("fake · fake-deep-match-model-v1")).toBeVisible();
  expect(screen.getByRole("list", { name: "岗位匹配运行时间线" })).toHaveTextContent("开始评估岗位匹配");
});

it("历史消费明细不完整时只展示预算上限", () => {
  const legacy = { ...detail(), usage: { ...detail().usage, complete: false } };
  render(<AgentRunPanel initialRun={legacy} targets={[target()]} />);

  expect(screen.getByText(/历史消费明细不完整/u)).toBeVisible();
  expect(screen.queryByText("2 / 10 次来源请求")).not.toBeInTheDocument();
  expect(screen.getByText("上限：10 次来源请求")).toBeVisible();
});

it("暂停会保留同一命令 UUID 供失败后的重试", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(new Response(null, { status: 502 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);

  await user.click(screen.getByRole("button", { name: "暂停岗位发现" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("暂停请求暂时无法提交，请稍后重试。"));
  await user.click(screen.getByRole("button", { name: "暂停岗位发现" }));

  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { commandId: idempotencyKey, action: "pause" }, { commandId: idempotencyKey, action: "pause" },
  ]);
});

it("在控制请求尚未返回时立即说明正在等待安全暂停", async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(new Promise((done) => { resolve = done; })));
  const user = userEvent.setup();
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);

  await user.click(screen.getByRole("button", { name: "暂停岗位发现" }));
  expect(screen.getByRole("status")).toHaveTextContent("等待安全暂停");
  resolve(new Response(null, { status: 502 }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("暂停请求暂时无法提交，请稍后重试。"));
});

it.each([
  ["running", "none", ["暂停岗位发现", "取消岗位发现"]],
  ["running", "pause_requested", ["继续本次岗位发现", "取消岗位发现"]],
  ["running", "cancel_requested", []],
  ["paused", "none", ["继续本次岗位发现", "取消岗位发现"]],
  ["completed", "none", []],
] as const)("控制按钮矩阵：%s/%s", (status, controlState, expected) => {
  const currentStep = status === "completed" ? "completed" : "batch_search";
  render(<AgentRunPanel initialRun={{ ...detail(), status, currentStep, controlState } as AgentRunDetail} targets={[target()]} />);

  ["暂停岗位发现", "继续本次岗位发现", "取消岗位发现"].forEach((name) => {
    expect(Boolean(screen.queryByRole("button", { name }))).toBe((expected as readonly string[]).includes(name));
  });
});

it("409 冲突后清除控制 UUID，下一次尝试生成新 UUID", async () => {
  const secondKey = "aee8d950-b36e-42ee-aac5-6763673757fc";
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(idempotencyKey).mockReturnValueOnce(secondKey);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(new Response(null, { status: 409 })));
  const user = userEvent.setup();
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);

  await user.click(screen.getByRole("button", { name: "暂停岗位发现" }));
  await user.click(screen.getByRole("button", { name: "暂停岗位发现" }));

  expect(vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { commandId: idempotencyKey, action: "pause" }, { commandId: secondKey, action: "pause" },
  ]);
});

it("忽略晚到的低版本暂停响应，保留更高版本的取消请求", async () => {
  let resolvePause!: (value: Response) => void;
  const cancel = { applied: true, run: { runId, status: "running", currentStep: "batch_search", controlState: "cancel_requested", version: 4 } };
  const pause = { applied: true, run: { runId, status: "running", currentStep: "batch_search", controlState: "pause_requested", version: 3 } };
  const fetchMock = vi.fn<typeof fetch>()
    .mockReturnValueOnce(new Promise((done) => { resolvePause = done; }))
    .mockResolvedValueOnce(Response.json(cancel));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);

  await user.click(screen.getByRole("button", { name: "暂停岗位发现" }));
  await user.click(screen.getByRole("button", { name: "取消岗位发现" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("等待安全取消"));
  resolvePause(Response.json(pause));

  await waitFor(() => expect(screen.queryByRole("button", { name: "继续本次岗位发现" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "暂停岗位发现" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "取消岗位发现" })).not.toBeInTheDocument();
});

it("SSE 推进运行版本后忽略迟到的低版本暂停响应", async () => {
  let resolvePause!: (value: Response) => void;
  const pause = { applied: true, run: { runId, status: "running", currentStep: "batch_search", controlState: "pause_requested", version: 2 } };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValueOnce(new Promise((done) => { resolvePause = done; })));
  const user = userEvent.setup();
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;

  await user.click(screen.getByRole("button", { name: "暂停岗位发现" }));
  act(() => {
    source.emit("run.pause_requested", "3", { eventType: "run.pause_requested", status: "running", currentStep: "batch_search", attemptCount: 1 }, 2);
    source.emit("run.resumed", "4", { eventType: "run.resumed", status: "queued", currentStep: "queued", attemptCount: 1 }, 3);
  });
  resolvePause(Response.json(pause));

  await waitFor(() => expect(screen.getByRole("button", { name: "暂停岗位发现" })).toBeVisible());
  expect(screen.queryByRole("button", { name: "继续本次岗位发现" })).not.toBeInTheDocument();
});

it("暂停事件关闭投影、重读详情并提供继续和取消", async () => {
  const paused = { ...detail(), status: "paused" as const, currentStep: "batch_search" as const, controlState: "none" as const, version: 3 };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(paused)));
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;

  act(() => source.emit("run.paused", "3", { eventType: "run.paused", status: "paused", currentStep: "batch_search", attemptCount: 1 }));

  await waitFor(() => expect(source.closed).toBe(true));
  expect(await screen.findByRole("button", { name: "继续本次岗位发现" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "取消岗位发现" })).toBeEnabled();
});

it("暂停的权威详情读取后刷新开放 Inbox", async () => {
  const paused = { ...detail(), status: "paused" as const, currentStep: "batch_search" as const, controlState: "none" as const, version: 3 };
  const refreshInbox = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(paused)));
  render(<AgentRunPanel initialRun={detail()} onInboxRefresh={refreshInbox} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;

  act(() => source.emit("run.paused", "3", { eventType: "run.paused", status: "paused", currentStep: "batch_search", attemptCount: 1 }));
  await waitFor(() => expect(refreshInbox).toHaveBeenCalledOnce());
});

it("运行面板触发 Inbox 刷新后将新权威事项呈现在收件箱", async () => {
  const paused = { ...detail(), status: "paused" as const, currentStep: "batch_search" as const, controlState: "none" as const, version: 3 };
  const refreshedItem: AgentInboxItem = {
    itemId: "4a1b0207-b852-4f86-8b1f-3b9615655ed8", runId: runId, kind: "candidate_fact", status: "unread", reasonCode: "CANDIDATE_FACT_PENDING", budgetDimension: null,
    title: "刷新后的事项", message: "新读取的数据。", basis: "新依据。", impact: "新影响。", suggestedAction: "新建议。",
    target: { type: "candidate_fact", candidateFactId: "1a1b0207-b852-4f86-8b1f-3b9615655ed8", href: "/profile#candidate-facts" }, availableActions: ["dismiss"], createdAt: now, readAt: null, resolvedAt: null,
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(paused))
    .mockResolvedValueOnce(Response.json({ items: [refreshedItem] })));

  function RunInboxHarness() {
    const [items, setItems] = useState<AgentInboxItem[]>([]);
    return <><AgentInboxPanel key={JSON.stringify(items)} items={items} onResolved={vi.fn()} /><AgentRunPanel initialRun={detail()} onInboxRefresh={async () => {
      const response = await fetch("/api/agent-inbox?status=pending", { cache: "no-store" });
      if (!response.ok) return false;
      setItems((await response.json() as { items: AgentInboxItem[] }).items);
      return true;
    }} targets={[target()]} /></>;
  }

  render(<RunInboxHarness />);
  act(() => FakeEventSource.instances[0]!.emit("run.paused", "3", { eventType: "run.paused", status: "paused", currentStep: "batch_search", attemptCount: 1 }));

  expect(await screen.findByRole("article", { name: "刷新后的事项" })).toBeVisible();
});

it("SSE 权威详情成功后 Inbox 刷新失败不会回退运行状态", async () => {
  const paused = { ...detail(), status: "paused" as const, currentStep: "batch_search" as const, controlState: "none" as const, version: 3 };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(paused)));
  const refreshInbox = vi.fn().mockRejectedValue(new Error("offline"));
  render(<AgentRunPanel initialRun={detail()} onInboxRefresh={refreshInbox} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;

  act(() => source.emit("run.paused", "3", { eventType: "run.paused", status: "paused", currentStep: "batch_search", attemptCount: 1 }));

  expect(await screen.findByRole("button", { name: "继续本次岗位发现" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("待处理事项暂未刷新，请刷新页面查看。"));
});

it("暂停详情落地后延迟的 Inbox 刷新失败仍会显示警告", async () => {
  const paused = { ...detail(), status: "paused" as const, currentStep: "batch_search" as const, controlState: "none" as const, version: 3 };
  let resolveInbox!: (value: boolean) => void;
  const refreshInbox = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => { resolveInbox = resolve; }));
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(paused)));
  render(<AgentRunPanel initialRun={detail()} onInboxRefresh={refreshInbox} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;

  act(() => source.emit("run.paused", "3", { eventType: "run.paused", status: "paused", currentStep: "batch_search", attemptCount: 1 }));
  expect(await screen.findByRole("button", { name: "继续本次岗位发现" })).toBeVisible();
  resolveInbox(false);

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("待处理事项暂未刷新，请刷新页面查看。"));
});

it("直接控制的权威详情成功后 Inbox 刷新失败不会误报详情失败", async () => {
  const paused = { ...detail(), status: "paused" as const, currentStep: "batch_search" as const, controlState: "none" as const, version: 3 };
  const response = { applied: true, run: { runId, status: "paused", currentStep: "batch_search", controlState: "none", version: 3 } };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(Response.json(paused)));
  const refreshInbox = vi.fn().mockResolvedValue(false);
  const user = userEvent.setup();
  render(<AgentRunPanel initialRun={{ ...detail(), status: "queued", currentStep: "queued" }} onInboxRefresh={refreshInbox} targets={[target()]} />);

  await user.click(screen.getByRole("button", { name: "暂停岗位发现" }));

  expect(await screen.findByRole("button", { name: "继续本次岗位发现" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("待处理事项暂未刷新，请刷新页面查看。"));
  expect(screen.getByRole("status")).not.toHaveTextContent("详情暂时无法读取");
});

it("reuses one idempotency UUID while the same start submission is retried", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentRunPanel initialRun={null} targets={[target()]} />);

  await user.click(screen.getByRole("button", { name: "发现岗位" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("岗位发现暂时无法启动，请稍后重试。"));
  await user.click(screen.getByRole("button", { name: "发现岗位" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { targetId, idempotencyKey }, { targetId, idempotencyKey },
  ]);
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
});

it("rotates the idempotency UUID when changing the target starts a new submission", async () => {
  const secondKey = "aee8d950-b36e-42ee-aac5-6763673757fc";
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(idempotencyKey).mockReturnValueOnce(secondKey);
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentRunPanel initialRun={null} targets={[
    target(), target(secondTargetId, "前端工程师", "secondary"),
  ]} />);

  await user.click(screen.getByRole("button", { name: "发现岗位" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("岗位发现暂时无法启动，请稍后重试。"));
  await user.selectOptions(screen.getByRole("combobox", { name: "用于发现岗位的求职目标" }), secondTargetId);
  await user.click(screen.getByRole("button", { name: "发现岗位" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { targetId, idempotencyKey }, { targetId: secondTargetId, idempotencyKey: secondKey },
  ]);
});

it("recovers the created run detail without posting a second run or rotating its UUID", async () => {
  const user = userEvent.setup();
  const completed = detail("completed");
  const summary = { ...completed };
  delete (summary as Partial<AgentRunDetail>).steps;
  delete (summary as Partial<AgentRunDetail>).events;
  delete (summary as Partial<AgentRunDetail>).results;
  delete (summary as Partial<AgentRunDetail>).executionSpec;
  delete (summary as Partial<AgentRunDetail>).controlState;
  delete (summary as Partial<AgentRunDetail>).usage;
  delete (summary as Partial<AgentRunDetail>).termination;
  delete (summary as Partial<AgentRunDetail>).retryOfRunId;
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...summary, reused: false }, { status: 201 }))
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(Response.json(completed));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentRunPanel initialRun={null} targets={[target()]} />);

  await user.click(screen.getByRole("button", { name: "发现岗位" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("运行已创建，正在恢复状态。请稍后重试。"));
  await user.click(screen.getByRole("button", { name: "发现岗位" }));

  expect(await screen.findByRole("heading", { name: "高级 AI 应用工程师" })).toBeVisible();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/api/agent-runs", `/api/agent-runs/${runId}`, `/api/agent-runs/${runId}`,
  ]);
  expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ targetId, idempotencyKey });
  expect(crypto.randomUUID).toHaveBeenCalledTimes(1);
});

it("keeps replayed progress accessible and ignores duplicate or out-of-order SSE events", () => {
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;

  expect(source.url).toBe(`/api/agent-runs/${runId}/events?afterEventId=2`);
  expect(screen.getByRole("list", { name: "岗位发现运行时间线" })).toHaveTextContent("已排队");
  expect(screen.getByRole("list", { name: "岗位发现运行时间线" })).toHaveTextContent("开始发现岗位");

  act(() => {
    source.emit("step.started", "3", { eventType: "step.started", status: "running", currentStep: "fetch_details", stepKey: "fetch_details", attemptCount: 1 });
    source.emit("step.started", "3", { eventType: "step.started", status: "running", currentStep: "fetch_details", stepKey: "fetch_details", attemptCount: 1 });
    source.emit("step.completed", "2", { eventType: "step.completed", status: "running", currentStep: "batch_search", stepKey: "batch_search", attemptCount: 1 });
  });

  expect(screen.getAllByText("正在读取岗位详情")).toHaveLength(1);
  expect(window.sessionStorage.getItem(`job-copilot:agent-run:${runId}:cursor`)).toBe("3");
});

it("resumes from the run cursor and replaces projections with authoritative terminal detail", async () => {
  window.sessionStorage.setItem(`job-copilot:agent-run:${runId}:cursor`, "7");
  const completed = detail("completed");
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completed));
  vi.stubGlobal("fetch", fetchMock);
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;

  expect(source.url).toBe(`/api/agent-runs/${runId}/events?afterEventId=7`);
  act(() => source.emit("run.completed", "8", {
    eventType: "run.completed", status: "completed", currentStep: "completed", attemptCount: 1, resultCount: 1,
  }));

  await waitFor(() => expect(source.closed).toBe(true));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/agent-runs/${runId}`, expect.objectContaining({ cache: "no-store" })));
  expect(await screen.findByRole("heading", { name: "高级 AI 应用工程师" })).toBeVisible();
  expect(screen.getByText("极光智联")).toBeVisible();
  expect(screen.getByText("上海")).toBeVisible();
  expect(screen.getByText("公司招聘官网")).toBeVisible();
});

it("shows a stable reconnecting message and clears it after the next valid event", () => {
  render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;

  act(() => source.dispatch("error", new Event("error")));
  expect(screen.getByRole("status")).toHaveTextContent("进度连接中断，正在恢复。");
  act(() => source.emit("step.started", "3", {
    eventType: "step.started", status: "running", currentStep: "fetch_details", stepKey: "fetch_details", attemptCount: 1,
  }));
  expect(screen.getByRole("status")).toHaveTextContent("岗位发现进行中");
  expect(screen.getByRole("status")).not.toHaveTextContent("连接中断");
});

it("closes an unmounted stream and ignores an already queued late event", () => {
  const view = render(<AgentRunPanel initialRun={detail()} targets={[target()]} />);
  const source = FakeEventSource.instances[0]!;
  const lateListener = [...source.listeners.get("step.started")!][0]!;

  view.unmount();
  act(() => lateListener(new MessageEvent("step.started", {
    data: JSON.stringify({ eventType: "step.started", status: "running", currentStep: "fetch_details", stepKey: "fetch_details", attemptCount: 1 }),
    lastEventId: "3",
  })));

  expect(source.closed).toBe(true);
  expect(window.sessionStorage.getItem(`job-copilot:agent-run:${runId}:cursor`)).toBe("2");
});
