import { expect, it, vi } from "vitest";
import type { JobTargetOverview } from "@job-copilot/contracts/job-targets";
import type { JobImportDetail } from "@job-copilot/contracts/job-imports";
import type {
  AgentRunDetail,
  ControlAgentRunResponse,
  StartAgentRunResponse,
} from "@job-copilot/contracts/agent-runs";
import type { AgentInboxActionResponse, AgentInboxItem } from "@job-copilot/contracts/agent-inbox";

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
  targetSnapshot: { targetId, version: 1, priority: "primary", state: "active", constraints: jobTargetOverview.targets[0].constraints },
  sourceScope: {
    kind: "company_watchlist", adapter: "fake", adapterVersion: "fake-job-discovery-v1",
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
  status: "open",
  reasonCode: "AGENT_RUN_PAUSED",
  budgetDimension: null,
  title: "岗位发现已暂停",
  message: "选择继续或取消本次岗位发现。",
  availableActions: ["resume_run", "cancel_run"],
  targetHref: null,
  createdAt: "2026-08-29T08:00:00.000Z",
  resolvedAt: null,
};

const inboxActionResponse: AgentInboxActionResponse = { applied: true, item: inboxItem, run: controlResponse.run };

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
      summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
    }), { status: 200 }),
  );
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl,
  });

  await expect(api.getWorkbenchHome(sessionToken)).resolves.toEqual({
    account: { userId },
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  });

  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:3021/v1/workbench/home");
  expect(init).toMatchObject({ method: "GET" });
  expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
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
  expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify(command) });
  for (const [, init] of fetchImpl.mock.calls) {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${sessionToken}`);
  }
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
  await expect(client.listAgentInbox(sessionToken, "open")).resolves.toEqual({ items: [inboxItem] });
  await expect(client.actOnAgentInboxItem(sessionToken, inboxItem.itemId, action)).resolves.toEqual(inboxActionResponse);

  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    `http://127.0.0.1:3021/v1/agent-runs/${agentRunId}/controls`,
    "http://127.0.0.1:3021/v1/agent-inbox?status=open",
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

it("拒绝不符合控制和 Inbox 共享契约的成功 JSON", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...controlResponse, rawError: "secret" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...inboxItem, rawError: "secret" }] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...inboxActionResponse, internal: "secret" }), { status: 200 }));
  const client = createApiClient({ apiInternalUrl: "http://127.0.0.1:3021", devAuthSharedSecret: "secret", fetchImpl });
  const control = { commandId: "48d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "pause" as const };
  const action = { actionId: "59d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", action: "resume_run" as const };

  await expect(client.controlAgentRun(sessionToken, agentRunId, control)).rejects.toMatchObject({ kind: "invalid_response" });
  await expect(client.listAgentInbox(sessionToken, "open")).rejects.toMatchObject({ kind: "invalid_response" });
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
