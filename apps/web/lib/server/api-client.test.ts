import { expect, it, vi } from "vitest";
import type { JobTargetOverview } from "@job-copilot/contracts/job-targets";
import type { CompanyWatchlistOverview } from "@job-copilot/contracts/company-watchlists";
import type { JobImportDetail } from "@job-copilot/contracts/job-imports";
import type {
  AgentRunDetail,
  ControlAgentRunResponse,
  StartAgentRunResponse,
} from "@job-copilot/contracts/agent-runs";
import type { AgentInboxActionResponse, AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import type { JobTriageVersion } from "@job-copilot/contracts/job-triage";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { ApiProblemSchema } from "@job-copilot/contracts/api-problem";
import { RunPreflightProblemSchema } from "@job-copilot/contracts/run-preflight";
import { RecommendationListSchema } from "@job-copilot/contracts/recommendations";
import { RecommendationRunPreparationSchema, RecommendationRunSchema } from "@job-copilot/contracts/recommendation-runs";

vi.mock("server-only", () => ({}));

import { createApiClient } from "./api-client";

const sessionToken = "a".repeat(43);
const userId = "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3";
const importId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const documentId = "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";
const conflictId = "c4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";
const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const jobImportId = "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
const agentRunId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const restartWarningProblem = RunPreflightProblemSchema.parse({
  code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED",
  message: "请确认当前运行前检查提示",
  preflight: {
    version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId,
    status: "ready_with_warnings", warningFingerprint: "a".repeat(64), checkedAt: "2026-09-05T00:00:00.000Z",
    items: [{
      code: "SOURCE_HEALTH_UNCHECKED", severity: "warning", summary: "来源尚未完成健康检查", impact: "运行可以继续，建议稍后查看来源健康状态。", retryable: true,
      suggestedActions: ["review_source_health"], evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null },
    }],
  },
});
const restartBlockedProblem = RunPreflightProblemSchema.parse({
  code: "RUN_PREFLIGHT_BLOCKED",
  message: "请先创建主求职目标",
  preflight: {
    version: "run-preflight-v1", workflow: "discovery", trigger: "manual", targetId: null,
    status: "blocked", warningFingerprint: null, checkedAt: "2026-09-05T00:00:00.000Z",
    items: [{
      code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: "缺少主求职目标", impact: "请先创建主求职目标。", retryable: false,
      suggestedActions: ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: "2026-09-05T00:00:00.000Z" },
    }],
  },
});
const restartConflictProblem = ApiProblemSchema.parse({
  code: "AGENT_INBOX_ACTION_CONFLICT",
  message: "该事项当前不能重新启动",
  requestId: "c7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0",
});

const queuedImport = {
  importId,
  documentId,
  sourceFilename: "career.md",
  sourceFormat: "markdown",
  privacyStatus: "sanitized_only",
  status: "queued",
  failureCode: null,
  createdAt: "2026-08-27T08:00:00.000Z",
  updatedAt: "2026-08-27T08:00:00.000Z",
};

const jobTargetOverview: JobTargetOverview = {
  suggestions: [],
  targets: [{
    targetId,
    version: 1,
    priority: "primary",
    state: "active",
    constraints: {
      roleFamily: "前端工程师",
      seniority: null,
      locations: [],
      workModes: [],
      relocation: "unknown",
      salary: null,
      industries: [],
      dealBreakers: {
        excludedCompanies: [],
        excludedIndustries: [],
        excludeOutsourcing: false,
        excludeDispatch: false,
        excludeHeadhunter: false,
        other: [],
      },
    },
    createdAt: "2026-08-28T08:00:00.000Z",
    updatedAt: "2026-08-28T08:00:00.000Z",
  }],
};

const companyWatchlistOverview: CompanyWatchlistOverview = {
  target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "前端工程师" },
  version: 5,
  items: [{
    itemId: "af8c6eb3-2b92-4d91-aad4-959b7d4cd7a3",
    canonicalCompanyName: "示例公司",
    careersUrl: "https://careers.example.com/jobs",
    allowedDomains: ["example.com"],
    sourceNote: null,
    state: "enabled",
    position: 1,
  }],
};

const jobImportDetail: JobImportDetail = {
  importId: jobImportId,
  inputType: "pasted_text",
  originalFilename: null,
  status: "imported",
  failureCode: null,
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T08:00:00.000Z",
  opportunity: null,
};
const jobImportSummary = {
  importId: jobImportId, inputType: "pasted_text", originalFilename: null, status: "imported", failureCode: null,
  createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:00:00.000Z",
} as const;
const agentRunSummary = {
  runId: agentRunId,
  targetId,
  targetVersion: 1,
  accountPolicyRevisionNumber: null,
  preflightSnapshot: null,
  targetSnapshot: { targetId, version: 1, priority: "primary", state: "active", constraints: jobTargetOverview.targets[0].constraints },
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
  status: "queued",
  currentStep: "queued",
  version: 1,
  attemptCount: 0,
  failureCode: null,
  queuedAt: "2026-08-29T08:00:00.000Z",
  startedAt: null,
  completedAt: null,
  failedAt: null,
  cancelledAt: null,
  updatedAt: "2026-08-29T08:00:00.000Z",
} satisfies Omit<StartAgentRunResponse, "reused">;
const agentRunDetail = {
  ...agentRunSummary,
  executionSpec: {
    targetSnapshot: agentRunSummary.targetSnapshot,
    sourceScope: agentRunSummary.sourceScope,
    workflowVersion: "job-discovery-workflow-v1",
    ruleVersion: "fake-job-discovery-rules-v1",
    adapter: "fake",
    adapterVersion: "fake-job-discovery-v1",
    outputSchemaVersion: "job-discovery-result-v1",
    toolAllowlist: ["job_discovery.search_batch", "job_discovery.get_detail"],
    model: null,
    budget: agentRunSummary.budget,
  },
  controlState: "none",
  usage: {
    activeDurationMs: 0, attempts: 0, toolCalls: 0, sourceRequests: 0, modelCalls: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, results: 0, complete: true,
  },
  termination: null,
  retryOfRunId: null,
  steps: [],
  events: [],
  results: [],
} satisfies AgentRunDetail;

const controlResponse: ControlAgentRunResponse = {
  applied: true,
  run: { runId: agentRunId, status: "paused", currentStep: "queued", controlState: "none", version: 2 },
};

