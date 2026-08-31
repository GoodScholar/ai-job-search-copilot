import { request } from "node:http";
import type { TestPublicSourceLookup, TestPublicSourceTransport } from "@job-copilot/source-access/testing";

const FIXTURE_PAGE_PATHS = new Map([
  ["https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9001-alias", "/__fixture/fake-anysearch-job-page/verified-alias"],
  ["https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9001", "/__fixture/fake-anysearch-job-page/verified"],
  ["https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9002", "/__fixture/fake-anysearch-job-page/expired"],
  ["https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9003", "/__fixture/fake-anysearch-job-page/login"],
  ["https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9004", "/__fixture/fake-anysearch-job-page/listing"],
  ["https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9005", "/__fixture/fake-anysearch-job-page/insufficient"],
]);
const POLICY_REDIRECT_URL = "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9006";

/**
 * 版本化 E2E 的唯一 page-fetch transport seam。它保留公共 HTTPS candidate，
 * 只将固定 fixture URL 的连接落到 local runtime；其余任意 URL 均 fail closed。
 */
export function createFakeAnysearchFixturePageTransport(origin: string): TestPublicSourceTransport {
  const fixtureOrigin = new URL(origin);
  if (fixtureOrigin.protocol !== "http:" || fixtureOrigin.hostname !== "127.0.0.1") throw new Error("FAKE_ANYSEARCH_FIXTURE_ORIGIN_INVALID");
  return async ({ url, accept, timeoutMs, signal }) => {
    if (url.toString() === POLICY_REDIRECT_URL && accept === "text/html") {
      // 固定跨 host redirect 必须由真实 PublicSourceClient 的 redirect policy 拒绝，不能再请求任何新 URL。
      return { status: 302, headers: { location: "https://jobs.lever.co/untrusted-fixture/9006" }, body: new Uint8Array() };
    }
    const path = FIXTURE_PAGE_PATHS.get(url.toString());
    if (!path || accept !== "text/html") throw new Error("FAKE_ANYSEARCH_FIXTURE_TARGET_REJECTED");
    const fixtureUrl = new URL(path, fixtureOrigin);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const abort = () => client.destroy(new Error("aborted"));
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const client = request(fixtureUrl, { method: "GET", headers: { accept } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => settle(() => resolve({
          status: response.statusCode ?? 500,
          headers: Object.fromEntries(Object.entries(response.headers).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : [])),
          body: new Uint8Array(Buffer.concat(chunks)),
        })));
        response.once("aborted", () => settle(() => reject(new Error("fixture transport aborted"))));
        response.once("error", () => settle(() => reject(new Error("fixture transport failed"))));
        response.once("close", () => {
          if (!response.complete) settle(() => reject(new Error("fixture transport closed")));
        });
      });
      timer = setTimeout(() => client.destroy(new Error("timeout")), timeoutMs);
      client.once("error", () => settle(() => reject(new Error("fixture transport failed"))));
      client.once("close", () => settle(() => reject(new Error("fixture transport closed"))));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else client.end();
    });
  };
}

export function fakeAnysearchFixtureLookup(hostname: string): ReturnType<TestPublicSourceLookup> {
  return Promise.resolve(hostname === "boards.greenhouse.io" ? [{ address: "93.184.216.34", family: 4 }] : []);
}
