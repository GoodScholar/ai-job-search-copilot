import { expect, it, vi } from "vitest";
import type { JobTargetOverview } from "@job-copilot/contracts/job-targets";
import type { JobImportDetail } from "@job-copilot/contracts/job-imports";

vi.mock("server-only", () => ({}));

import { createApiClient } from "./api-client";

const sessionToken = "a".repeat(43);
const userId = "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3";
const importId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const documentId = "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";
const conflictId = "c4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";
const targetId = "4f8c6eb3-2b92-4d91-aad4-959b7d4cd7a3";
const jobImportId = "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";

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

it("拒绝不符合岗位导入契约的成功响应", async () => {
  const api = createApiClient({
    apiInternalUrl: "http://127.0.0.1:3021",
    devAuthSharedSecret: "secret",
    fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ imports: [{ unknown: true }] }), { status: 200 })),
  });

  await expect(api.listJobImports(sessionToken)).rejects.toMatchObject({ kind: "invalid_response" });
});