const inboxItem: AgentInboxItem = {
  itemId: "39d2bfbf-7e40-49fc-86c8-3a15d7ad4f98",
  runId: agentRunId,
  kind: "decision_required",
  status: "unread",
  reasonCode: "AGENT_RUN_PAUSED",
  budgetDimension: null,
  title: "岗位发现已暂停",
  message: "选择继续或取消本次岗位发现。",
  basis: "运行已暂停。",
  impact: "本次发现不会继续。",
  suggestedAction: "继续或取消运行。",
  retryable: false,
  suggestedActions: [],
  target: { type: "agent_run", runId: agentRunId, href: `/home?runId=${agentRunId}#agent-run` },
  availableActions: ["mark_read", "resume_run", "cancel_run"],
  createdAt: "2026-08-29T08:00:00.000Z",
  readAt: null,
  resolvedAt: null,
};

const inboxActionResponse: AgentInboxActionResponse = { applied: true, item: inboxItem, run: controlResponse.run };
const triageVersion: JobTriageVersion = {
  triageVersionId: "e4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", opportunityId: "f4d4a7c1-9a17-4a8c-8b36-0f815d042e9a", targetId,
  overallVerdict: "unknown", deadlineStatus: "missing", confidenceBasisPoints: 8400, dimensionScores: null, overallScore: null, threshold: null,
  gateResults: Object.fromEntries(["location", "work_mode", "relocation", "salary", "seniority", "education", "language", "work_eligibility", "deal_breakers"].map((gate) => [gate, { verdict: "unknown", reasonCode: "JOB_EVIDENCE_MISSING", jobEvidence: null, candidateEvidence: null }])) as JobTriageVersion["gateResults"],
  pendingItems: [{ gate: "location", reasonCode: "JOB_EVIDENCE_MISSING", message: "需要补充岗位或画像证据" }], sequence: 1, createdAt: "2026-09-01T00:00:00.000Z",
};

it("starts a dev session with an opaque request id and parses the shared response", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({
      account: { userId },
      sessionToken,
      expiresAt: "2026-09-02T08:00:00.000Z",
    }), { status: 201 }),
  );
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl,
  });

  await expect(api.startDevSession({ subject: "local-primary" })).resolves.toEqual({
    account: { userId },
    sessionToken,
    expiresAt: "2026-09-02T08:00:00.000Z",
  });

  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:3021/v1/auth/dev/sessions");
  expect(init).toMatchObject({ method: "POST" });
  const headers = new Headers(init?.headers);
  expect(headers.get("x-request-id")).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(headers.get("x-dev-auth-secret")).toBe("secret");
});

it("reads the authenticated empty workbench through the shared DTO", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({
      account: { userId },
      summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false },
      firstRecommendationJourney: null,
    }), { status: 200 }),
  );
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl,
  });

  await expect(api.getWorkbenchHome(sessionToken)).resolves.toEqual({
    account: { userId },
    summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false },
    firstRecommendationJourney: null,
  });

  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:3021/v1/workbench/home");
  expect(init).toMatchObject({ method: "GET", cache: "no-store" });
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
});

it("以严格命令和响应契约更新首次推荐旅程交互", async () => {
  const interaction = { version: 1, dismissedAt: null, lastVisitedStep: "career_materials" };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(interaction), { status: 200 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(api.updateFirstRecommendationJourneyInteraction(sessionToken, {
    action: "visit_step", stepId: "career_materials", expectedVersion: 0,
  })).resolves.toEqual(interaction);

  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:3021/v1/workbench/first-recommendation-journey");
  expect(init).toMatchObject({ method: "PUT", cache: "no-store", body: JSON.stringify({ action: "visit_step", stepId: "career_materials", expectedVersion: 0 }) });
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
});

it("接受符合最新版严格契约的已完成首次推荐旅程首页投影", async () => {
  const home = {
    account: { userId },
    summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false },
    firstRecommendationJourney: { status: "completed", steps: [], currentStepId: null, completedAt: "2026-09-06T00:00:00.000Z" },
  };
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(home), { status: 200 })),
  });

  await expect(api.getWorkbenchHome(sessionToken)).resolves.toEqual(home);
});

it("拒绝含未知字段或非法投影的首次推荐旅程首页响应", async () => {
  const home = {
    account: { userId },
    summary: { todayRecommendations: 0, pendingFacts: 0, activeAgentRuns: 0, failedAgentRuns: 0, sourceFailures: 0, pendingDecisions: 0, applications: 0, applicationsAvailable: false },
  };
  const completedJourney = { status: "completed", steps: [], currentStepId: null, completedAt: "2026-09-06T00:00:00.000Z" };
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...home, firstRecommendationJourney: { ...completedJourney, unexpected: true } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...home, firstRecommendationJourney: { status: "completed", steps: [], currentStepId: "first_result", completedAt: null } }), { status: 200 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(api.getWorkbenchHome(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.getWorkbenchHome(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
});

it("拒绝注入 owner 的旅程命令以及不符合严格响应契约的成功体", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    version: 1, dismissedAt: null, lastVisitedStep: "career_materials", unexpected: true,
  }), { status: 200 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(api.updateFirstRecommendationJourneyInteraction(sessionToken, {
    action: "visit_step", stepId: "career_materials", expectedVersion: 0, userId,
  } as never)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();

  await expect(api.updateFirstRecommendationJourneyInteraction(sessionToken, {
    action: "visit_step", stepId: "career_materials", expectedVersion: 0,
  })).rejects.toMatchObject({ kind: "invalid_response" });
});

it("creates and reloads a triage version through owner-bound API paths", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(triageVersion), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(triageVersion), { status: 200 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(api.createJobTriageVersion(sessionToken, triageVersion.opportunityId, { targetId })).resolves.toEqual(triageVersion);
  await expect(api.getLatestJobTriageVersion(sessionToken, triageVersion.opportunityId, targetId)).resolves.toEqual(triageVersion);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    `http://127.0.0.1:3021/v1/job-opportunities/${triageVersion.opportunityId}/triage-versions`,
    `http://127.0.0.1:3021/v1/job-opportunities/${triageVersion.opportunityId}/triage-versions/latest?targetId=${targetId}`,
  ]);
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ targetId });
});

