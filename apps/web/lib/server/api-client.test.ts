import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createApiClient } from "./api-client";

const sessionToken = "a".repeat(43);
const userId = "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3";
const importId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const documentId = "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a";

const queuedImport = {
  importId,
  documentId,
  sourceFilename: "career.md",
  privacyStatus: "sanitized_only",
  status: "queued",
  failureCode: null,
  createdAt: "2026-08-27T08:00:00.000Z",
  updatedAt: "2026-08-27T08:00:00.000Z",
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
