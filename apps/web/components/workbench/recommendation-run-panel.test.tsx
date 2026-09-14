import {
  RecommendationRunPreparationSchema,
  RecommendationRunSchema,
  type RecommendationRun,
  type RecommendationRunPreparation,
} from "@job-copilot/contracts/recommendation-runs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecommendationRunPanel } from "./recommendation-run-panel";

const runId = "9a5a0c80-2a73-4e61-8b14-d80f6e345af0";
const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const now = "2026-09-14T08:00:00.000Z";
const warningFingerprint = "a".repeat(64);
const budget = { maxActiveDurationMs: 60_000, maxAttempts: 3, maxToolCalls: 10, maxResults: 5, maxModelCalls: 0, maxTokens: 0 };
const firstKey = "355eec35-befa-44ee-ac34-1e3614975d4f";
const secondKey = "aee8d950-b36e-42ee-aac5-6763673757fc";
const thirdKey = "6e5d8a8a-5652-4fd1-9f1c-50515bd11c48";

function preflight(status: "ready" | "ready_with_warnings" | "blocked" = "ready") {
  const item = status === "blocked"
    ? { code: "ACCOUNT_RUN_POLICY_BLOCKED", severity: "blocking", summary: "账户运行已停止", evidence: { kind: "account_run_policy", revisionNumber: 1, status: "blocked", checkedAt: now }, impact: "请先解除全局停止", retryable: false, suggestedActions: ["review_account_run_policy"] }
    : status === "ready_with_warnings"
      ? { code: "SOURCE_HEALTH_UNCHECKED", severity: "warning", summary: "来源尚未检查", evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null }, impact: "可能遗漏岗位", retryable: true, suggestedActions: ["review_source_health"] }
      : { code: "ACCOUNT_RUN_POLICY_READY", severity: "informational", summary: "账户运行可用", evidence: { kind: "account_run_policy", revisionNumber: 1, status: "ready", checkedAt: now }, impact: "可以开始完整推荐", retryable: false, suggestedActions: [] };
  return { version: "run-preflight-v1" as const, workflow: "recommendation" as const, trigger: "manual" as const, targetId, status, items: [item], warningFingerprint: status === "ready_with_warnings" ? warningFingerprint : null, checkedAt: now };
}

function preparation(status: "ready" | "ready_with_warnings" | "blocked" = "ready"): RecommendationRunPreparation {
  return RecommendationRunPreparationSchema.parse({
    target: { targetId, targetVersion: 1, roleFamily: "AI 应用工程师" }, sourceScope: { trustedSourceCount: 2, publicQueryCount: 1 }, accountPolicyRevisionNumber: 1,
    budgets: { discovery: budget, deepMatch: budget }, preflight: preflight(status),
  });
}

function runningRun(): RecommendationRun {
  return RecommendationRunSchema.parse({
    runId, status: "running", currentStage: "discovery",
    stages: [
      { key: "discovery", status: "running", startedAt: now, completedAt: null },
      { key: "qualification", status: "pending", startedAt: null, completedAt: null },
      { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
      { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
      { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
    ], target: { targetId, targetVersion: 1, roleFamily: "AI 应用工程师" }, sourceScope: { trustedSourceCount: 2, publicQueryCount: 1 }, accountPolicyRevisionNumber: 1,
    budgets: { discovery: budget, deepMatch: budget }, preflightSnapshot: preflight(), result: null, failure: null, createdAt: now, updatedAt: now,
  });
}

function cancelledRun(): RecommendationRun {
  return RecommendationRunSchema.parse({
    ...runningRun(), status: "cancelled", currentStage: null,
    stages: [
      { key: "discovery", status: "cancelled", startedAt: now, completedAt: now },
      { key: "qualification", status: "pending", startedAt: null, completedAt: null },
      { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
      { key: "deep_matching", status: "pending", startedAt: null, completedAt: null },
      { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
    ],
  });
}

function pausedRun(): RecommendationRun {
  return RecommendationRunSchema.parse({ ...runningRun(), status: "paused" });
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setDocumentVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(runningRun()))));
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(firstKey);
  setDocumentVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("stops polling when the document is hidden and resumes it for an active run", async () => {
  const fetchSpy = vi.mocked(fetch);
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  setDocumentVisibility("hidden");
  await act(async () => { vi.advanceTimersByTime(15_000); });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  setDocumentVisibility("visible");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it("blocked preparation disables start and points to the run policy", () => {
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("blocked")} />);
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "查看运行设置" })).toHaveAttribute("href", "/profile/run-policy");
});