it("reads only the trusted profile snapshot through the shared DTO", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    profileId: null, version: 0, facts: [],
  }), { status: 200 }));
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl,
  });

  await expect(api.getProfile(sessionToken)).resolves.toEqual({ profileId: null, version: 0, facts: [] });
  expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3021/v1/profile", expect.objectContaining({
    method: "GET", headers: expect.any(Object),
  }));
  expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
});

it("sends a candidate decision with the caller version and returns the trusted snapshot", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    profileId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", version: 1, facts: [],
  }), { status: 201 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(api.decideCandidateFact(sessionToken, importId, { expectedVersion: 0, decision: "confirmed" }))
    .resolves.toMatchObject({ version: 1 });
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:3021/v1/profile/candidate-facts/${importId}/decisions`, expect.objectContaining({
    method: "POST", body: JSON.stringify({ expectedVersion: 0, decision: "confirmed" }),
  }));
});

it("sends manual profile fact maintenance commands with the caller version", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    profileId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08", version: 1, facts: [],
  }), { status: 201 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(api.createProfileFact(sessionToken, {
    expectedVersion: 0, factType: "work_eligibility", factValue: { summary: "可在中国大陆工作" },
  })).resolves.toMatchObject({ version: 1 });

  expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3021/v1/profile/facts", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ expectedVersion: 0, factType: "work_eligibility", factValue: { summary: "可在中国大陆工作" } }),
  }));
});

it("通过 bearer 调用认证求职目标 API，并返回共享概览 DTO", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(jobTargetOverview), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(jobTargetOverview), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(jobTargetOverview), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(jobTargetOverview), { status: 201 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const constraints = jobTargetOverview.targets[0].constraints;

  await expect(api.getJobTargetOverview(sessionToken)).resolves.toEqual(jobTargetOverview);
  await expect(api.createJobTarget(sessionToken, { priority: "primary", constraints })).resolves.toEqual(jobTargetOverview);
  await expect(api.reviseJobTarget(sessionToken, targetId, { expectedVersion: 1, priority: "primary", constraints })).resolves.toEqual(jobTargetOverview);
  await expect(api.deactivateJobTarget(sessionToken, targetId, { expectedVersion: 1 })).resolves.toEqual(jobTargetOverview);

  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:3021/v1/job-targets",
    "http://127.0.0.1:3021/v1/job-targets",
    `http://127.0.0.1:3021/v1/job-targets/${targetId}/revisions`,
    `http://127.0.0.1:3021/v1/job-targets/${targetId}/deactivations`,
  ]);
  expect(fetchImpl.mock.calls.map(([, init]) => ({ method: init?.method, body: init?.body }))).toEqual([
    { method: "GET", body: undefined },
    { method: "POST", body: JSON.stringify({ priority: "primary", constraints }) },
    { method: "POST", body: JSON.stringify({ expectedVersion: 1, priority: "primary", constraints }) },
    { method: "POST", body: JSON.stringify({ expectedVersion: 1 }) },
  ]);
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  }
});

it("拒绝四个求职目标 API 的无效成功响应", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ targets: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ suggestions: [] }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ suggestions: [], targets: [{ unknown: true }] }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ suggestions: [], targets: [], unknown: true }), { status: 201 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const constraints = jobTargetOverview.targets[0].constraints;

  await expect(api.getJobTargetOverview(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.createJobTarget(sessionToken, { priority: "primary", constraints })).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.reviseJobTarget(sessionToken, targetId, { expectedVersion: 1, priority: "primary", constraints })).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.deactivateJobTarget(sessionToken, targetId, { expectedVersion: 1 })).rejects.toMatchObject({ kind: "invalid_response" });
});

it("严格解析 revise 与 rebase 的最小安全响应", async () => {
  const proposalId = "00000000-0000-4000-8000-000000000001";
  const safe = { proposalId, revisionId: "00000000-0000-4000-8000-000000000002", revisionNumber: 2 };
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(safe), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(safe), { status: 201 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  await expect(api.reviseCalibrationProposal(sessionToken, proposalId, { strategy: "raise_quality_bar", expectedVersion: 1, idempotencyKey: "00000000-0000-4000-8000-000000000003" })).resolves.toEqual(safe);
  await expect(api.rebaseCalibrationProposal(sessionToken, proposalId, { expectedVersion: 2, idempotencyKey: "00000000-0000-4000-8000-000000000004" })).resolves.toEqual(safe);
});

it("拒绝 revise 与 rebase 的多余或缺失成功字段", async () => {
  const proposalId = "00000000-0000-4000-8000-000000000001";
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ proposalId, revisionId: "00000000-0000-4000-8000-000000000002", revisionNumber: 2, userId: "00000000-0000-4000-8000-000000000003" }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ proposalId, revisionId: "00000000-0000-4000-8000-000000000002" }), { status: 201 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  await expect(api.reviseCalibrationProposal(sessionToken, proposalId, { strategy: "raise_quality_bar", expectedVersion: 1, idempotencyKey: "00000000-0000-4000-8000-000000000003" })).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.rebaseCalibrationProposal(sessionToken, proposalId, { expectedVersion: 2, idempotencyKey: "00000000-0000-4000-8000-000000000004" })).rejects.toMatchObject({ kind: "invalid_response" });
});

