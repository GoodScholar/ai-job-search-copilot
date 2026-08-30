import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AnySearchPublicJobAdapter,
  preflightAnySearchCandidate,
  type AnySearchCandidate,
} from "./anysearch-public-job-adapter.js";

const secretKey = "test-anysearch-key-must-not-leak";
const queryId = "018f2d4e-75a1-8f64-bc1d-0123456789ab";
const leadId = "018f2d4e-75a1-8f64-bc1d-0123456789ac";
const previousAppEnv = process.env.APP_ENV;

function searchInput(overrides: Partial<{ queryId: string; ordinal: number; kind: "general" | "site_constrained" | "target_company"; stableFingerprint: string; query: string; allowedSiteDomains: readonly string[]; targetCompanyNames: readonly string[]; resultLimit: 5; signal: AbortSignal }> = {}) {
  return {
    queryId,
    ordinal: 1,
    kind: "site_constrained" as const,
    stableFingerprint: "a".repeat(64),
    query: "高级前端工程师 site:example.com",
    allowedSiteDomains: ["example.com"],
    targetCompanyNames: [],
    resultLimit: 5 as const,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function validSearch(url = "https://jobs.example.com/opening?jobId=abc-123"): unknown {
  return {
    code: 0,
    message: "success",
    request_id: "request-1",
    data: { results: [{ url, title: "Senior Engineer", content: "untrusted provider text" }] },
  };
}

function validExtract(url = "https://jobs.example.com/opening?jobId=abc-123"): unknown {
  return {
    code: 0,
    message: "success",
    request_id: "request-2",
    data: { url, title: "Senior Engineer", content: "untrusted extract text" },
  };
}

function testAdapter(input: ConstructorParameters<typeof AnySearchPublicJobAdapter>[0] = {}) {
  return new AnySearchPublicJobAdapter({ apiKey: secretKey, baseUrl: "https://anysearch.test", ...input });
}

beforeAll(() => { process.env.APP_ENV = "test"; });
afterAll(() => {
  if (previousAppEnv === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = previousAppEnv;
});
afterEach(() => vi.useRealTimers());

describe("AnySearchPublicJobAdapter", () => {
  it("fails closed without a key and never makes an anonymous request", async () => {
    const transport = vi.fn();
    const adapter = new AnySearchPublicJobAdapter({ apiKey: "   ", baseUrl: "https://anysearch.test", transport });

    const result = await adapter.search(searchInput());

    expect(result).toEqual({ ok: false, error: { code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, httpStatus: null } });
    expect(transport).not.toHaveBeenCalled();
  });

  it("sends the exact allowed search facts and keeps domain policy local", async () => {
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => jsonResponse(validSearch()));
    const adapter = testAdapter({ transport });

    const result = await adapter.search(searchInput({ allowedSiteDomains: ["example.com", "jobs.example.com"] }));

    expect(result).toMatchObject({ ok: true, data: { queryId, candidates: [{ normalizedUrl: "https://jobs.example.com/opening?jobId=abc-123", policy: "accepted" }] } });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toBe("https://anysearch.test/v1/search");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${secretKey}`, "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ query: "高级前端工程师 site:example.com", max_results: 5 });
    expect(JSON.stringify(init?.body)).not.toMatch(/allowedSiteDomains|domain|host|target|profile|watchlist|user/i);
  });

  it("executes up to five independent searches with independent hooks, ordered partial results, and no sixth request", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const body = JSON.parse(String(init?.body)) as { query: string };
      releases.push(() => {
        inFlight -= 1;
        if (body.query === "query-3") resolve(jsonResponse({ message: "not used", data: { nested: { api_key: "bad" } } }, 429));
        else resolve(jsonResponse(validSearch(`https://jobs.example.com/${body.query}?job_id=${body.query}`)));
      });
    }));
    const hook = vi.fn(async (_context: { kind: "search"; queryId: string } | { kind: "extract"; identity: string; candidateFingerprint: string }) => undefined);
    const adapter = testAdapter({ transport, beforeRequest: hook });
    const batch = adapter.searchBatch(Array.from({ length: 5 }, (_value, index) => searchInput({
      queryId: index === 0 ? queryId : `018f2d4e-75a1-8f64-bc1d-0123456789a${index}`,
      ordinal: index + 1,
      query: `query-${index + 1}`,
      kind: "general",
      allowedSiteDomains: [],
    })));

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(5));
    expect(peak).toBeLessThanOrEqual(5);
    expect(hook).toHaveBeenCalledTimes(5);
    expect(hook.mock.calls.map(([context]) => context)).toEqual([
      { kind: "search", queryId },
      { kind: "search", queryId: "018f2d4e-75a1-8f64-bc1d-0123456789a1" },
      { kind: "search", queryId: "018f2d4e-75a1-8f64-bc1d-0123456789a2" },
      { kind: "search", queryId: "018f2d4e-75a1-8f64-bc1d-0123456789a3" },
      { kind: "search", queryId: "018f2d4e-75a1-8f64-bc1d-0123456789a4" },
    ]);
    releases.reverse().forEach((release) => release());
    const results = await batch;
    expect(results.map((result) => result.ok ? result.data.queryId : result.error.code)).toEqual([
      queryId,
      "018f2d4e-75a1-8f64-bc1d-0123456789a1",
      "ANYSEARCH_RATE_LIMITED",
      "018f2d4e-75a1-8f64-bc1d-0123456789a3",
      "018f2d4e-75a1-8f64-bc1d-0123456789a4",
    ]);
    await expect(adapter.searchBatch(Array.from({ length: 6 }, () => searchInput()))).resolves.toEqual([
      { ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } },
    ]);
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it("extracts only a locally preflighted candidate and rejects forged or off-domain values before transport", async () => {
    const transport = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => jsonResponse((url as URL).pathname === "/v1/search" ? validSearch() : validExtract()));
    const hook = vi.fn(async (_context: { kind: "search"; queryId: string } | { kind: "extract"; identity: string; candidateFingerprint: string }) => undefined);
    const adapter = testAdapter({ transport, beforeRequest: hook });
    const searched = await adapter.search(searchInput());
    if (!searched.ok) throw new Error("fixture search should succeed");
    const candidate = searched.data.candidates[0]?.candidate;
    if (!candidate) throw new Error("fixture candidate should be accepted");

    const result = await adapter.extract({ candidate, identity: leadId });
    expect(result).toEqual({ ok: true, data: { normalizedUrl: "https://jobs.example.com/opening?jobId=abc-123", content: "untrusted extract text" } });
    const extractCall = transport.mock.calls[1]!;
    expect(String(extractCall[0])).toBe("https://anysearch.test/v1/extract");
    expect(JSON.parse(String(extractCall[1]?.body))).toEqual({ url: "https://jobs.example.com/opening?jobId=abc-123" });
    expect(hook.mock.calls[0]?.[0]).toEqual({ kind: "search", queryId });
    expect(hook.mock.calls[1]?.[0]).toMatchObject({ kind: "extract", identity: leadId });

    const forged = { ...candidate } as AnySearchCandidate;
    await expect(adapter.extract({ candidate: forged, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    const offDomain = preflightAnySearchCandidate({ url: "https://evil-example.com/job?job=42", allowedSiteDomains: ["example.com"] });
    expect(offDomain).toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["invalid json", new Response("{", { status: 200 })],
    ["wrong envelope", jsonResponse({ code: 1, message: "ok", request_id: "r", data: {} })],
    ["missing content", jsonResponse({ code: 0, message: "ok", request_id: "r", data: { url: "https://jobs.example.com/a?job=1", title: "x" } })],
    ["wrong content", jsonResponse({ code: 0, message: "ok", request_id: "r", data: { url: "https://jobs.example.com/a?job=1", title: "x", content: 1 } })],
  ])("rejects malformed extract success: %s", async (_label, extractResponse) => {
    const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search" ? jsonResponse(validSearch()) : extractResponse);
    const adapter = testAdapter({ transport });
    const searched = await adapter.search(searchInput());
    if (!searched.ok || !searched.data.candidates[0]?.candidate) throw new Error("fixture search should succeed");

    await expect(adapter.extract({ candidate: searched.data.candidates[0].candidate, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_INVALID_RESPONSE", retryable: false, httpStatus: null } });
  });

  it("maps abort, timeout, and stopped hooks without making an unintended request", async () => {
    const before = new AbortController();
    before.abort();
    const transport = vi.fn(async () => new Promise<Response>(() => undefined));
    const adapter = testAdapter({ transport, timeoutMs: 1_000 });
    await expect(adapter.search(searchInput({ signal: before.signal }))).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_CANCELLED", retryable: false, httpStatus: null } });
    expect(transport).not.toHaveBeenCalled();

    const during = new AbortController();
    const pending = adapter.search(searchInput({ signal: during.signal }));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    during.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_CANCELLED", retryable: false, httpStatus: null } });

    await expect(testAdapter({ transport: async () => new Promise<Response>(() => undefined), timeoutMs: 10 }).search(searchInput())).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_TIMEOUT", retryable: true, httpStatus: null } });
    const stoppedTransport = vi.fn();
    const stopped = testAdapter({ transport: stoppedTransport, beforeRequest: async (): Promise<false> => false });
    await expect(stopped.search(searchInput())).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_CANCELLED", retryable: false, httpStatus: null } });
    expect(stoppedTransport).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid json", new Response("{", { status: 200 }), "ANYSEARCH_INVALID_RESPONSE", false, null],
    ["non-object", jsonResponse(null), "ANYSEARCH_INVALID_RESPONSE", false, null],
    ["wrong success code", jsonResponse({ ...validSearch() as object, code: 1 }), "ANYSEARCH_INVALID_RESPONSE", false, null],
    ["missing results", jsonResponse({ code: 0, message: "ok", request_id: "r", data: {} }), "ANYSEARCH_INVALID_RESPONSE", false, null],
    ["wrong result field", jsonResponse({ code: 0, message: "ok", request_id: "r", data: { results: [{ url: 1, title: "x", content: "y" }] } }), "ANYSEARCH_INVALID_RESPONSE", false, null],
    ["too many results", jsonResponse({ code: 0, message: "ok", request_id: "r", data: { results: Array.from({ length: 6 }, () => ({ url: "https://example.com/job?job=1", title: "x", content: "y" })) } }), "ANYSEARCH_INVALID_RESPONSE", false, null],
    ["401", jsonResponse({ message: "quota exhausted" }, 401), "ANYSEARCH_AUTH_FAILED", false, 401],
    ["403", jsonResponse({ message: "rate limited" }, 403), "ANYSEARCH_AUTH_FAILED", false, 403],
    ["402 nested credentials", jsonResponse({ message: "auth failed", payload: { nested: { username: "bad-user", password: "bad-password", api_key: "bad-key" } } }, 402), "ANYSEARCH_QUOTA_EXHAUSTED", false, 402],
    ["429 arbitrary body", jsonResponse({ message: "quota exhausted", data: { api_key: "bad-key" } }, 429), "ANYSEARCH_RATE_LIMITED", true, 429],
    ["500", jsonResponse({ message: "auth failed" }, 500), "ANYSEARCH_UNAVAILABLE", true, 500],
    ["502", jsonResponse({ message: "auth failed" }, 502), "ANYSEARCH_UNAVAILABLE", true, 502],
    ["503", jsonResponse({ message: "auth failed" }, 503), "ANYSEARCH_UNAVAILABLE", true, 503],
    ["504", jsonResponse({ message: "auth failed" }, 504), "ANYSEARCH_UNAVAILABLE", true, 504],
    ["unknown status", jsonResponse({ message: "rate limited" }, 418), "ANYSEARCH_INVALID_RESPONSE", false, null],
  ])("classifies %s strictly by status and never leaks provider data", async (_label, response, code, retryable, httpStatus) => {
    const result = await testAdapter({ transport: async () => response }).search(searchInput());
    expect(result).toEqual({ ok: false, error: { code, retryable, httpStatus } });
    expect(JSON.stringify(result)).not.toMatch(/bad-user|bad-password|bad-key|quota exhausted|rate limited|auth failed|example\.com|test-anysearch-key/u);
  });

  it.each([
    ["removes fragments, tracking, and orders identity facts", "https://jobs.example.com/path?utm_source=x&position_id=two&jobId=one#part", [], "https://jobs.example.com/path?jobId=one&position_id=two"],
    ["keeps safe job identity", "https://jobs.example.com/path?opening_id=A_B-1", [], "https://jobs.example.com/path?opening_id=A_B-1"],
  ])("normalizes candidate URLs: %s", (_label, rawUrl, allowedSiteDomains, normalizedUrl) => {
    expect(preflightAnySearchCandidate({ url: rawUrl, allowedSiteDomains })).toMatchObject({ ok: true, data: { normalizedUrl } });
  });

  it.each([
    ["credentials", "https://user:pass@jobs.example.com/path?job=1", []],
    ["http", "http://jobs.example.com/path?job=1", []],
    ["non-web scheme", "file:///tmp/job", []],
    ["encoded sensitive identity", "https://jobs.example.com/path?jobId=one%2Ftwo", []],
    ["suffix confusion", "https://evil-example.com/path?job=1", ["example.com"]],
  ])("rejects unsafe candidate URL: %s", (_label, rawUrl, allowedSiteDomains) => {
    expect(preflightAnySearchCandidate({ url: rawUrl, allowedSiteDomains })).toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
  });

  it("allows exact and dot-boundary subdomains but rejects off-domain provider results before extract", async () => {
    expect(preflightAnySearchCandidate({ url: "https://example.com/a?job=1", allowedSiteDomains: ["example.com"] })).toMatchObject({ ok: true });
    expect(preflightAnySearchCandidate({ url: "https://jobs.example.com/a?job=1", allowedSiteDomains: ["example.com"] })).toMatchObject({ ok: true });
    const transport = vi.fn(async () => jsonResponse(validSearch("https://evil-example.com/a?job=1")));
    const adapter = testAdapter({ transport });
    const result = await adapter.search(searchInput());
    expect(result).toMatchObject({ ok: true, data: { candidates: [{ policy: "rejected", normalizedUrl: "https://evil-example.com/a?job=1" }] } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://localhost/job?job=1",
    "https://sub.localhost/job?job=1",
    "https://host.local/job?job=1",
    "https://host.internal/job?job=1",
    "https://host.lan/job?job=1",
    "https://127.0.0.1/job?job=1",
    "https://[::1]/job?job=1",
    "https://10.0.0.1/job?job=1",
    "https://172.16.0.1/job?job=1",
    "https://192.168.0.1/job?job=1",
    "https://169.254.169.254/job?job=1",
    "https://2130706433/job?job=1",
  ])("rejects lexical non-public extract targets before any transport: %s", async (url) => {
    expect(preflightAnySearchCandidate({ url, allowedSiteDomains: [] })).toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
  });

  it("recovers a serializable candidate in a new adapter while preventing duplicate normalized URL claims per instance", async () => {
    const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search" ? jsonResponse(validSearch("https://jobs.example.com/opening?position_id=two&jobId=one")) : jsonResponse(validExtract()));
    const first = testAdapter({ transport });
    const fromFirst = await first.search(searchInput());
    if (!fromFirst.ok || !fromFirst.data.candidates[0]?.candidate) throw new Error("fixture candidate should be accepted");
    const recovered = JSON.parse(JSON.stringify(fromFirst.data.candidates[0].candidate));
    const second = testAdapter({ transport });
    await expect(second.extract({ candidate: recovered, identity: "018f2d4e-75a1-8f64-bc1d-0123456789ad" })).resolves.toMatchObject({ ok: true });

    const duplicate = await first.search(searchInput({ queryId: "018f2d4e-75a1-8f64-bc1d-0123456789ae", stableFingerprint: "b".repeat(64) }));
    expect(duplicate).toMatchObject({ ok: true, data: { candidates: [{ policy: "rejected" }] } });
  });

  it("keeps false and abort hooks unclaimed, while rethrowing workflow control errors", async () => {
    const transport = vi.fn(async () => jsonResponse(validSearch()));
    const stopped = testAdapter({ transport, beforeRequest: async (): Promise<false> => false });
    await expect(stopped.search(searchInput())).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_CANCELLED", retryable: false, httpStatus: null } });
    expect(transport).not.toHaveBeenCalled();
    const control = new Error("BUDGET_EXHAUSTED");
    const throws = testAdapter({ transport, beforeRequest: () => { throw control; } });
    await expect(throws.search(searchInput())).rejects.toBe(control);
  });

  it("does not consume an extract claim when its hook stops or aborts before POST", async () => {
    let stop = true;
    const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search" ? jsonResponse(validSearch()) : jsonResponse(validExtract()));
    const adapter = testAdapter({ transport, beforeRequest: async (context) => context.kind === "extract" && stop ? false : undefined });
    const searched = await adapter.search(searchInput());
    if (!searched.ok || !searched.data.candidates[0]?.candidate) throw new Error("fixture candidate should be accepted");
    await expect(adapter.extract({ candidate: searched.data.candidates[0].candidate, identity: leadId })).resolves.toMatchObject({ ok: false, error: { code: "ANYSEARCH_CANCELLED" } });
    expect(transport).toHaveBeenCalledTimes(1);
    stop = false;
    await expect(adapter.extract({ candidate: searched.data.candidates[0].candidate, identity: leadId })).resolves.toMatchObject({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);

    const another = testAdapter({ transport });
    const anotherSearch = await another.search(searchInput({ queryId: "018f2d4e-75a1-8f64-bc1d-0123456789af", stableFingerprint: "c".repeat(64) }));
    if (!anotherSearch.ok || !anotherSearch.data.candidates[0]?.candidate) throw new Error("second fixture candidate should be accepted");
    const aborted = new AbortController();
    aborted.abort();
    await expect(another.extract({ candidate: anotherSearch.data.candidates[0].candidate, identity: leadId, signal: aborted.signal })).resolves.toMatchObject({ ok: false, error: { code: "ANYSEARCH_CANCELLED" } });
    await expect(another.extract({ candidate: anotherSearch.data.candidates[0].candidate, identity: leadId })).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["invalid UUID", searchInput({ queryId: "raw-user-id" })],
    ["large ordinal", searchInput({ ordinal: 11 })],
    ["long query", searchInput({ query: "x".repeat(501) })],
    ["single-label domain", searchInput({ allowedSiteDomains: ["com"] })],
    ["domain path", searchInput({ allowedSiteDomains: ["example.com/path"] })],
  ])("rejects strict public query input before hook or network: %s", async (_label, input) => {
    const transport = vi.fn();
    const hook = vi.fn();
    await expect(testAdapter({ transport, beforeRequest: hook }).search(input)).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect({ transport: transport.mock.calls.length, hook: hook.mock.calls.length }).toEqual({ transport: 0, hook: 0 });
  });

  it("rejects malformed extract identity and invalid timeout configuration before a provider call", async () => {
    const transport = vi.fn(async () => jsonResponse(validSearch()));
    const searched = await testAdapter({ transport }).search(searchInput());
    if (!searched.ok || !searched.data.candidates[0]?.candidate) throw new Error("fixture candidate should be accepted");
    await expect(testAdapter({ transport }).extract({ candidate: searched.data.candidates[0].candidate, identity: "raw-user-id" })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(() => testAdapter({ timeoutMs: 0 })).toThrow("ANYSEARCH_TIMEOUT_INVALID");
    expect(() => testAdapter({ timeoutMs: Number.POSITIVE_INFINITY })).toThrow("ANYSEARCH_TIMEOUT_INVALID");
  });

  it.each([
    [400, "ANYSEARCH_INVALID_RESPONSE", false, 400],
    [415, "ANYSEARCH_INVALID_RESPONSE", false, 415],
    [418, "ANYSEARCH_INVALID_RESPONSE", false, null],
  ])("classifies invalid and unknown HTTP status without retry: %s", async (status, code, retryable, httpStatus) => {
    const result = await testAdapter({ transport: async () => jsonResponse({ message: "untrusted" }, status) }).search(searchInput());
    expect(result).toEqual({ ok: false, error: { code, retryable, httpStatus } });
  });

  it("uses redirect error mode and releases streams for status and oversized response failures", async () => {
    let init: RequestInit | undefined;
    let statusCancelled = false;
    const statusBody = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { statusCancelled = true; } });
    await expect(testAdapter({ transport: async (_url, request) => { init = request; return new Response(statusBody, { status: 429 }); } }).search(searchInput())).resolves.toMatchObject({ ok: false, error: { code: "ANYSEARCH_RATE_LIMITED" } });
    expect(init?.redirect).toBe("error");
    expect(statusCancelled).toBe(true);

    let oversizedCancelled = false;
    const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { oversizedCancelled = true; } });
    await expect(testAdapter({ transport: async () => new Response(oversized) }).search(searchInput())).resolves.toMatchObject({ ok: false, error: { code: "ANYSEARCH_INVALID_RESPONSE" } });
    expect(oversizedCancelled).toBe(true);
  });

  it("rejects search results with a present non-string optional text field", async () => {
    const malformed = { code: 0, message: "ok", request_id: "r", data: { results: [{ url: "https://jobs.example.com/a?job=1", title: "x", content: 1, snippet: "ok" }] } };
    await expect(testAdapter({ transport: async () => jsonResponse(malformed) }).search(searchInput())).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_INVALID_RESPONSE", retryable: false, httpStatus: null } });
  });
});
