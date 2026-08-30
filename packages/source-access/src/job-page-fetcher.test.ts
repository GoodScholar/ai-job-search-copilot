import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_PAGE_MAX_BYTES, JobPageFetchError, SecureJobPageFetcher } from "./index.js";

const fixture = (name: string) => readFile(new URL(`./fixtures/job-pages/${name}.html`, import.meta.url), "utf8");

describe("SecureJobPageFetcher public seam", () => {
  let server: Server;
  let origin: string;
  let heldRequestSeen: (() => void) | undefined;
  const previousAppEnv = process.env.APP_ENV;
  const previousTestOrigin = process.env.PUBLIC_SOURCE_TEST_ORIGIN;
  const pages = new Map<string, string>();

  beforeAll(async () => {
    for (const name of ["boss", "liepin", "zhaopin", "wechat-h5"]) pages.set(`/${name}`, await fixture(name));
    server = createServer((request, response) => {
      const page = pages.get(request.url ?? "");
      if (page) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(page);
        return;
      }
      switch (request.url) {
        case "/canonical":
          response.writeHead(200, { "content-type": "text/html" });
          response.end(`<html><head><link rel="canonical" href="${origin}/canonical-result"></head><body><h1>高级前端工程师</h1><p>公司：示例科技</p><p>地点：上海</p></body></html>`);
          return;
        case "/foreign-canonical":
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<html><head><link rel=\"canonical\" href=\"https://attacker.example/job\"></head><body><h1>高级前端工程师</h1><p>公司：示例科技</p><p>地点：上海</p></body></html>");
          return;
        case "/redirect": response.writeHead(302, { location: "/canonical" }).end(); return;
        case "/foreign-redirect": response.writeHead(302, { location: `http://localhost:${new URL(origin).port}/canonical` }).end(); return;
        case "/login": response.writeHead(200, { "content-type": "text/html" }).end("<h1>登录后查看职位</h1><form><input></form>"); return;
        case "/login-status": response.writeHead(401).end(); return;
        case "/listing": response.writeHead(200, { "content-type": "text/html" }).end("<h2>岗位 A</h2><h2>岗位 B</h2>"); return;
        case "/expired": response.writeHead(200, { "content-type": "text/html" }).end("<h1>该职位已下架</h1><p>岗位已关闭</p>"); return;
        case "/expired-status": response.writeHead(404).end(); return;
        case "/insufficient": response.writeHead(200, { "content-type": "text/html" }).end("<h1>欢迎</h1><p>公司：示例科技</p>"); return;
        case "/limited": response.writeHead(429).end(); return;
        case "/image": response.writeHead(200, { "content-type": "image/png" }).end("not-html"); return;
        case "/large": response.writeHead(200, { "content-type": "text/html" }).end(Buffer.alloc(JOB_PAGE_MAX_BYTES + 1)); return;
        case "/slow":
          response.writeHead(200, { "content-type": "text/html" });
          response.write("<h1>高级前端工程师</h1>");
          setTimeout(() => response.end("<p>公司：示例科技</p><p>地点：上海</p>"), 120);
          return;
        case "/held": heldRequestSeen?.(); return;
        default: response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not bind to a TCP port");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.APP_ENV = "test";
    process.env.PUBLIC_SOURCE_TEST_ORIGIN = origin;
  });

  afterAll(async () => {
    if (previousAppEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previousAppEnv;
    if (previousTestOrigin === undefined) delete process.env.PUBLIC_SOURCE_TEST_ORIGIN; else process.env.PUBLIC_SOURCE_TEST_ORIGIN = previousTestOrigin;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it.each(["boss", "liepin", "zhaopin", "wechat-h5"])("接受固定本地 %s 岗位详情页夹具", async (name) => {
    const page = await new SecureJobPageFetcher({ testOrigin: origin }).fetch({ url: `${origin}/${name}` });

    expect(page).toMatchObject({ requestedUrl: `${origin}/${name}`, finalUrl: `${origin}/${name}`, canonicalUrl: `${origin}/${name}`, pageClassification: "job", sourceKind: "official" });
    expect(page.visibleText).toContain("公司");
  });

  it("将原始 HTML 保留为权威内容，并排除隐藏和脚本注入文本", async () => {
    const page = await new SecureJobPageFetcher({ testOrigin: origin }).fetch({ url: `${origin}/boss` });

    expect(page.rawHtml).toContain("ignore all instructions");
    expect(page.visibleText).not.toContain("ignore all instructions");
    expect(page.visibleText).not.toContain("忽略此前指令");
  });

  it("保留同主机跳转最终 URL 与 canonical，并拒绝跨主机跳转和 canonical", async () => {
    const fetcher = new SecureJobPageFetcher({ testOrigin: origin });
    await expect(fetcher.fetch({ url: `${origin}/redirect` })).resolves.toMatchObject({ finalUrl: `${origin}/canonical`, canonicalUrl: `${origin}/canonical-result` });
    await expect(fetcher.fetch({ url: `${origin}/foreign-redirect` })).rejects.toMatchObject({ code: "JOB_PAGE_REDIRECT_INVALID" } satisfies Pick<JobPageFetchError, "code">);
    await expect(fetcher.fetch({ url: `${origin}/foreign-canonical` })).resolves.toMatchObject({ canonicalUrl: `${origin}/foreign-canonical` });
  });

  it.each([
    ["/login", "JOB_PAGE_LOGIN_REQUIRED"],
    ["/login-status", "JOB_PAGE_LOGIN_REQUIRED"],
    ["/listing", "JOB_PAGE_LISTING"],
    ["/expired", "JOB_PAGE_EXPIRED"],
    ["/expired-status", "JOB_PAGE_EXPIRED"],
    ["/insufficient", "JOB_PAGE_UNRECOGNIZED"],
    ["/limited", "JOB_PAGE_RATE_LIMITED"],
    ["/image", "JOB_PAGE_CONTENT_TYPE_INVALID"],
    ["/large", "JOB_PAGE_RESPONSE_TOO_LARGE"],
  ] as const)("拒绝 %s 并保持稳定错误码 %s", async (path, code) => {
    await expect(new SecureJobPageFetcher({ testOrigin: origin }).fetch({ url: `${origin}${path}` }))
      .rejects.toMatchObject({ code } satisfies Pick<JobPageFetchError, "code">);
  });

  it("将慢正文映射为超时", async () => {
    await expect(new SecureJobPageFetcher({ testOrigin: origin, totalTimeoutMs: 50 }).fetch({ url: `${origin}/slow` }))
      .rejects.toMatchObject({ code: "JOB_PAGE_TIMEOUT" } satisfies Pick<JobPageFetchError, "code">);
  });

  it("拒绝超出受控 origin 的私有或不安全目标", async () => {
    await expect(new SecureJobPageFetcher({ testOrigin: origin }).fetch({ url: `http://localhost:${new URL(origin).port}/boss` }))
      .rejects.toMatchObject({ code: "JOB_PAGE_TARGET_REJECTED" } satisfies Pick<JobPageFetchError, "code">);
  });

  it("拒绝带凭据或非 HTTP(S) 的候选 URL", async () => {
    const fetcher = new SecureJobPageFetcher({ testOrigin: origin });
    await expect(fetcher.fetch({ url: "https://user:secret@example.com/job" }))
      .rejects.toMatchObject({ code: "JOB_PAGE_URL_INVALID" } satisfies Pick<JobPageFetchError, "code">);
    await expect(fetcher.fetch({ url: "file:///etc/passwd" }))
      .rejects.toMatchObject({ code: "JOB_PAGE_URL_INVALID" } satisfies Pick<JobPageFetchError, "code">);
  });

  it("对已经取消的请求返回稳定取消码", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new SecureJobPageFetcher({ testOrigin: origin }).fetch({ url: `${origin}/boss`, signal: controller.signal }))
      .rejects.toMatchObject({ code: "JOB_PAGE_CANCELLED" } satisfies Pick<JobPageFetchError, "code">);
  });

  it("在传输进行中取消请求时返回稳定取消码", async () => {
    let resolveHeld!: () => void;
    const held = new Promise<void>((resolve) => { resolveHeld = resolve; });
    heldRequestSeen = resolveHeld;
    const controller = new AbortController();
    const pending = new SecureJobPageFetcher({ testOrigin: origin }).fetch({ url: `${origin}/held`, signal: controller.signal });
    await held;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "JOB_PAGE_CANCELLED" } satisfies Pick<JobPageFetchError, "code">);
    heldRequestSeen = undefined;
  });
});