it("通过 bearer 调用五个目标公司 Watchlist API，并严格返回共享概览 DTO", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(companyWatchlistOverview), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(companyWatchlistOverview), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(companyWatchlistOverview), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(companyWatchlistOverview), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(companyWatchlistOverview), { status: 201 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const itemId = companyWatchlistOverview.items[0].itemId;
  const add = { expectedVersion: 0, canonicalCompanyName: "示例公司", careersUrl: "https://careers.example.com/jobs", allowedDomains: ["example.com"], sourceNote: null };
  const revise = { ...add, expectedVersion: 1 };

  await expect(api.getCompanyWatchlist(sessionToken, targetId)).resolves.toEqual(companyWatchlistOverview);
  await expect(api.addCompanyWatchlistItem(sessionToken, targetId, add)).resolves.toEqual(companyWatchlistOverview);
  await expect(api.reviseCompanyWatchlistItem(sessionToken, targetId, itemId, revise)).resolves.toEqual(companyWatchlistOverview);
  await expect(api.setCompanyWatchlistItemState(sessionToken, targetId, itemId, { expectedVersion: 2, state: "disabled" })).resolves.toEqual(companyWatchlistOverview);
  await expect(api.reorderCompanyWatchlist(sessionToken, targetId, { expectedVersion: 3, orderedItemIds: [itemId] })).resolves.toEqual(companyWatchlistOverview);

  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    `http://127.0.0.1:3021/v1/job-targets/${targetId}/company-watchlist`,
    `http://127.0.0.1:3021/v1/job-targets/${targetId}/company-watchlist/items`,
    `http://127.0.0.1:3021/v1/job-targets/${targetId}/company-watchlist/items/${itemId}/revisions`,
    `http://127.0.0.1:3021/v1/job-targets/${targetId}/company-watchlist/items/${itemId}/state-changes`,
    `http://127.0.0.1:3021/v1/job-targets/${targetId}/company-watchlist/reorders`,
  ]);
  expect(fetchImpl.mock.calls.map(([, init]) => ({ method: init?.method, body: init?.body }))).toEqual([
    { method: "GET", body: undefined },
    { method: "POST", body: JSON.stringify(add) },
    { method: "POST", body: JSON.stringify(revise) },
    { method: "POST", body: JSON.stringify({ expectedVersion: 2, state: "disabled" }) },
    { method: "POST", body: JSON.stringify({ expectedVersion: 3, orderedItemIds: [itemId] }) },
  ]);
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  }
});

it("将五个目标公司 Watchlist API 的无效成功体映射为 invalid_response", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ version: 0 }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ target: {} }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ unknown: true }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, unknown: true }), { status: 201 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const itemId = companyWatchlistOverview.items[0].itemId;
  const add = { expectedVersion: 0, canonicalCompanyName: "示例公司", careersUrl: "https://careers.example.com/jobs", allowedDomains: ["example.com"], sourceNote: null };

  await expect(api.getCompanyWatchlist(sessionToken, targetId)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.addCompanyWatchlistItem(sessionToken, targetId, add)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.reviseCompanyWatchlistItem(sessionToken, targetId, itemId, { ...add, expectedVersion: 1 })).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.setCompanyWatchlistItemState(sessionToken, targetId, itemId, { expectedVersion: 2, state: "enabled" })).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(api.reorderCompanyWatchlist(sessionToken, targetId, { expectedVersion: 3, orderedItemIds: [itemId] })).rejects.toMatchObject({ kind: "invalid_response" });
});

it("保留五个目标公司 Watchlist API 的标准 problem 响应", async () => {
  const problem = { code: "COMPANY_WATCHLIST_VERSION_CONFLICT", message: "目标公司 Watchlist 已在其他位置更新，请刷新后重试", requestId: "cf8c6eb3-2b92-4d91-aad4-959b7d4cd7a3" };
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(problem), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(problem), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(problem), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(problem), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(problem), { status: 409 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const itemId = companyWatchlistOverview.items[0].itemId;
  const add = { expectedVersion: 0, canonicalCompanyName: "示例公司", careersUrl: "https://careers.example.com/jobs", allowedDomains: ["example.com"], sourceNote: null };
  const expectProblem = { kind: "api", status: 409, problem };

  await expect(api.getCompanyWatchlist(sessionToken, targetId)).rejects.toMatchObject(expectProblem);
  await expect(api.addCompanyWatchlistItem(sessionToken, targetId, add)).rejects.toMatchObject(expectProblem);
  await expect(api.reviseCompanyWatchlistItem(sessionToken, targetId, itemId, { ...add, expectedVersion: 1 })).rejects.toMatchObject(expectProblem);
  await expect(api.setCompanyWatchlistItemState(sessionToken, targetId, itemId, { expectedVersion: 2, state: "enabled" })).rejects.toMatchObject(expectProblem);
  await expect(api.reorderCompanyWatchlist(sessionToken, targetId, { expectedVersion: 3, orderedItemIds: [itemId] })).rejects.toMatchObject(expectProblem);
});

it("recognizes an already-invalid current session from the shared error response", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({
      code: "AUTH_REQUIRED",
      message: "需要有效会话",
      requestId: "4af12bb3-1bbb-4ae4-9b6c-ec5e6888dacb",
    }), { status: 401 }),
  );
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl,
  });

  await expect(api.endCurrentSession(sessionToken)).resolves.toBe("already_invalid");
});

it("surfaces true transport failures as retryable errors", async () => {
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
  });

  await expect(api.endCurrentSession(sessionToken)).rejects.toMatchObject({
    kind: "network",
  });
});

it("uses bearer authentication, unique request ids, and the shared career import DTOs", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ imports: [{ ...queuedImport, candidateFactCount: 0 }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...queuedImport, reused: false, detailUrl: `/v1/career-documents/imports/${importId}` })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...queuedImport, facts: [] })));
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl,
  });
  const formData = new FormData();
  formData.set("file", new File(["## 技能\\n- TypeScript"], "career.md", { type: "text/markdown" }));

  await expect(api.listCareerImports(sessionToken)).resolves.toEqual({ imports: [{ ...queuedImport, candidateFactCount: 0 }] });
  await expect(api.createCareerImport(sessionToken, formData)).resolves.toMatchObject({ status: "queued" });
  await expect(api.getCareerImport(sessionToken, importId)).resolves.toMatchObject({ importId, facts: [] });

  const requestIds = fetchImpl.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-request-id"));
  expect(new Set(requestIds).size).toBe(3);
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  }
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:3021/v1/career-documents/imports",
    "http://127.0.0.1:3021/v1/career-documents/imports",
    `http://127.0.0.1:3021/v1/career-documents/imports/${importId}`,
  ]);
  const uploadHeaders = new Headers(fetchImpl.mock.calls[1]![1]?.headers);
  expect(uploadHeaders.get("content-type")).toBeNull();
  expect(fetchImpl.mock.calls[1]![1]?.body).toBe(formData);
});

it("rejects malformed career import responses without exposing them as data", async () => {
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ imports: [{ unknown: true }] }))),
  });

  await expect(api.listCareerImports(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
});

