import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createApiClient } from "./api-client";

const sessionToken = "a".repeat(43);
const userId = "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3";

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