it("requires warning confirmation before it submits only the confirmation fingerprint and idempotency key", async () => {
  const fetchSpy = vi.mocked(fetch).mockImplementation(() => Promise.resolve(response({ run: runningRun(), reused: false }, 201)));
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("ready_with_warnings")} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  expect(fetchSpy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); });
  const startCall = fetchSpy.mock.calls.find(([url, init]) => url === "/api/recommendation-runs" && init?.method === "POST");
  expect(startCall).toMatchObject(["/api/recommendation-runs", { method: "POST", body: JSON.stringify({ idempotencyKey: "355eec35-befa-44ee-ac34-1e3614975d4f", warningFingerprint }) }]);
});

it("shows the ordered stages with the active stage and a non-disruptive live status", () => {
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  const list = screen.getByRole("list");
  expect(list).toHaveTextContent("发现岗位");
  expect(list).toHaveTextContent("资格筛选");
  expect(list).toHaveTextContent("初步排序");
  expect(list).toHaveTextContent("深度匹配");
  expect(list).toHaveTextContent("发布结果");
  expect(screen.getByText("发现岗位").closest("li")).toHaveAttribute("aria-current", "step");
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
});

it("replays a pause control with its command id and refreshes authoritative state on a conflict", async () => {
  const fetchSpy = vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/controls") && init?.method === "POST") return Promise.resolve(response({ code: "ACCOUNT_RUN_STOPPED", message: "账户已停止全部运行" }, 409));
    return Promise.resolve(response(runningRun()));
  });
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(fetchSpy).toHaveBeenCalledTimes(3);
  expect(fetchSpy.mock.calls[1]).toMatchObject([`/api/recommendation-runs/${runId}/controls`, { body: JSON.stringify({ commandId: "355eec35-befa-44ee-ac34-1e3614975d4f", action: "pause" }) }]);
  expect(screen.getByRole("link", { name: "查看运行设置" })).toHaveAttribute("href", "/profile/run-policy");
});

it("adopts refreshed preparation after a start conflict instead of reusing an old warning fingerprint", async () => {
  const refreshedPreparation = preparation("ready");
  const fetchSpy = vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") return Promise.resolve(response({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" }, 409));
    if (input === "/api/recommendation-runs/preparation") return Promise.resolve(response(refreshedPreparation));
    if (input === "/api/recommendation-runs/latest") return Promise.resolve(response({ run: null }));
    return Promise.resolve(response(runningRun()));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("ready_with_warnings")} />);
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(fetchSpy.mock.calls.some(([url]) => url === "/api/recommendation-runs/preparation")).toBe(true);
  expect(screen.getByRole("status")).toHaveTextContent("已读取最新准备状态");
});

it("terminal runs and unmounted panels do not continue polling", async () => {
  const completed = { ...runningRun(), status: "cancelled", currentStage: null, stages: [
    { key: "discovery", status: "cancelled", startedAt: now, completedAt: now },
    { key: "qualification", status: "pending", startedAt: null, completedAt: null }, { key: "coarse_ranking", status: "pending", startedAt: null, completedAt: null },
    { key: "deep_matching", status: "pending", startedAt: null, completedAt: null }, { key: "result_publication", status: "pending", startedAt: null, completedAt: null },
  ] } as RecommendationRun;
  const fetchSpy = vi.mocked(fetch);
  const terminal = render(<RecommendationRunPanel initialRun={completed} initialPreparation={preparation()} />);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetchSpy).not.toHaveBeenCalled();
  terminal.unmount();
});

