import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicSourceAccessError, createPublicSourceClient } from "./index.js";
import { createPublicSourceClientForTest } from "./testing.js";

describe("PublicSourceClient", () => {
  let server: Server;
  let origin: string;
  let requests = 0;
  let userAgent: string | undefined;

  beforeAll(async () => {
    process.env.APP_ENV = "test";
    server = createServer((request, response) => {
      requests += 1;
      userAgent = request.headers["user-agent"];
      switch (request.url) {
        case "/html": response.writeHead(200, { "content-type": "text/html" }).end("<h1>job</h1>"); return;
        case "/json": response.writeHead(200, { "content-type": "application/json" }).end("{}"); return;
        case "/redirect": response.writeHead(302, { location: "/html" }).end(); return;
        case "/outside": response.writeHead(302, { location: "https://outside.test/html" }).end(); return;
        case "/bad-content": response.writeHead(200, { "content-type": "image/png" }).end(); return;
        case "/large": response.writeHead(200, { "content-type": "text/html" }).end(Buffer.alloc(2 * 1024 * 1024 + 1)); return;
        case "/rate-limited": response.writeHead(429, { "content-type": "text/html", "retry-after": "60" }).end(); return;
        case "/server-error": response.writeHead(500, { "content-type": "text/html" }).end(); return;
        case "/slow": setTimeout(() => response.writeHead(200, { "content-type": "text/html" }).end("slow"), 80); return;
        default: response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

  function client(overrides: Partial<Parameters<typeof createPublicSourceClientForTest>[0]> = {}) {
    return createPublicSourceClientForTest({ testOrigin: origin, exactHosts: ["127.0.0.1"], ...overrides });
  }

  it.each([
    ["http://example.test/job", ["example.test"]],
    ["https://user:secret@example.test/job", ["example.test"]],
    ["https://not-authorized.test/job", ["not-authorized.test"]],
  ])("rejects %s before DNS or transport", async (value, allowedDomains) => {
    let lookups = 0;
    let transports = 0;
    const guarded = client({ lookup: async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 }]; }, transport: async () => { transports += 1; throw new Error("must not run"); } });

    await expect(guarded.get({ url: new URL(value), allowedDomains, accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_TARGET_REJECTED" } satisfies Pick<PublicSourceAccessError, "code">);
    expect(lookups).toBe(0);
    expect(transports).toBe(0);
  });

  it("does not let a call expand the immutable exact-host capability", async () => {
    let lookups = 0;
    const guarded = client({ exactHosts: ["allowed.test"], lookup: async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 }]; } });
    await expect(guarded.get({ url: new URL("https://sub.allowed.test/job"), allowedDomains: ["sub.allowed.test"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_TARGET_REJECTED" });
    await expect(guarded.get({ url: new URL("https://allowed.test/job"), allowedDomains: ["example.test"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_TARGET_REJECTED" });
    expect(lookups).toBe(0);
  });

  it("fails closed in test without an explicit controlled origin before DNS", async () => {
    let lookups = 0;
    const guarded = createPublicSourceClientForTest({ exactHosts: ["example.test"], lookup: async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 }]; } });
    await expect(guarded.get({ url: new URL("https://example.test/job"), allowedDomains: ["example.test"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_NETWORK_DISABLED" });
    expect(lookups).toBe(0);
  });

  it("does not accept test-origin or transport overrides through the production factory", async () => {
    const appEnv = process.env.APP_ENV;
    let transports = 0;
    process.env.APP_ENV = "production";
    try {
      const productionFactory = createPublicSourceClient as unknown as (config: { exactHosts: string[]; testOrigin: string; transport: () => Promise<never> }) => ReturnType<typeof createPublicSourceClient>;
      const access = productionFactory({ exactHosts: ["127.0.0.1"], testOrigin: origin, transport: async () => { transports += 1; throw new Error("must not run"); } });
      await expect(access.get({ url: new URL(`${origin}/html`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 0, retry: "none" }))
        .rejects.toMatchObject({ code: "PUBLIC_SOURCE_TARGET_REJECTED" });
      expect(transports).toBe(0);
    } finally {
      process.env.APP_ENV = appEnv;
    }
  });

  it("does not grant HTTPS loopback test-origin capability outside real test mode", async () => {
    const appEnv = process.env.APP_ENV;
    let transports = 0;
    process.env.APP_ENV = "production";
    try {
      let error: unknown;
      try { createPublicSourceClientForTest({ exactHosts: ["127.0.0.1"], testOrigin: "https://127.0.0.1:443", lookup: async () => { throw new Error("lookup must not run"); }, transport: async () => { transports += 1; throw new Error("must not run"); } }); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: "PUBLIC_SOURCE_TESTING_DISABLED" });
      expect(transports).toBe(0);
    } finally {
      process.env.APP_ENV = appEnv;
    }
  });

  it("uses only the explicit controlled test origin and validates response policy", async () => {
    const access = client();
    await expect(access.get({ url: new URL(`${origin}/html`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .resolves.toMatchObject({ status: 200 });
    expect(userAgent).toBe("AI-Job-Search-Copilot/0.1 (+https://github.com/GoodScholar/ai-job-search-copilot)");
    await expect(access.get({ url: new URL(`${origin}/bad-content`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_CONTENT_TYPE_INVALID" });
    await expect(access.get({ url: new URL(`${origin}/large`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_RESPONSE_TOO_LARGE" });
  });

  it("accepts application/json only with its declared content type", async () => {
    await expect(client().get({ url: new URL(`${origin}/json`), allowedDomains: ["127.0.0.1"], accept: "application/json", maxRedirects: 0, retry: "none" }))
      .resolves.toMatchObject({ status: 200, body: expect.any(Uint8Array), attemptCount: 1 });
  });

  it("allows only exact-host redirects within its per-call authorization", async () => {
    const access = client();
    await expect(access.get({ url: new URL(`${origin}/redirect`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 3, retry: "none" }))
      .resolves.toMatchObject({ status: 200 });
    await expect(access.get({ url: new URL(`${origin}/outside`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 3, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_REDIRECT_INVALID" });
  });

  it("applies a stable two-attempt retry budget and caps Retry-After", async () => {
    const seenDelays: number[] = [];
    const access = client({ totalTimeoutMs: 60_000, sleep: async (ms) => { seenDelays.push(ms); } });
    await expect(access.get({ url: new URL(`${origin}/rate-limited`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 0, retry: "bounded" }))
      .resolves.toMatchObject({ status: 429, attemptCount: 2 });
    expect(seenDelays).toEqual([30_000]);

    const retry5xx = client({ sleep: async () => undefined });
    const before = requests;
    await expect(retry5xx.get({ url: new URL(`${origin}/server-error`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 0, retry: "bounded" }))
      .resolves.toMatchObject({ status: 500 });
    expect(requests - before).toBe(2);
  });

  it("maps abort and total timeout without leaking request data", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(client().get({ url: new URL(`${origin}/html`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 0, retry: "none", signal: abort.signal }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_ABORTED" });
    await expect(client({ totalTimeoutMs: 20 }).get({ url: new URL(`${origin}/slow`), allowedDomains: ["127.0.0.1"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_TIMEOUT" });
  });

  it("rejects private and mixed DNS answers before transport, while pinning an approved answer", async () => {
    let transports = 0;
    const mixed = createPublicSourceClientForTest({
      exactHosts: ["source.test"],
      lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
      transport: async () => { transports += 1; throw new Error("must not run"); },
    });
    await expect(mixed.get({ url: new URL("https://source.test/jobs"), allowedDomains: ["source.test"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_TARGET_REJECTED" });
    expect(transports).toBe(0);

    const privateOnly = createPublicSourceClientForTest({
      exactHosts: ["private.test"], lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      transport: async () => { transports += 1; throw new Error("must not run"); },
    });
    await expect(privateOnly.get({ url: new URL("https://private.test/jobs"), allowedDomains: ["private.test"], accept: "text/html", maxRedirects: 0, retry: "none" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_TARGET_REJECTED" });
    expect(transports).toBe(0);

    let pinnedAddress: string | undefined;
    const pinned = createPublicSourceClientForTest({
      exactHosts: ["source.test"],
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async ({ target }) => { pinnedAddress = target.address; return { status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array() }; },
    });
    await pinned.get({ url: new URL("https://source.test/jobs"), allowedDomains: ["source.test"], accept: "text/html", maxRedirects: 0, retry: "none" });
    expect(pinnedAddress).toBe("93.184.216.34");
  });

  it("enforces global two-request and per-host one-request limits", async () => {
    let active = 0;
    let maximum = 0;
    const transport = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array() };
    };
    const access = createPublicSourceClientForTest({ exactHosts: ["one.test", "two.test", "three.test"], lookup: async () => [{ address: "93.184.216.34", family: 4 }], transport });
    await Promise.all(["one.test", "two.test", "three.test"].map((host) => access.get({ url: new URL(`https://${host}/jobs`), allowedDomains: [host], accept: "text/html", maxRedirects: 0, retry: "none" })));
    expect(maximum).toBe(2);

    active = 0;
    maximum = 0;
    const sameHost = createPublicSourceClientForTest({ exactHosts: ["one.test"], lookup: async () => [{ address: "93.184.216.34", family: 4 }], transport });
    await Promise.all([sameHost.get({ url: new URL("https://one.test/a"), allowedDomains: ["one.test"], accept: "text/html", maxRedirects: 0, retry: "none" }), sameHost.get({ url: new URL("https://one.test/b"), allowedDomains: ["one.test"], accept: "text/html", maxRedirects: 0, retry: "none" })]);
    expect(maximum).toBe(1);
  });

  it("reports a bounded retry as one logical request with two stable attempts", async () => {
    let calls = 0;
    const access = createPublicSourceClientForTest({
      exactHosts: ["unreachable.test"],
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => { calls += 1; throw new Error("offline"); },
      sleep: async () => undefined,
    });
    await expect(access.get({ url: new URL("https://unreachable.test/jobs"), allowedDomains: ["unreachable.test"], accept: "text/html", maxRedirects: 0, retry: "bounded" }))
      .rejects.toMatchObject({ code: "PUBLIC_SOURCE_UNREACHABLE", attemptCount: 2, retryable: true });
    expect(calls).toBe(2);
  });

  it("removes an aborted queued request without consuming a later permit", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const access = createPublicSourceClientForTest({
      exactHosts: ["hold-one.test", "hold-two.test", "queued.test", "later.test"],
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async ({ url }) => {
        if (url.hostname === "hold-one.test" || url.hostname === "hold-two.test") await held;
        return { status: 200, headers: { "content-type": "text/html" }, body: new Uint8Array() };
      },
    });
    const first = access.get({ url: new URL("https://hold-one.test/jobs"), allowedDomains: ["hold-one.test"], accept: "text/html", maxRedirects: 0, retry: "none" });
    const second = access.get({ url: new URL("https://hold-two.test/jobs"), allowedDomains: ["hold-two.test"], accept: "text/html", maxRedirects: 0, retry: "none" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const controller = new AbortController();
    const queued = access.get({ url: new URL("https://queued.test/jobs"), allowedDomains: ["queued.test"], accept: "text/html", maxRedirects: 0, retry: "none", signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "PUBLIC_SOURCE_ABORTED" });
    release?.();
    await Promise.all([first, second]);
    await expect(access.get({ url: new URL("https://later.test/jobs"), allowedDomains: ["later.test"], accept: "text/html", maxRedirects: 0, retry: "none" })).resolves.toMatchObject({ status: 200 });
  });
});
