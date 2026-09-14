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
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("355eec35-befa-44ee-ac34-1e3614975d4f");
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