it("同一面板收到新的权威 props 时更新运行和准备状态，同时保留当前焦点", async () => {
  const secondRun = RecommendationRunSchema.parse({ ...runningRun(), runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" });
  const secondPreparation = RecommendationRunPreparationSchema.parse({ ...preparation(), target: { targetId, targetVersion: 2, roleFamily: "数据工程师" } });
  const view = render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  const startButton = screen.getByRole("button", { name: "开始今日发现" });
  startButton.focus();

  view.rerender(<RecommendationRunPanel initialRun={secondRun} initialPreparation={secondPreparation} />);

  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText("主目标：数据工程师")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("正在完成今日发现");
  expect(document.activeElement).toBe(startButton);
});

it("旧 root 的延迟读取不能覆盖后来到达的权威 root", async () => {
  let resolveOldRead!: (value: Response) => void;
  const oldRun = runningRun();
  const secondRun = RecommendationRunSchema.parse({ ...runningRun(), runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3", target: { targetId, targetVersion: 2, roleFamily: "数据工程师" } });
  const secondPreparation = RecommendationRunPreparationSchema.parse({ ...preparation(), target: { targetId, targetVersion: 2, roleFamily: "数据工程师" } });
  vi.mocked(fetch).mockImplementation((input) => String(input).endsWith(oldRun.runId)
    ? new Promise<Response>((resolve) => { resolveOldRead = resolve; })
    : Promise.resolve(response(secondRun)));
  const view = render(<RecommendationRunPanel initialRun={oldRun} initialPreparation={preparation()} />);

  view.rerender(<RecommendationRunPanel initialRun={secondRun} initialPreparation={secondPreparation} />);
  await act(async () => { await Promise.resolve(); });
  resolveOldRead(response(cancelledRun()));
  await act(async () => { await Promise.resolve(); });

  expect(screen.getByRole("status")).toHaveTextContent("正在完成今日发现");
  expect(screen.getByText("主目标：数据工程师")).toBeVisible();
});

it("成功 resume 后可继续 pause，两个控制请求均到达当前服务端状态", async () => {
  let serverRun = pausedRun();
  const events: string[] = [];
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      const action = JSON.parse(String(init.body)).action as "pause" | "resume";
      events.push(`POST ${action}`);
      serverRun = RecommendationRunSchema.parse(action === "resume" ? runningRun() : pausedRun());
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    events.push(`GET ${serverRun.status}`);
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={pausedRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "继续本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(events).toEqual(["GET paused", "POST resume", "GET running", "POST pause", "GET paused"]);
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
});

it("warning 启动冲突刷新后允许重新确认并提交", async () => {
  const requests: string[] = [];
  const refreshedPreparation = preparation("ready_with_warnings");
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") {
      requests.push("POST start");
      return Promise.resolve(requests.length === 1
        ? response({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" }, 409)
        : response({ run: runningRun(), reused: false }, 201));
    }
    if (input === "/api/recommendation-runs/preparation") return Promise.resolve(response(refreshedPreparation));
    if (input === "/api/recommendation-runs/latest") return Promise.resolve(response({ run: null }));
    return Promise.resolve(response(runningRun()));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation("ready_with_warnings")} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  fireEvent.click(screen.getByRole("button", { name: "我已了解，开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(requests).toEqual(["POST start", "POST start"]);
});

it.each([200, 201])("start 收到 %i 后，服务端终态允许再次启动", async (status) => {
  let startCount = 0;
  let serverRun: RecommendationRun | null = null;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") {
      startCount += 1;
      serverRun = RecommendationRunSchema.parse(runningRun());
      const startResponse = response({ run: serverRun, reused: false }, status);
      if (startCount === 1) serverRun = cancelledRun();
      return Promise.resolve(startResponse);
    }
    if (String(input).endsWith(`/${runId}`)) return Promise.resolve(response(serverRun));
    return Promise.resolve(response({ run: null }));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(startCount).toBe(2);
});

it("start 网络失败重试复用 key，终态后新启动生成新 key", async () => {
  let startCount = 0;
  let serverRun: RecommendationRun | null = null;
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey);
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (input === "/api/recommendation-runs" && init?.method === "POST") {
      startCount += 1;
      if (startCount === 1) return Promise.reject(new Error("network unavailable"));
      serverRun = RecommendationRunSchema.parse(runningRun());
      const started = response({ run: serverRun, reused: false }, 201);
      if (startCount === 2) serverRun = cancelledRun();
      return Promise.resolve(started);
    }
    if (String(input).endsWith(`/${runId}`)) return Promise.resolve(response(serverRun));
    return Promise.resolve(response({ run: null }));
  });
  render(<RecommendationRunPanel initialRun={null} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "开始今日发现" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "开始今日发现" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const starts = vi.mocked(fetch).mock.calls.filter(([input, init]) => input === "/api/recommendation-runs" && init?.method === "POST");
  expect(starts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { idempotencyKey: firstKey, warningFingerprint: null },
    { idempotencyKey: firstKey, warningFingerprint: null },
    { idempotencyKey: secondKey, warningFingerprint: null },
  ]);
});

it.each([
  ["pause", runningRun(), "暂停本次推荐", pausedRun(), "继续本次推荐"],
  ["resume", pausedRun(), "继续本次推荐", runningRun(), "暂停本次推荐"],
  ["cancel", runningRun(), "取消本次推荐", cancelledRun(), "本次推荐已取消"],
] as const)("%s 网络未知后重试复用 commandId，并采用合法服务端投影", async (action, initialRun, buttonName, appliedRun, visibleState) => {
  let serverRun = RecommendationRunSchema.parse(initialRun);
  let postCount = 0;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      postCount += 1;
      serverRun = RecommendationRunSchema.parse(appliedRun);
      if (postCount === 1) return Promise.reject(new Error("network unavailable"));
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={initialRun} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  const commands = vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/controls") && init?.method === "POST");
  expect(commands.map(([input, init]) => [input, init?.method, JSON.parse(String(init?.body))])).toEqual([
    [`/api/recommendation-runs/${runId}/controls`, "POST", { commandId: firstKey, action }],
    [`/api/recommendation-runs/${runId}/controls`, "POST", { commandId: firstKey, action }],
  ]);
  if (action === "cancel") expect(screen.getByRole("status")).toHaveTextContent(visibleState);
  else expect(screen.getByRole("button", { name: visibleState })).toBeEnabled();
});

it("pause 未知结果被 GET 确认后，新的 pause 意图使用新 commandId", async () => {
  let serverRun = runningRun();
  let pausePosts = 0;
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey).mockReturnValueOnce(thirdKey);
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      const action = JSON.parse(String(init.body)).action as "pause" | "resume";
      serverRun = RecommendationRunSchema.parse(action === "pause" ? pausedRun() : runningRun());
      if (action === "pause") {
        pausePosts += 1;
        if (pausePosts === 1) return Promise.reject(new Error("network unavailable"));
      }
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    return Promise.resolve(response(serverRun));
  });
  render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "继续本次推荐" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "继续本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const pauseCommands = vi.mocked(fetch).mock.calls
    .filter(([input, init]) => String(input).endsWith("/controls") && init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)))
    .filter((body) => body.action === "pause");
  expect(pauseCommands).toEqual([
    { commandId: firstKey, action: "pause" }, { commandId: thirdKey, action: "pause" },
  ]);
});