it("严格解析职业事实冲突解决的画像与服务端冲突 DTO", async () => {
  const response = {
    profile: { profileId: null, version: 1, facts: [] },
    conflict: { conflictId, kind: "date", status: "resolved", resolution: "use_existing", profileVersion: 1, resolvedAt: "2026-08-27T08:00:00.000Z" },
  };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  await expect(api.resolveCareerFactConflict(sessionToken, conflictId, { expectedVersion: 0, resolution: "use_existing" })).resolves.toEqual(response);
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:3021/v1/career-documents/fact-conflicts/${conflictId}/resolutions`, expect.objectContaining({
    method: "POST", body: JSON.stringify({ expectedVersion: 0, resolution: "use_existing" }),
  }));
});

it("拒绝缺少服务端已持久化冲突 DTO 的严格响应", async () => {
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ profile: { profileId: null, version: 1, facts: [] } }), { status: 200 })),
  });
  await expect(api.resolveCareerFactConflict(sessionToken, conflictId, { expectedVersion: 0, resolution: "use_existing" }))
    .rejects.toMatchObject({ kind: "invalid_response" });
});

it("通过 bearer 提交、读取并严格解析岗位导入 DTO", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      importId: jobImportId, inputType: "pasted_text", originalFilename: null, status: "imported", failureCode: null,
      createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:00:00.000Z", detailUrl: `/v1/job-imports/${jobImportId}`,
    }), { status: 202 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ imports: [jobImportSummary] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(jobImportDetail), { status: 200 }))
    .mockResolvedValueOnce(new Response("# 职位说明", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(api.createJobImport(sessionToken, { inputType: "pasted_text", content: "职位说明" })).resolves.toMatchObject({ importId: jobImportId });
  await expect(api.listJobImports(sessionToken)).resolves.toEqual({ imports: [jobImportSummary] });
  await expect(api.getJobImport(sessionToken, jobImportId)).resolves.toEqual(jobImportDetail);
  await expect(api.getJobImportRaw(sessionToken, jobImportId)).resolves.toBe("# 职位说明");

  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:3021/v1/job-imports",
    "http://127.0.0.1:3021/v1/job-imports",
    `http://127.0.0.1:3021/v1/job-imports/${jobImportId}`,
    `http://127.0.0.1:3021/v1/job-imports/${jobImportId}/raw`,
  ]);
  expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ inputType: "pasted_text", content: "职位说明" }) });
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  }
});

it.each([[200, true], [202, false]] as const)("将岗位导入 HTTP %i 明确映射为 reused=%s", async (status, reused) => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    importId: jobImportId, inputType: "pasted_text", originalFilename: null, status: "imported", failureCode: null,
    createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:00:00.000Z", detailUrl: `/v1/job-imports/${jobImportId}`,
  }), { status }));
  const api = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(api.createJobImport(sessionToken, { inputType: "pasted_text", content: "职位说明" })).resolves.toMatchObject({ reused });
});

it("拒绝不符合岗位导入契约的成功响应", async () => {
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ imports: [{ unknown: true }] }), { status: 200 })),
  });

  await expect(api.listJobImports(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
});

it("通过服务端 bearer 启动并严格读取 Agent Run DTO", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...agentRunSummary, reused: false }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ run: agentRunDetail }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(agentRunDetail), { status: 200 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const command = { targetId, idempotencyKey: "91cc6d11-6e50-4456-b2f0-393461336376" };

  await expect(client.startAgentRun(sessionToken, command)).resolves.toEqual({ ...agentRunSummary, reused: false });
  await expect(client.getLatestAgentRun(sessionToken)).resolves.toEqual({ run: agentRunDetail });
  await expect(client.getAgentRun(sessionToken, agentRunId)).resolves.toEqual(agentRunDetail);

  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:3021/v1/agent-runs",
    "http://127.0.0.1:3021/v1/agent-runs/latest",
    `http://127.0.0.1:3021/v1/agent-runs/${agentRunId}`,
  ]);
  expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ ...command, warningFingerprint: null }) });
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  }
});

it("仅将严格预检冲突保留为 409，畸形上游 409 统一降级为安全 502", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "RUN_PREFLIGHT_BLOCKED", message: "恶意正文", preflight: { rawPayload: "secret" } }), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "SOMETHING_ELSE", message: "恶意正文" }), { status: 409 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const command = { targetId, idempotencyKey: "91cc6d11-6e50-4456-b2f0-393461336376" };

  await expect(client.startAgentRun(sessionToken, command)).rejects.toMatchObject({ kind: "api", status: 502, problem: undefined });
  await expect(client.startDeepMatchRun(sessionToken, targetId, "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004")).rejects.toMatchObject({ kind: "api", status: 502, problem: undefined });
});

it("严格读取 recommendations deep-match 创建响应并忽略其服务端判别字段", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ kind: "created", runId: "00000000-0000-4000-8000-000000000005", reused: false }), { status: 201 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(client.startDeepMatchRun(sessionToken, targetId, "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-0000-000000000004")).resolves.toEqual({ runId: "00000000-0000-4000-8000-000000000005", reused: false });
});

it("拒绝不符合 Agent Run 契约的成功 JSON", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...agentRunSummary, reused: false, rawPayload: "secret" }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ run: { ...agentRunDetail, unknown: true } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...agentRunDetail, unknown: true }), { status: 200 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const command = { targetId, idempotencyKey: "91cc6d11-6e50-4456-b2f0-393461336376" };

  await expect(client.startAgentRun(sessionToken, command)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(client.getLatestAgentRun(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(client.getAgentRun(sessionToken, agentRunId)).rejects.toMatchObject({ kind: "invalid_response" });
});

it("通过服务端 bearer 严格处理运行控制与 Agent Inbox", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(controlResponse), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [inboxItem] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(inboxActionResponse), { status: 200 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const control = { commandId: "48d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "pause" as const };
  const action = { actionId: "59d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "resume_run" as const };

  await expect(client.controlAgentRun(sessionToken, agentRunId, control)).resolves.toEqual(controlResponse);
  await expect(client.listAgentInbox(sessionToken, "pending")).resolves.toEqual({ items: [inboxItem] });
  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, action)).resolves.toEqual(inboxActionResponse);

  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    `http://127.0.0.1:3021/v1/agent-runs/${agentRunId}/controls`,
    "http://127.0.0.1:3021/v1/agent-inbox?status=pending",
    `http://127.0.0.1:3021/v1/agent-inbox/${inboxItem.itemId}/actions`,
  ]);
  expect(fetchImpl.mock.calls.map(([, init]) => ({ method: init?.method, body: init?.body }))).toEqual([
    { method: "POST", body: JSON.stringify(control) },
    { method: "GET", body: undefined },
    { method: "POST", body: JSON.stringify(action) },
  ]);
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  }
});

