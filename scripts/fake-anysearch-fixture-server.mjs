import { createServer } from "node:http";

export const fakeAnysearchPublicJobPhase = "fake-anysearch-public-job-v1";
export const fakeAnysearchPublicJobMissingKeyPhase = "fake-anysearch-public-job-missing-key-v1";

const fixtureUrls = Object.freeze({
  verified: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9001",
  expired: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9002",
  login: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9003",
  listing: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9004",
  insufficient: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9005",
  policy: "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9006",
});
const fixtureByUrl = new Map(Object.entries(fixtureUrls).map(([fixture, url]) => [url, fixture]));
const pageByFixture = Object.freeze({
  verified: `<!doctype html><html><head><link rel="canonical" href="${fixtureUrls.verified}"></head><body>
<main><h1>AI 应用工程师</h1><p>Fake AnySearch Fixture 公司，地点：北京。</p>
<h2>职责</h2><p>负责 AI 应用平台的设计、交付和持续改进。</p>
<h2>任职要求</h2><p>具备 TypeScript 和生产系统经验。</p></main></body></html>`,
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
  const record = (operation, fixture) => { operations.push(fixture ? { operation, fixture } : { operation }); };
  // 计划器的六个查询是冻结的（general、四个受限站点、target company）。
  // fixture 仅按这个已验证的固定顺序返回静态结果，绝不记录或分支于用户查询文本。
  const searchResponses = [
    { fixture: "general", status: 200, urls: [fixtureUrls.verified, fixtureUrls.expired, fixtureUrls.login, fixtureUrls.listing, fixtureUrls.insufficient] },
    { fixture: "platform_rate_limited", status: 429 },
    { fixture: "platform_unavailable", status: 503 },
    { fixture: "platform_duplicate", status: 200, urls: [fixtureUrls.verified] },
    { fixture: "platform_duplicate", status: 200, urls: [fixtureUrls.verified] },
    { fixture: "target_company", status: 200, urls: [fixtureUrls.verified, fixtureUrls.verified, fixtureUrls.policy] },
  ];
  let nextSearchResponse = 0;
  const reset = () => { operations.length = 0; nextSearchResponse = 0; };
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/__fixture/fake-anysearch-audit") return responseJson(response, 200, { operations });
    if (request.method === "POST" && request.url === "/__fixture/fake-anysearch-reset") { reset(); return responseJson(response, 204, {}); }
    if (request.method === "GET" && request.url?.startsWith("/__fixture/fake-anysearch-job-page/")) {
      const fixture = request.url.slice("/__fixture/fake-anysearch-job-page/".length);
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
        record("search", plan.fixture);
        if (plan.status !== 200) return responseJson(response, plan.status, { code: plan.status });
        return responseJson(response, 200, { code: 0, message: "success", request_id: "fake-anysearch-search", data: { results: plan.urls.map((url) => ({ url, title: "ignored-search-title", content: "ignored-search-content" })) } });
      }
      const url = typeof body.url === "string" ? body.url : "";
      const fixture = fixtureByUrl.get(url);
      if (!fixture) return responseJson(response, 400, { code: "FIXTURE_EXTRACT_TARGET_REJECTED" });
      record("extract", fixture);
      return responseJson(response, 200, { code: 0, message: "success", request_id: "fake-anysearch-extract", data: { url, title: "ignored-extract-title", content: "ignored-extract-content" } });
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