it("未知命令后的新 root 不继承旧 commandId", async () => {
  const nextRun = RecommendationRunSchema.parse({ ...runningRun(), runId: "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" });
  let serverRun = runningRun();
  let controls = 0;
  vi.mocked(crypto.randomUUID).mockReturnValueOnce(firstKey).mockReturnValueOnce(secondKey);
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/controls") && init?.method === "POST") {
      controls += 1;
      if (controls === 1) return Promise.reject(new Error("network unavailable"));
      serverRun = RecommendationRunSchema.parse({ ...pausedRun(), runId: nextRun.runId });
      return Promise.resolve(response({ run: serverRun, applied: true }));
    }
    return Promise.resolve(response(serverRun));
  });
  const view = render(<RecommendationRunPanel initialRun={runningRun()} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  serverRun = nextRun;
  view.rerender(<RecommendationRunPanel initialRun={nextRun} initialPreparation={preparation()} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByRole("button", { name: "暂停本次推荐" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "暂停本次推荐" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const commands = vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith("/controls") && init?.method === "POST");
  expect(commands.map(([input, init]) => [input, JSON.parse(String(init?.body))])).toEqual([
    [`/api/recommendation-runs/${runId}/controls`, { commandId: firstKey, action: "pause" }],
    [`/api/recommendation-runs/${nextRun.runId}/controls`, { commandId: secondKey, action: "pause" }],
  ]);
});