it("restart Agent Inbox 原样保留共享契约的运行前检查 409", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...restartWarningProblem, requestId: "a7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0" }), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...restartBlockedProblem, requestId: "b7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0" }), { status: 409 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const action = { actionId: "59d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "restart_run" as const };

  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, action)).rejects.toMatchObject({ kind: "api", status: 409, problem: restartWarningProblem });
  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, { ...action, actionId: "69d2bfbf-7e40-49fc-86c8-3a15d7ad4f98" })).rejects.toMatchObject({ kind: "api", status: 409, problem: restartBlockedProblem });
});

it("restart Agent Inbox 原样保留普通动作冲突 409", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(restartConflictProblem), { status: 409 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const action = { actionId: "59d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "restart_run" as const };

  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, action)).rejects.toMatchObject({ kind: "api", status: 409, problem: restartConflictProblem });
});

it("resume 仅保留账户停止白名单 409，其他上游正文降级为 502", async () => {
  const stopped = ApiProblemSchema.parse({ code: "ACCOUNT_RUN_STOPPED", message: "账户已停止全部运行，请先恢复后重试", requestId: "d7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0" });
  const unexpected = ApiProblemSchema.parse({ code: "UPSTREAM_SECRET", message: "Bearer secret", requestId: "e7a6aa9c-5cec-4681-a5f4-a017ed3ad5d0" });
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(stopped), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(unexpected), { status: 409 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const action = { actionId: "59d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "resume_run" as const };

  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, action)).rejects.toMatchObject({ kind: "api", status: 409, problem: stopped });
  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, { ...action, actionId: "69d2bfbf-7e40-49fc-86c8-3a15d7ad4f98" })).rejects.toMatchObject({ kind: "api", status: 502, problem: undefined });
});

it("restart Agent Inbox 将畸形或恶意运行前检查 409 降级为安全 502", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "RUN_PREFLIGHT_BLOCKED", message: "恶意正文", preflight: { rawPayload: "secret" } }), { status: 409 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "SOMETHING_ELSE", message: "恶意正文" }), { status: 409 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const action = { actionId: "59d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "restart_run" as const };

  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, action)).rejects.toMatchObject({ kind: "api", status: 502, problem: undefined });
  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, { ...action, actionId: "69d2bfbf-7e40-49fc-86c8-3a15d7ad4f98" })).rejects.toMatchObject({ kind: "api", status: 502, problem: undefined });
});

it("拒绝不符合控制和 Inbox 共享契约的成功 JSON", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...controlResponse, rawError: "secret" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...inboxItem, rawError: "secret" }] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...inboxActionResponse, internal: "secret" }), { status: 200 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const control = { commandId: "48d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "pause" as const };
  const action = { actionId: "59d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "resume_run" as const };

  await expect(client.controlAgentRun(sessionToken, agentRunId, control)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(client.listAgentInbox(sessionToken, "pending")).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, action)).rejects.toMatchObject({ kind: "invalid_response" });
});

it("原样打开 SSE 响应体并转发游标与下游取消信号", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    init?.signal?.addEventListener("abort", () => { void body.cancel("downstream aborted"); }, { once: true });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  });
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const abort = new AbortController();

  const response = await client.openAgentRunEventStream(sessionToken, agentRunId, {
    lastEventId: "3", afterEventId: "2", signal: abort.signal,
  });

  expect(response.body).toBe(body);
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe(`http://127.0.0.1:3021/v1/agent-runs/${agentRunId}/events?afterEventId=2`);
  expect(init?.signal).toBe(abort.signal);
  expect(new Headers(init?.headers)).toMatchObject(expect.any(Headers));
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  expect(new Headers(init?.headers).get("last-event-id")).toBe("3");
  abort.abort();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("downstream aborted"));
});

it("拒绝伪装成成功响应的非 SSE 上游流", async () => {
  const client = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
  });

  await expect(client.openAgentRunEventStream(sessionToken, agentRunId, {})).rejects.toMatchObject({ kind: "invalid_response" });
});

it("上游非 2xx 且没有响应体时返回稳定 API 错误", async () => {
  const client = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
  });

  await expect(client.openAgentRunEventStream(sessionToken, agentRunId, {})).rejects.toMatchObject({
    kind: "api",
    status: 503,
    problem: undefined,
  });
});

