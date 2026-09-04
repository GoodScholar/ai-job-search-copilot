import { createServer } from "node:http";
export { fakeAnysearchPublicJobMissingKeyPhase, fakeAnysearchPublicJobPhase } from "./fake-anysearch-test-phase-policy.mjs";

const fixtureUrls = Object.freeze({
  verified_alias: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9001-alias",
  verified: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9001",
  expired: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9002",
  login: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9003",
  listing: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9004",
  insufficient: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9005",
  policy: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9006",
  unsafe: "http://boards.greenhouse.io/fake-anysearch-fixture/jobs/9007",
});
const fixtureByUrl = new Map(Object.entries(fixtureUrls).map(([fixture, url]) => [url, fixture]));
const pageByFixture = Object.freeze({
  verified: `<!doctype html><html><head><link rel="canonical" href="${fixtureUrls.verified}"></head><body>
<main><h1>AI 应用工程师</h1><p>Fake AnySearch Fixture 公司，地点：北京。</p>
<h2>职责</h2><p>负责 AI 应用平台的设计、交付和持续改进。</p>
<h2>任职要求</h2><p>具备 TypeScript 和生产系统经验。VERIFIED_PAGE_ONLY_EVIDENCE</p>
<a href="https://untrusted.fixture.invalid/page-link">不可信链接</a></main></body></html>`,
  login: "<!doctype html><main><h1>登录后查看职位</h1><form><label>登录</label><input></form></main>",
  listing: "<!doctype html><main><h1>全部职位</h1><h2>工程师</h2><h2>设计师</h2></main>",
  insufficient: "<!doctype html><main><h1>产品机会</h1><p>公司：Fake AnySearch Fixture，地点：北京。</p></main>",
});

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function responseJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** 仅供版本化 E2E phase 使用；审计仅记录固定 operation/fixture 枚举，不记录请求正文、鉴权或用户事实。 */
export function startFakeAnysearchFixtureServer({ host = "127.0.0.1", port = 39334, signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Fake AnySearch fixture 已取消"));
  const operations = [];
  const record = (operation, fixture, count) => { operations.push({ operation, ...(fixture ? { fixture } : {}), ...(count === undefined ? {} : { count }) }); };
  // 计划器的六个查询是冻结的（general、四个受限站点、target company）。
  // fixture 仅按这个已验证的固定顺序返回静态结果，绝不记录或分支于用户查询文本。
  const searchResponses = [
    { fixture: "general", status: 200, urls: [fixtureUrls.verified_alias, fixtureUrls.expired, fixtureUrls.login, fixtureUrls.listing, fixtureUrls.insufficient] },
    { fixture: "platform_rate_limited", status: 429 },
    { fixture: "platform_unavailable", status: 503 },
    { fixture: "platform_duplicate", status: 200, urls: [fixtureUrls.verified_alias] },
    { fixture: "platform_duplicate", status: 200, urls: [fixtureUrls.verified_alias] },
    { fixture: "target_company", status: 200, urls: [fixtureUrls.verified, fixtureUrls.verified, fixtureUrls.policy, fixtureUrls.unsafe] },
  ];
  let nextSearchResponse = 0;
  const reset = () => { operations.length = 0; nextSearchResponse = 0; };
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/__fixture/fake-anysearch-audit") return responseJson(response, 200, { operations });
    if (request.method === "POST" && request.url === "/__fixture/fake-anysearch-reset") { reset(); return responseJson(response, 204, {}); }
    if (request.method === "POST" && request.url === "/__fixture/fake-anysearch-operation") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
        const fixtures = new Set(["verified_alias", "verified", "expired", "login", "listing", "insufficient", "policy"]);
        const auditOperations = new Set(["preflight", "fetch", "final_canonical_validated", "gate_persisted"]);
        if (!body || !fixtures.has(body.fixture) || !auditOperations.has(body.operation)) return responseJson(response, 400, { code: "FIXTURE_AUDIT_OPERATION_REJECTED" });
        record(body.operation, body.fixture);
        response.writeHead(204); response.end();
      });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/__fixture/fake-anysearch-job-page/")) {
      const fixture = request.url.slice("/__fixture/fake-anysearch-job-page/".length);
      if (fixture === "verified-alias") {
        record("page", "verified_alias");
        response.writeHead(302, { location: fixtureUrls.verified });
        response.end();
        return;
      }
      if (fixture === "expired") { record("page", fixture); response.writeHead(404, { "content-type": "text/html; charset=utf-8" }); response.end("职位已关闭"); return; }
      const page = pageByFixture[fixture];
      if (!page) return responseJson(response, 404, { code: "FIXTURE_ROUTE_NOT_CONFIGURED" });
      record("page", fixture);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
      return;
    }
    if (request.method !== "POST" || (request.url !== "/v1/search" && request.url !== "/v1/extract")) return responseJson(response, 404, { code: "FIXTURE_ROUTE_NOT_CONFIGURED" });
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
      if (request.url === "/v1/search") {
        const plan = searchResponses[nextSearchResponse++];
        if (!plan) return responseJson(response, 400, { code: "FIXTURE_SEARCH_ORDER_EXHAUSTED" });
        record("search", plan.fixture, plan.urls?.length ?? 0);
        if (plan.status !== 200) return responseJson(response, plan.status, { code: plan.status });
        return responseJson(response, 200, { code: 0, message: "success", request_id: "fake-anysearch-search", data: { results: plan.urls.map((url) => ({ url, title: "UNTRUSTED_SEARCH_TITLE", content: "UNTRUSTED_SEARCH_SNIPPET username password api_key fake-anysearch-public-job-test-key https://untrusted.fixture.invalid/search-link" })) } });
      }
      const url = typeof body.url === "string" ? body.url : "";
      const fixture = fixtureByUrl.get(url);
      if (!fixture) return responseJson(response, 400, { code: "FIXTURE_EXTRACT_TARGET_REJECTED" });
      record("extract", fixture);
      return responseJson(response, 200, { code: 0, message: "success", request_id: "fake-anysearch-extract", data: { url, title: "UNTRUSTED_EXTRACT_TITLE", content: "UNTRUSTED_EXTRACT_AUXILIARY username password api_key fake-anysearch-public-job-test-key https://untrusted.fixture.invalid/extract-link" } });
    });
  });
  let closePromise;
  const stop = () => {
    if (closePromise) return closePromise;
    signal?.removeEventListener("abort", onAbort);
    closePromise = close(server);
    return closePromise;
  };
  const onAbort = () => { void stop(); };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      signal?.addEventListener("abort", onAbort, { once: true });
      resolve({ origin: "http://" + host + ":" + port, close: stop });
    });
  });
}
