import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AnySearchPublicJobAdapter,
  preflightAnySearchCandidate,
  type AnySearchCandidate,
  type AnySearchBeforeRequest,
  type AnySearchOperationResult,
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

type SearchData = { queryId: string; ordinal: number; candidates: readonly { normalizedUrl: string | null; policy: "accepted" | "rejected"; candidate?: AnySearchCandidate }[] };
function mustSearchData(result: AnySearchOperationResult<SearchData>): SearchData {
  if (!result.ok || !("data" in result)) throw new Error("fixture search should succeed");
  return result.data;
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

  it("每次 search 与 extract 只使用本次调用传入的 checkpoint，不与并发调用串线", async () => {
    const transport = vi.fn(async (url: RequestInfo | URL) => jsonResponse((url as URL).pathname === "/v1/search" ? validSearch() : validExtract()));
    const adapter = testAdapter({ transport });
    const searchCheckpoint = vi.fn<AnySearchBeforeRequest>(async (): Promise<"proceed"> => "proceed");
    const extractCheckpoint = vi.fn<AnySearchBeforeRequest>(async (): Promise<"proceed"> => "proceed");

    const searched = await adapter.search(searchInput(), searchCheckpoint);
    const candidate = mustSearchData(searched).candidates[0]?.candidate;
    if (!candidate) throw new Error("fixture candidate should be accepted");
    await expect(adapter.extract({ candidate, identity: leadId }, extractCheckpoint)).resolves.toMatchObject({ ok: true });
    expect(searchCheckpoint.mock.calls.map(([operation]) => operation.kind)).toEqual(["search"]);
    expect(extractCheckpoint.mock.calls.map(([operation]) => operation.kind)).toEqual(["extract"]);
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
    const hook = vi.fn<AnySearchBeforeRequest>(async (): Promise<"proceed"> => "proceed");
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
      expect.objectContaining({ kind: "search", queryId, operationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ kind: "search", queryId: "018f2d4e-75a1-8f64-bc1d-0123456789a1", operationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ kind: "search", queryId: "018f2d4e-75a1-8f64-bc1d-0123456789a2", operationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ kind: "search", queryId: "018f2d4e-75a1-8f64-bc1d-0123456789a3", operationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.objectContaining({ kind: "search", queryId: "018f2d4e-75a1-8f64-bc1d-0123456789a4", operationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    ]);
    releases.reverse().forEach((release) => release());
    const results = await batch;
    expect(results.map((result) => result.ok && "data" in result ? result.data.queryId : result.ok ? "replay" : result.error.code)).toEqual([
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
    const hook = vi.fn<AnySearchBeforeRequest>(async (): Promise<"proceed"> => "proceed");
    const adapter = testAdapter({ transport, beforeRequest: hook });
    const searched = await adapter.search(searchInput());
    const candidate = mustSearchData(searched).candidates[0]?.candidate;
    if (!candidate) throw new Error("fixture candidate should be accepted");
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.allowedSiteDomains)).toBe(true);

    const forged = { ...candidate, queryId: "018f2d4e-75a1-8f64-bc1d-0123456789ae" } as AnySearchCandidate;
    await expect(adapter.extract({ candidate: forged, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(transport).toHaveBeenCalledTimes(1);

    const result = await adapter.extract({ candidate, identity: leadId });
    expect(result).toEqual({ ok: true, data: { normalizedUrl: "https://jobs.example.com/opening?jobId=abc-123", content: "untrusted extract text" } });
    const extractCall = transport.mock.calls[1]!;
    expect(String(extractCall[0])).toBe("https://anysearch.test/v1/extract");
    expect(JSON.parse(String(extractCall[1]?.body))).toEqual({ url: "https://jobs.example.com/opening?jobId=abc-123" });
    expect(hook.mock.calls[0]?.[0]).toMatchObject({ kind: "search", queryId, operationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(hook.mock.calls[1]?.[0]).toMatchObject({ kind: "extract", identity: leadId });

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
    const candidate = mustSearchData(searched).candidates[0]?.candidate;
    if (!candidate) throw new Error("fixture search should succeed");

    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_INVALID_RESPONSE", retryable: false, httpStatus: null } });
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
    const stopped = testAdapter({ transport: stoppedTransport, beforeRequest: async () => "blocked" as const });
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

  it("rejects an unapproved serialized recovery but accepts explicit opaque recovery authorization", async () => {
    const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search" ? jsonResponse(validSearch("https://jobs.example.com/opening?position_id=two&jobId=one")) : jsonResponse(validExtract()));
    const first = testAdapter({ transport });
    const fromFirst = await first.search(searchInput());
    const initialCandidate = mustSearchData(fromFirst).candidates[0]?.candidate;
    if (!initialCandidate) throw new Error("fixture candidate should be accepted");
    const recovered = JSON.parse(JSON.stringify(initialCandidate));
    const second = testAdapter({ transport });
    await expect(second.extract({ candidate: recovered, identity: "018f2d4e-75a1-8f64-bc1d-0123456789ad" })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });

    const authorized = testAdapter({
      transport,
      authorizeRecoveredCandidate: async ({ queryId: recoveredQueryId, candidateFingerprint, identity, operationIdentity }) => (
        recoveredQueryId === queryId && candidateFingerprint === recovered.candidateFingerprint && identity === "018f2d4e-75a1-8f64-bc1d-0123456789ad" && /^[a-f0-9]{64}$/u.test(operationIdentity)
      ),
      beforeRequest: async (): Promise<"proceed"> => "proceed",
    });
    await expect(authorized.extract({ candidate: recovered, identity: "018f2d4e-75a1-8f64-bc1d-0123456789ad" })).resolves.toMatchObject({ ok: true, data: { normalizedUrl: recovered.normalizedUrl } });

    const duplicate = await first.search(searchInput({ queryId: "018f2d4e-75a1-8f64-bc1d-0123456789ae", stableFingerprint: "b".repeat(64) }));
    expect(duplicate).toMatchObject({ ok: true, data: { candidates: [{ policy: "accepted" }] } });
  });

  it("keeps false and abort hooks unclaimed, while rethrowing workflow control errors", async () => {
    const transport = vi.fn(async () => jsonResponse(validSearch()));
    const stopped = testAdapter({ transport, beforeRequest: async () => "blocked" as const });
    await expect(stopped.search(searchInput())).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_CANCELLED", retryable: false, httpStatus: null } });
    expect(transport).not.toHaveBeenCalled();
    const control = new Error("BUDGET_EXHAUSTED");
    const throws = testAdapter({ transport, beforeRequest: () => { throw control; } });
    await expect(throws.search(searchInput())).rejects.toBe(control);
  });

  it("does not consume an extract claim when its hook stops or aborts before POST", async () => {
    let stop = true;
    const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search" ? jsonResponse(validSearch()) : jsonResponse(validExtract()));
    const adapter = testAdapter({ transport, beforeRequest: async (context) => context.kind === "extract" && stop ? "blocked" as const : "proceed" as const });
    const searched = await adapter.search(searchInput());
    const candidate = mustSearchData(searched).candidates[0]?.candidate;
    if (!candidate) throw new Error("fixture candidate should be accepted");
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toMatchObject({ ok: false, error: { code: "ANYSEARCH_CANCELLED" } });
    expect(transport).toHaveBeenCalledTimes(1);
    stop = false;
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toMatchObject({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);

    const another = testAdapter({ transport });
    const anotherSearch = await another.search(searchInput({ queryId: "018f2d4e-75a1-8f64-bc1d-0123456789af", stableFingerprint: "c".repeat(64) }));
    const anotherCandidate = mustSearchData(anotherSearch).candidates[0]?.candidate;
    if (!anotherCandidate) throw new Error("second fixture candidate should be accepted");
    const aborted = new AbortController();
    aborted.abort();
    await expect(another.extract({ candidate: anotherCandidate, identity: leadId, signal: aborted.signal })).resolves.toMatchObject({ ok: false, error: { code: "ANYSEARCH_CANCELLED" } });
    await expect(another.extract({ candidate: anotherCandidate, identity: leadId })).resolves.toMatchObject({ ok: true });
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
    const candidate = mustSearchData(searched).candidates[0]?.candidate;
    if (!candidate) throw new Error("fixture candidate should be accepted");
    await expect(testAdapter({ transport }).extract({ candidate, identity: "raw-user-id" })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
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

  it("uses manual no-follow redirect mode and releases streams for status and oversized response failures", async () => {
    let init: RequestInit | undefined;
    let statusCancelled = false;
    const statusBody = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { statusCancelled = true; } });
    await expect(testAdapter({ transport: async (_url, request) => { init = request; return new Response(statusBody, { status: 429 }); } }).search(searchInput())).resolves.toMatchObject({ ok: false, error: { code: "ANYSEARCH_RATE_LIMITED" } });
    expect(init?.redirect).toBe("manual");
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

  it("canonicalizes hostname aliases before URL length and candidate fingerprinting", () => {
    const alias = preflightAnySearchCandidate({ url: "https://JOBS.EXAMPLE.COM.:443/path?job=1", allowedSiteDomains: ["EXAMPLE.COM."] });
    const canonical = preflightAnySearchCandidate({ url: "https://jobs.example.com/path?job=1", allowedSiteDomains: ["example.com"] });
    expect(alias).toMatchObject({ ok: true, data: { normalizedUrl: "https://jobs.example.com/path?job=1", allowedSiteDomains: ["example.com"] } });
    expect(alias).toEqual(canonical);

    const exact = `https://jobs.example.com/${"a".repeat(2_048 - "https://jobs.example.com/".length)}`;
    const tooLong = `https://jobs.example.com/${"a".repeat(2_049 - "https://jobs.example.com/".length)}`;
    const longerBeforeNormalization = `${exact}#${"x".repeat(20)}`;
    expect(preflightAnySearchCandidate({ url: exact, allowedSiteDomains: [] }).ok).toBe(true);
    expect(preflightAnySearchCandidate({ url: tooLong, allowedSiteDomains: [] }).ok).toBe(false);
    expect(preflightAnySearchCandidate({ url: longerBeforeNormalization, allowedSiteDomains: [] })).toMatchObject({ ok: true, data: { normalizedUrl: exact } });
  });

  it.each(["_jobs.example.com", "jobs..example.com", "-jobs.example.com", "jobs-.example.com", "co.uk"])("rejects invalid or public-suffix allowed domains: %s", async (domain) => {
    const transport = vi.fn();
    await expect(testAdapter({ transport }).search(searchInput({ allowedSiteDomains: [domain] }))).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(preflightAnySearchCandidate({ url: "https://jobs.example.com/path?job=1", allowedSiteDomains: [domain] })).toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps replayed search stable and resolves batch duplicates by input then result ordinal", async () => {
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      return jsonResponse({ ...validSearch("https://jobs.example.com/shared?job=1") as object, data: { results: [
        { url: "https://jobs.example.com/shared?job=1", title: "Shared", content: "x" },
        { url: `https://jobs.example.com/${body.query}?job=2`, title: "Unique", snippet: "x" },
      ] } });
    });
    const adapter = testAdapter({ transport });
    const once = await adapter.search(searchInput({ kind: "general", allowedSiteDomains: [], query: "one" }));
    const replay = await adapter.search(searchInput({ kind: "general", allowedSiteDomains: [], query: "one" }));
    expect(replay).toEqual(once);

    const batch = await adapter.searchBatch([
      searchInput({ kind: "general", allowedSiteDomains: [], query: "first", ordinal: 1 }),
      searchInput({ kind: "general", allowedSiteDomains: [], query: "second", ordinal: 2, queryId: "018f2d4e-75a1-8f64-bc1d-0123456789ae", stableFingerprint: "b".repeat(64) }),
    ]);
    expect(batch).toMatchObject([
      { ok: true, data: { candidates: [{ policy: "accepted" }, { policy: "accepted" }] } },
      { ok: true, data: { candidates: [{ policy: "rejected" }, { policy: "accepted" }] } },
    ]);
  });

  it("issues only the deterministic batch winner, never a reconstructable loser", async () => {
    const sharedUrl = "https://jobs.example.com/shared?job=1";
    const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search" ? jsonResponse(validSearch(sharedUrl)) : jsonResponse(validExtract(sharedUrl)));
    const hook = vi.fn(async (): Promise<"proceed"> => "proceed");
    const adapter = testAdapter({ transport, beforeRequest: hook });
    const batch = await adapter.searchBatch([
      searchInput({ kind: "general", allowedSiteDomains: [], ordinal: 1 }),
      searchInput({ kind: "general", allowedSiteDomains: [], ordinal: 2, queryId: "018f2d4e-75a1-8f64-bc1d-0123456789ae", stableFingerprint: "b".repeat(64) }),
    ]);
    const winner = batch[0];
    const loser = batch[1];
    if (!winner?.ok || !("data" in winner) || !winner.data.candidates[0]?.candidate || !loser?.ok || !("data" in loser)) throw new Error("fixture batch should produce one accepted and one rejected candidate");
    expect(loser.data.candidates[0]).toEqual({ normalizedUrl: sharedUrl, policy: "rejected" });
    const reconstructed: AnySearchCandidate = {
      kind: "anysearch_public_job_candidate",
      normalizedUrl: sharedUrl,
      allowedSiteDomains: [],
      queryId: loser.data.queryId,
      candidateFingerprint: createHash("sha256").update(sharedUrl, "utf8").digest("hex"),
    };
    await expect(adapter.extract({ candidate: reconstructed, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(adapter.extract({ candidate: winner.data.candidates[0].candidate, identity: leadId })).resolves.toMatchObject({ ok: true, data: { normalizedUrl: sharedUrl } });
  });

  it("keeps batch winner authorization stable when response completion order is reversed", async () => {
    const run = async (completionOrder: readonly number[]) => {
      const releases: Array<() => void> = [];
      const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search"
        ? new Promise<Response>((resolve) => releases.push(() => resolve(jsonResponse(validSearch("https://jobs.example.com/shared?job=1")))))
        : jsonResponse(validExtract("https://jobs.example.com/shared?job=1")));
      const adapter = testAdapter({ transport });
      const pending = adapter.searchBatch([
        searchInput({ kind: "general", allowedSiteDomains: [], ordinal: 1 }),
        searchInput({ kind: "general", allowedSiteDomains: [], ordinal: 2, queryId: "018f2d4e-75a1-8f64-bc1d-0123456789ae", stableFingerprint: "b".repeat(64) }),
      ]);
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      completionOrder.forEach((index) => releases[index]!());
      const results = await pending;
      const winner = results[0];
      const loser = results[1];
      if (!winner?.ok || !("data" in winner) || !winner.data.candidates[0]?.candidate || !loser?.ok || !("data" in loser)) throw new Error("fixture batch should have a deterministic winner");
      const loserCandidate: AnySearchCandidate = { ...winner.data.candidates[0].candidate, queryId: loser.data.queryId };
      await expect(adapter.extract({ candidate: loserCandidate, identity: leadId })).resolves.toMatchObject({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED" } });
      await expect(adapter.extract({ candidate: winner.data.candidates[0].candidate, identity: leadId })).resolves.toMatchObject({ ok: true });
      return results;
    };
    expect(await run([0, 1])).toMatchObject(await run([1, 0]));
  });

  it.each(["github.io", "blogspot.com", "vercel.app", "pages.dev", "foo.invalid", "foo.test", "foo.example", "foo.onion", "home.arpa", "resolver.arpa", "ipv4only.arpa", "example.arpa", "jobs.example.arpa"])("rejects non-public v4 candidate and allowlist host before network: %s", async (host) => {
    const transport = vi.fn();
    expect(preflightAnySearchCandidate({ url: `https://${host}/job?job=1`, allowedSiteDomains: [] })).toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    await expect(testAdapter({ transport }).search(searchInput({ allowedSiteDomains: [host] }))).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["jobs.github.io", "jobs.blogspot.com", "jobs.vercel.app", "jobs.pages.dev"])("allows a private-PSL tenant as a precise v4 candidate host: %s", (host) => {
    expect(preflightAnySearchCandidate({ url: `https://${host}/job?job=1`, allowedSiteDomains: [host] })).toMatchObject({ ok: true, data: { normalizedUrl: `https://${host}/job?job=1` } });
  });

  it("uses explicit durable decisions and rolls back only blocked or thrown extract claims", async () => {
    let decision: "proceed" | "already_completed" | "blocked" = "proceed";
    const hook = vi.fn(async () => decision);
    const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search" ? jsonResponse(validSearch()) : jsonResponse(validExtract()));
    const adapter = testAdapter({ transport, beforeRequest: hook });
    const searched = await adapter.search(searchInput());
    if (!searched.ok || !("data" in searched) || !searched.data.candidates[0]?.candidate) throw new Error("fixture candidate should be accepted");
    const candidate = searched.data.candidates[0].candidate;

    decision = "blocked";
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_CANCELLED", retryable: false, httpStatus: null } });
    decision = "proceed";
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toMatchObject({ ok: true, data: { normalizedUrl: candidate.normalizedUrl } });
    const hooksAfterProceed = hook.mock.calls.length;
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(hook).toHaveBeenCalledTimes(hooksAfterProceed);

    const replayAdapter = testAdapter({ transport, beforeRequest: async (): Promise<"already_completed"> => "already_completed" });
    await expect(replayAdapter.search(searchInput())).resolves.toMatchObject({ ok: true, replay: { operationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("rolls back a throwing extract decision and consumes an authorized completed recovery without a second hook", async () => {
    let throwExtract = true;
    const control = new Error("CHECKPOINT_CONFLICT");
    const transport = vi.fn(async (url: RequestInfo | URL) => (url as URL).pathname === "/v1/search" ? jsonResponse(validSearch()) : jsonResponse(validExtract()));
    const adapter = testAdapter({ transport, beforeRequest: (input) => {
      if (input.kind === "extract" && throwExtract) throw control;
      return "proceed";
    } });
    const searched = await adapter.search(searchInput());
    const candidate = mustSearchData(searched).candidates[0]?.candidate;
    if (!candidate) throw new Error("fixture candidate should be accepted");
    await expect(adapter.extract({ candidate, identity: leadId })).rejects.toBe(control);
    throwExtract = false;
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toMatchObject({ ok: true, data: { normalizedUrl: candidate.normalizedUrl } });

    const recovered = JSON.parse(JSON.stringify(candidate));
    const replayHook = vi.fn(async (): Promise<"already_completed"> => "already_completed");
    const recoveredAdapter = testAdapter({
      transport,
      beforeRequest: replayHook,
      authorizeRecoveredCandidate: () => true,
    });
    const replay = await recoveredAdapter.extract({ candidate: recovered, identity: "018f2d4e-75a1-8f64-bc1d-0123456789ad" });
    expect(replay).toEqual({ ok: true, replay: { operationIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    const hookCalls = replayHook.mock.calls.length;
    await expect(recoveredAdapter.extract({ candidate: recovered, identity: "018f2d4e-75a1-8f64-bc1d-0123456789ad" })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    expect(replayHook).toHaveBeenCalledTimes(hookCalls);
  });

  it("treats caller identity as an opaque physical extract attempt identity", async () => {
    let extractCalls = 0;
    const transport = vi.fn(async (url: RequestInfo | URL) => {
      if ((url as URL).pathname === "/v1/search") return jsonResponse(validSearch());
      extractCalls += 1;
      return extractCalls === 1 ? jsonResponse({ message: "temporary" }, 503) : jsonResponse(validExtract());
    });
    const adapter = testAdapter({ transport });
    const searched = await adapter.search(searchInput());
    const candidate = mustSearchData(searched).candidates[0]?.candidate;
    if (!candidate) throw new Error("fixture candidate should be accepted");
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_UNAVAILABLE", retryable: true, httpStatus: 503 } });
    await expect(adapter.extract({ candidate, identity: leadId })).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
    await expect(adapter.extract({ candidate, identity: "018f2d4e-75a1-8f64-bc1d-0123456789ad" })).resolves.toMatchObject({ ok: true, data: { normalizedUrl: candidate.normalizedUrl } });
    expect(extractCalls).toBe(2);
  });

  it("uses manual redirect policy and never posts to a 307 destination", async () => {
    let destinationPosts = 0;
    const destination = createServer((_request, response) => { destinationPosts += 1; response.end(); });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const destinationPort = (destination.address() as { port: number }).port;
    const source = createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${destinationPort}/capture` });
      response.end("untrusted redirect body");
    });
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    const sourcePort = (source.address() as { port: number }).port;
    try {
      await expect(testAdapter({ baseUrl: `http://127.0.0.1:${sourcePort}` }).search(searchInput())).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_POLICY_REJECTED", retryable: false, httpStatus: null } });
      expect(destinationPosts).toBe(0);
    } finally {
      await Promise.all([new Promise<void>((resolve) => source.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]);
    }
  });

  it("cancels and releases the reader on JSON parse failure", async () => {
    const reader = {
      read: vi.fn(async () => ({ done: false, value: new TextEncoder().encode("{") })).mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("{") }).mockResolvedValueOnce({ done: true, value: new Uint8Array() }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const response = { status: 200, body: { getReader: () => reader } } as unknown as Response;
    await expect(testAdapter({ transport: async () => response }).search(searchInput())).resolves.toEqual({ ok: false, error: { code: "ANYSEARCH_INVALID_RESPONSE", retryable: false, httpStatus: null } });
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });
});