it("通过 bearer 读取并严格验证来源健康概览", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    targetId, watchlistVersion: 0, sources: [],
  }), { status: 200 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(client.getSourceHealth(sessionToken, targetId)).resolves.toEqual({ targetId, watchlistVersion: 0, sources: [] });
  expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:3021/v1/job-targets/${targetId}/source-health`, expect.objectContaining({ method: "GET" }));
  expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);

  fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ targetId, watchlistVersion: 0, sources: [], leaked: true }), { status: 200 }));
  await expect(client.getSourceHealth(sessionToken, targetId)).rejects.toMatchObject({ kind: "invalid_response" });
});

it("按 cursor 读取一页推荐历史，不在 BFF 抽干后续历史或排除项", async () => {
  const firstListId = "10000000-0000-4000-8000-000000000001";
  const historyItem = (recommendationListId: string, sequence: number) => ({ recommendationListId, targetId, localDate: "2026-09-01", sequence, createdAt: "2026-09-01T00:00:00.000Z", items: [], exclusions: [] });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/history?") && !url.includes("cursor=")) return Response.json({ items: [historyItem(firstListId, 2)], nextCursor: firstListId });
    throw new Error(`unexpected request ${url}`);
  });
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect(client.getRecommendationHistoryPage(sessionToken, targetId)).resolves.toEqual({
    items: [historyItem(firstListId, 2)], nextCursor: firstListId,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("账户策略客户端保留严格问题体，供 BFF 安全投影", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", message: "运行策略超过系统硬上限", requestId: "00000000-0000-4000-8000-000000000001",
    issues: [{ reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", path: ["settings", "discovery", "publicQueryLimit"], maximum: 10, suggestedAction: "reduce_to_system_hard_limit" }],
  }), { status: 400, headers: { "content-type": "application/json" } }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const command = { expectedVersion: 0, settings: systemAccountRunPolicy().effective };
  await expect(client.saveAccountRunPolicy("a".repeat(43), command)).rejects.toMatchObject({
    status: 400, problem: { code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED", issues: [expect.objectContaining({ maximum: 10 })] },
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);

  fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({
    code: "ACCOUNT_RUN_POLICY_VERSION_CONFLICT", message: "账户运行策略已在其他位置更新，请刷新后重试", requestId: "00000000-0000-4000-8000-000000000002", issues: [],
  }), { status: 409, headers: { "content-type": "application/json" } }));
  await expect(client.saveAccountRunPolicy("a".repeat(43), command)).rejects.toMatchObject({
    status: 409, problem: { code: "ACCOUNT_RUN_POLICY_VERSION_CONFLICT", issues: [] },
  });
});

it("账户全局控制客户端严格解析状态、命令和两类可公开的 409", async () => {
  const command = { commandId: "00000000-0000-4000-8000-000000000001", expectedVersion: 0, action: "stop" } as const;
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null }))
    .mockResolvedValueOnce(Response.json({ applied: true, state: { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null } }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });

  await expect((client as any).getAccountRunControl(sessionToken)).resolves.toEqual({ stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null });
  await expect((client as any).controlAccountRuns(sessionToken, command)).resolves.toEqual({ applied: true, state: { stoppedAt: "2026-09-12T00:00:00.000Z", controlVersion: 1, scheduleResumeAfter: null } });
  expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:3021/v1/account/run-policy/control", expect.objectContaining({ method: "GET" }));
  expect(fetchImpl).toHaveBeenNthCalledWith(2, "http://127.0.0.1:3021/v1/account/run-policy/controls", expect.objectContaining({ method: "POST", body: JSON.stringify(command) }));
});

it("推荐运行读取 client 分别拒绝每个 helper 的畸形成功响应", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  await expect((client as any).getRecommendationRunPreparation(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect((client as any).getLatestRecommendationRun(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect((client as any).getLatestPublishedRecommendationRun(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:3021/v1/recommendation-runs/preparation",
    "http://127.0.0.1:3021/v1/recommendation-runs/latest",
    "http://127.0.0.1:3021/v1/recommendation-runs/latest-result",
  ]);
});

it("推荐运行 client 严格验证全部新读写成功响应，并传递 bearer、路径和命令体", async () => {
  const recommendationRun = RecommendationRunSchema.parse({ runId: agentRunId, status: "queued", currentStage: "discovery", stages: ["discovery", "qualification", "coarse_ranking", "deep_matching", "result_publication"].map((key) => ({ key, status: "pending", startedAt: null, completedAt: null })), target: { targetId, targetVersion: 1, roleFamily: "后端工程师" }, sourceScope: { trustedSourceCount: 0, publicQueryCount: 0 }, accountPolicyRevisionNumber: 1, budgets: { discovery: agentRunSummary.budget, deepMatch: agentRunSummary.budget }, preflightSnapshot: { version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId, status: "ready", warningFingerprint: null, checkedAt: "2026-09-14T00:00:00.000Z", items: [] }, result: null, failure: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" });
  const preparation = RecommendationRunPreparationSchema.parse({ target: recommendationRun.target, sourceScope: recommendationRun.sourceScope, accountPolicyRevisionNumber: 1, budgets: recommendationRun.budgets, preflight: recommendationRun.preflightSnapshot });
  const list = RecommendationListSchema.parse({ recommendationListId: importId, targetId, localDate: "2026-09-14", sequence: 1, createdAt: "2026-09-14T00:00:00.000Z", exclusions: [], items: [] });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/preparation")) return Response.json({ preparation });
    if (url.endsWith("/recommendation-runs")) return Response.json({ run: recommendationRun, reused: false });
    if (url.endsWith("/latest")) return Response.json({ run: null });
    if (url.endsWith("/latest-result")) return Response.json({ run: recommendationRun });
    if (url.includes("/controls")) return Response.json({ applied: true, run: recommendationRun });
    if (url.includes(`/recommendations/lists/${importId}`)) return Response.json(list);
    if (url.endsWith(`/${agentRunId}`)) return Response.json(recommendationRun);
    throw new Error(`unexpected ${url}`);
  });
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const start = { idempotencyKey: "00000000-0000-4000-8000-000000000030", warningFingerprint: null } as const;
  const control = { commandId: "00000000-0000-4000-8000-000000000031", action: "resume" } as const;
  await expect((client as any).getRecommendationRunPreparation(sessionToken)).resolves.toEqual(preparation);
  await expect((client as any).startRecommendationRun(sessionToken, start)).resolves.toEqual({ run: recommendationRun, reused: false });
  await expect((client as any).getLatestRecommendationRun(sessionToken)).resolves.toBeNull();
  await expect((client as any).getLatestPublishedRecommendationRun(sessionToken)).resolves.toEqual(recommendationRun);
  await expect((client as any).getRecommendationRun(sessionToken, agentRunId)).resolves.toEqual(recommendationRun);
  await expect((client as any).controlRecommendationRun(sessionToken, agentRunId, control)).resolves.toEqual({ applied: true, run: recommendationRun });
  await expect((client as any).getRecommendationList(sessionToken, targetId, importId)).resolves.toEqual(list);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:3021/v1/recommendation-runs/preparation", "http://127.0.0.1:3021/v1/recommendation-runs", "http://127.0.0.1:3021/v1/recommendation-runs/latest", "http://127.0.0.1:3021/v1/recommendation-runs/latest-result", `http://127.0.0.1:3021/v1/recommendation-runs/${agentRunId}`, `http://127.0.0.1:3021/v1/recommendation-runs/${agentRunId}/controls`, `http://127.0.0.1:3021/v1/recommendations/lists/${importId}?targetId=${targetId}`,
  ]);
  for (const [, init] of fetchImpl.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  expect(fetchImpl.mock.calls[1]![1]?.body).toBe(JSON.stringify(start)); expect(fetchImpl.mock.calls[5]![1]?.body).toBe(JSON.stringify(control));
});

