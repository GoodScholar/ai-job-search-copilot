import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import type { JobTarget } from "@job-copilot/contracts/job-targets";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AgentRunPanel } from "./agent-run-panel";

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
  return {
    runId,
    targetId,
    targetVersion: 1,
    targetSnapshot: { targetId, version: 1, priority: "primary", state: "active", constraints: target().constraints },
    sourceScope: {
      kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1",
      sources: ["fake:aurora-careers", "fake:orbit-careers"],
    },
    workflowVersion: "job-discovery-workflow-v1",
    adapter: "fake",
    adapterVersion: "fake-job-discovery-v1",
    outputSchemaVersion: "job-discovery-result-v1",
    budget: { maxDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 },
    status,
    currentStep: terminal ? "completed" : "batch_search",
    version: terminal ? 8 : 2,
    attemptCount: 1,
    failureCode: null,
    queuedAt: now,
    startedAt: now,
    completedAt: terminal ? "2026-08-29T08:00:03.000Z" : null,
    failedAt: null,
    updatedAt: terminal ? "2026-08-29T08:00:03.000Z" : now,
    steps: [
      { stepKey: "batch_search", ordinal: 1, status: terminal ? "completed" : "running", attemptCount: 1, startedAt: now, completedAt: terminal ? now : null, failedAt: null, failureCode: null },
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
  emit(type: string, id: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id });
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

it("lets the user choose an active target and exposes a touch-sized discovery action", async () => {
  render(<AgentRunPanel initialRun={null} targets={[
    target(), target(secondTargetId, "前端工程师", "secondary"),
  ]} />);

  expect(screen.getByRole("combobox", { name: "用于发现岗位的求职目标" })).toHaveValue(targetId);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "用于发现岗位的求职目标" }), secondTargetId);
  expect(screen.getByRole("button", { name: "发现岗位" })).toHaveClass("workbench-touch-target");
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