it("推荐运行写入和精确读取 client 分别拒绝畸形成功响应", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ unexpected: true }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const start = { idempotencyKey: "00000000-0000-4000-8000-000000000030", warningFingerprint: null } as const; const control = { commandId: "00000000-0000-4000-8000-000000000031", action: "resume" } as const;
  await expect((client as any).startRecommendationRun(sessionToken, start)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect((client as any).getRecommendationRun(sessionToken, agentRunId)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect((client as any).controlRecommendationRun(sessionToken, agentRunId, control)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect((client as any).getRecommendationList(sessionToken, targetId, importId)).rejects.toMatchObject({ kind: "invalid_response" });
});

it("推荐运行 client 将合法恶意预检和有限冲突重建为安全问题，畸形冲突降级 502", async () => {
  const sentinel = "Bearer secret-sentinel";
  const blocked = { code: "RUN_PREFLIGHT_BLOCKED", message: `错误 ${sentinel}`, preflight: { version: "run-preflight-v1", workflow: "recommendation", trigger: "manual", targetId: null, status: "blocked", warningFingerprint: null, checkedAt: "2026-09-14T00:00:00.000Z", items: [{ code: "PRIMARY_JOB_TARGET_MISSING", severity: "blocking", summary: `错误 ${sentinel}`, impact: `错误 ${sentinel}`, retryable: false, suggestedActions: ["review_job_targets"], evidence: { kind: "job_target", primaryTargetId: null, primaryTargetVersion: null, requestedTargetId: null, requestedTargetVersion: null, requestedTargetState: "missing", checkedAt: "2026-09-14T00:00:00.000Z" } }] } };
  const warning = { ...blocked, code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED", preflight: { ...blocked.preflight, targetId, status: "ready_with_warnings", warningFingerprint: "a".repeat(64), items: [{ code: "SOURCE_HEALTH_UNCHECKED", severity: "warning", summary: `错误 ${sentinel}`, impact: `错误 ${sentinel}`, retryable: true, suggestedActions: ["review_source_health"], evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null } }] } };
  const responses = [blocked, warning, { code: "ACCOUNT_RUN_STOPPED", message: sentinel, requestId: agentRunId }, { code: "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT", message: sentinel, requestId: agentRunId }, { code: "RECOMMENDATION_RUN_CONTROL_CONFLICT", message: sentinel, requestId: agentRunId }, { code: "UNKNOWN", message: sentinel, requestId: agentRunId }];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(responses.shift(), { status: 409 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const start = { idempotencyKey: "00000000-0000-4000-8000-000000000030", warningFingerprint: null } as const; const control = { commandId: "00000000-0000-4000-8000-000000000031", action: "resume" } as const;
  for (const expected of ["运行前检查未通过", "请确认当前运行前检查提示", "账户已停止全部运行，请先解除全局停止", "推荐运行状态已变化，请刷新后重试", "推荐运行状态已变化，请刷新后重试"]) {
    const call = expected.includes("推荐运行状态") && fetchImpl.mock.calls.length >= 4 ? (client as any).controlRecommendationRun(sessionToken, agentRunId, control) : (client as any).startRecommendationRun(sessionToken, start);
    await expect(call).rejects.toMatchObject({ status: 409, message: expected });
    await call.catch((error: Error) => expect(JSON.stringify(error)).not.toContain(sentinel));
  }
  await expect((client as any).controlRecommendationRun(sessionToken, agentRunId, control)).rejects.toMatchObject({ status: 502 });
});

it("control client 分别处理停止、命令冲突、未知 code 与畸形 409", async () => {
  const responses: Array<Response> = [
    Response.json({ code: "ACCOUNT_RUN_STOPPED", message: "Bearer secret", requestId: agentRunId }, { status: 409 }),
    Response.json({ code: "RECOMMENDATION_RUN_COMMAND_ID_CONFLICT", message: "Bearer secret", requestId: agentRunId }, { status: 409 }),
    Response.json({ code: "UNKNOWN", message: "Bearer secret", requestId: agentRunId }, { status: 409 }),
    Response.json({ nope: true }, { status: 409 }),
  ];
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!) });
  const control = { commandId: "00000000-0000-4000-8000-000000000031", action: "resume" } as const;
  await expect((client as any).controlRecommendationRun(sessionToken, agentRunId, control)).rejects.toMatchObject({ status: 409, message: "账户已停止全部运行，请先解除全局停止" });
  await expect((client as any).controlRecommendationRun(sessionToken, agentRunId, control)).rejects.toMatchObject({ status: 409, message: "推荐运行状态已变化，请刷新后重试" });
  await expect((client as any).controlRecommendationRun(sessionToken, agentRunId, control)).rejects.toMatchObject({ status: 502 });
  await expect((client as any).controlRecommendationRun(sessionToken, agentRunId, control)).rejects.toMatchObject({ status: 502 });
});

it("start client 分别将未知 code 与畸形 409 降级为 502", async () => {
  const responses: Array<Response> = [Response.json({ code: "UNKNOWN", message: "Bearer secret", requestId: agentRunId }, { status: 409 }), Response.json({ nope: true }, { status: 409 })];
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!) });
  const start = { idempotencyKey: "00000000-0000-4000-8000-000000000030", warningFingerprint: null } as const;
  await expect((client as any).startRecommendationRun(sessionToken, start)).rejects.toMatchObject({ status: 502 });
  await expect((client as any).startRecommendationRun(sessionToken, start)).rejects.toMatchObject({ status: 502 });
});

it("推荐运行读 client 分别保留 401，get 与 exact-list 保留 404", async () => {
  const unavailable = () => createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: "AUTH_REQUIRED", message: "需要有效会话", requestId: agentRunId }, { status: 401 })) });
  await expect((unavailable() as any).getRecommendationRunPreparation(sessionToken)).rejects.toMatchObject({ status: 401 });
  await expect((unavailable() as any).getLatestRecommendationRun(sessionToken)).rejects.toMatchObject({ status: 401 });
  await expect((unavailable() as any).getLatestPublishedRecommendationRun(sessionToken)).rejects.toMatchObject({ status: 401 });
  await expect((unavailable() as any).getRecommendationRun(sessionToken, agentRunId)).rejects.toMatchObject({ status: 401 });
  await expect((unavailable() as any).getRecommendationList(sessionToken, targetId, importId)).rejects.toMatchObject({ status: 401 });
  const missing = () => createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: "RECOMMENDATION_RUN_NOT_FOUND", message: "推荐运行不存在", requestId: agentRunId }, { status: 404 })) });
  await expect((missing() as any).getRecommendationRun(sessionToken, agentRunId)).rejects.toMatchObject({ status: 404 });
  await expect((missing() as any).getRecommendationList(sessionToken, targetId, importId)).rejects.toMatchObject({ status: 404 });
});
