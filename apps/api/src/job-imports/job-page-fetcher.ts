import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parse, type DefaultTreeAdapterMap } from "parse5";

export const JOB_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 3_000;
const TOTAL_TIMEOUT_MS = 8_000;

export type JobPageFetchFailureCode =
  | "JOB_PAGE_URL_INVALID"
  | "JOB_PAGE_TARGET_REJECTED"
  | "JOB_PAGE_REDIRECT_INVALID"
  | "JOB_PAGE_TIMEOUT"
  | "JOB_PAGE_UNREACHABLE"
  | "JOB_PAGE_RESPONSE_TOO_LARGE"
  | "JOB_PAGE_CONTENT_TYPE_INVALID"
  | "JOB_PAGE_LISTING"
  | "JOB_PAGE_LOGIN_REQUIRED"
  | "JOB_PAGE_EXPIRED"
  | "JOB_PAGE_RATE_LIMITED"
  | "JOB_PAGE_UNRECOGNIZED";

export class JobPageFetchError extends Error {
  constructor(public readonly code: JobPageFetchFailureCode) { super(code); }
}

export type FetchedJobPage = {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  rawHtml: string;
  visibleText: string;
  pageClassification: "job";
  sourceKind: "official" | "aggregator";
};

export interface JobPageFetcher {
  fetch(input: { url: string }): Promise<FetchedJobPage>;
}

type ResolvedTarget = { address: string; family: 4 | 6 };
type HtmlNode = DefaultTreeAdapterMap["node"];
type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export class SecureJobPageFetcher implements JobPageFetcher {
  constructor(private readonly config: { appEnv: string; testOrigin?: string; connectTimeoutMs?: number; totalTimeoutMs?: number; lookup?: DnsLookup } = { appEnv: process.env.APP_ENV ?? "development" }) {}

  async fetch({ url }: { url: string }): Promise<FetchedJobPage> {
    const requested = this.parseUrl(url, "JOB_PAGE_URL_INVALID");
    const startedAt = Date.now();
    let current = requested;

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const remaining = this.remainingTimeout(startedAt);
      if (remaining <= 0) throw new JobPageFetchError("JOB_PAGE_TIMEOUT");
      const target = await this.resolveTarget(current, remaining);
      const requestTimeout = this.remainingTimeout(startedAt);
      if (requestTimeout <= 0) throw new JobPageFetchError("JOB_PAGE_TIMEOUT");
      const response = await this.request(current, target, requestTimeout);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = response.headers.location;
        if (!location || Array.isArray(location)) throw new JobPageFetchError("JOB_PAGE_REDIRECT_INVALID");
        if (redirects === MAX_REDIRECTS) throw new JobPageFetchError("JOB_PAGE_REDIRECT_INVALID");
        const redirected = this.parseUrl(location, "JOB_PAGE_REDIRECT_INVALID", current);
        if (!hasRelatedHost(current, redirected)) throw new JobPageFetchError("JOB_PAGE_REDIRECT_INVALID");
        current = redirected;
        continue;
      }
      this.assertStatus(response.statusCode);
      const contentType = response.headers["content-type"];
      if (typeof contentType !== "string" || !/^text\/html(?:\s*;|$)/iu.test(contentType)) {
        throw new JobPageFetchError("JOB_PAGE_CONTENT_TYPE_INVALID");
      }
      const rawHtml = response.body.toString("utf8");
      const extracted = extractJobPage(rawHtml, current);
      return {
        requestedUrl: requested.toString(), finalUrl: current.toString(), canonicalUrl: extracted.canonicalUrl,
        rawHtml, visibleText: extracted.visibleText, pageClassification: "job", sourceKind: sourceKind(current, this.config),
      };
    }
    throw new JobPageFetchError("JOB_PAGE_REDIRECT_INVALID");
  }

  private parseUrl(value: string, code: JobPageFetchFailureCode, base?: URL): URL {
    let parsed: URL;
    try { parsed = new URL(value, base); } catch { throw new JobPageFetchError(code); }
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
      throw new JobPageFetchError(code);
    }
    return parsed;
  }

  private remainingTimeout(startedAt: number): number {
    return (this.config.totalTimeoutMs ?? TOTAL_TIMEOUT_MS) - (Date.now() - startedAt);
  }

  private async resolveTarget(url: URL, timeoutMs: number): Promise<ResolvedTarget> {
    const testOrigin = this.config.appEnv === "test" ? this.config.testOrigin : undefined;
    if (testOrigin && url.origin === testOrigin) {
      const family = isIP(url.hostname);
      if (family === 4 || family === 6) return { address: url.hostname, family };
      const addresses = await this.lookupAddresses(url.hostname, timeoutMs);
      if (addresses.length !== 1 || (addresses[0]!.family !== 4 && addresses[0]!.family !== 6)) throw new JobPageFetchError("JOB_PAGE_TARGET_REJECTED");
      return { address: addresses[0]!.address, family: addresses[0]!.family };
    }
    if (isIP(url.hostname)) throw new JobPageFetchError("JOB_PAGE_TARGET_REJECTED");
    let addresses: Array<{ address: string; family: number }>;
    try { addresses = await this.lookupAddresses(url.hostname, timeoutMs); } catch (error) {
      if (error instanceof JobPageFetchError) throw error;
      throw new JobPageFetchError("JOB_PAGE_UNREACHABLE");
    }
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address.address, address.family))) {
      throw new JobPageFetchError("JOB_PAGE_TARGET_REJECTED");
    }
    const selected = addresses[0]!;
    return { address: selected.address, family: selected.family as 4 | 6 };
  }

  private async lookupAddresses(hostname: string, timeoutMs: number): Promise<Array<{ address: string; family: number }>> {
    if (timeoutMs <= 0) throw new JobPageFetchError("JOB_PAGE_TIMEOUT");
    const resolve = this.config.lookup ?? ((value: string) => lookup(value, { all: true, verbatim: true }));
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const resolveAddresses = (addresses: Array<{ address: string; family: number }>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(addresses);
      };
      const rejectLookup = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      };
      const timer = setTimeout(() => rejectLookup(new JobPageFetchError("JOB_PAGE_TIMEOUT")), timeoutMs);
      Promise.resolve().then(() => resolve(hostname)).then(
        resolveAddresses,
        rejectLookup,
      );
    });
  }

  private async request(url: URL, target: ResolvedTarget, totalTimeoutMs: number): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(url, {
        headers: { accept: "text/html,application/xhtml+xml" },
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            (callback as (error: NodeJS.ErrnoException | null, addresses: ResolvedTarget[]) => void)(null, [target]);
            return;
          }
          (callback as (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void)(null, target.address, target.family);
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > JOB_PAGE_MAX_BYTES) request.destroy(new JobPageFetchError("JOB_PAGE_RESPONSE_TOO_LARGE"));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      const connectTimeout = setTimeout(() => request.destroy(new JobPageFetchError("JOB_PAGE_TIMEOUT")), Math.min(this.config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, totalTimeoutMs));
      const totalTimeout = setTimeout(() => request.destroy(new JobPageFetchError("JOB_PAGE_TIMEOUT")), totalTimeoutMs);
      const clearTimers = () => { clearTimeout(connectTimeout); clearTimeout(totalTimeout); };
      request.once("error", (error) => {
        clearTimers();
        reject(error instanceof JobPageFetchError ? error : new JobPageFetchError("JOB_PAGE_UNREACHABLE"));
      });
      request.once("socket", (socket) => {
        if (!socket.connecting) clearTimeout(connectTimeout);
        else socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimeout));
      });
      request.once("response", () => clearTimeout(connectTimeout));
      request.once("response", (response) => response.once("end", clearTimers));
      request.end();
    });
  }

  private assertStatus(statusCode: number): void {
    if (statusCode === 401 || statusCode === 403) throw new JobPageFetchError("JOB_PAGE_LOGIN_REQUIRED");
    if (statusCode === 429) throw new JobPageFetchError("JOB_PAGE_RATE_LIMITED");
    if (statusCode === 404 || statusCode === 410) throw new JobPageFetchError("JOB_PAGE_EXPIRED");
    if (statusCode < 200 || statusCode >= 300) throw new JobPageFetchError("JOB_PAGE_UNREACHABLE");
  }
}

function extractJobPage(rawHtml: string, finalUrl: URL): { visibleText: string; canonicalUrl: string } {
  const document = parse(rawHtml);
  const text: string[] = [];
  const h1Texts: string[][] = [];
  let headingCount = 0;
  let h2Count = 0;
  let visibleFormCount = 0;
  let canonical: string | undefined;
  visit(document, false, text, h1Texts, (tagName, attributes, visible) => {
    if (visible && (tagName === "h1" || tagName === "h2")) headingCount += 1;
    if (visible && tagName === "h2") h2Count += 1;
    if (visible && tagName === "form") visibleFormCount += 1;
    if (tagName === "link" && attribute(attributes, "rel")?.toLowerCase().split(/\s+/u).includes("canonical")) canonical = attribute(attributes, "href");
  });
  const plainText = text.join("\n").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  const title = h1Texts.map((parts) => parts.join(" ").replace(/\s+/gu, " ").trim()).find(Boolean);
  const visibleText = title ? `# ${title}\n${plainText}` : plainText;
  const hasLoginText = /(登录|登陆|sign\s*in|log\s*in|login|验证身份)/iu.test(visibleText);
  const hasJobDetails = /(职责|responsibilit|任职要求|qualif|公司|company|地点|location|薪资|salary|经验|experience)/iu.test(visibleText);
  if (/^(?:登录后查看职位|请登录后查看职位|sign\s*in\s*to\s*(?:view|see).{0,40}job)/iu.test(title ?? "")
    || (visibleFormCount > 0 && hasLoginText && !hasJobDetails && visibleText.length < 800)) {
    throw new JobPageFetchError("JOB_PAGE_LOGIN_REQUIRED");
  }
  if (/(职位|岗位).{0,12}(已下架|已关闭|过期)|(?:已下架|已关闭|过期).{0,12}(职位|岗位)|this\s+(?:job|position)\s+is\s+no\s+longer\s+available|(?:job|position)\s+closed/iu.test(visibleText)) {
    throw new JobPageFetchError("JOB_PAGE_EXPIRED");
  }
  if ((h1Texts.length === 0 && headingCount >= 2) || (/(?:engineering\s+jobs|open\s+positions|职位列表|招聘岗位)/iu.test(title ?? "") && h2Count >= 2)) {
    throw new JobPageFetchError("JOB_PAGE_LISTING");
  }
  const jobContextSignals = [
    /(公司|company)/iu,
    /(地点|location)/iu,
    /(薪资|salary)/iu,
    /(经验|experience)/iu,
    /(职责|responsibilit|任职要求|qualif|负责)/iu,
  ];
  const hasRoleDetails = /(职责|responsibilit|任职要求|qualif|负责)/iu.test(visibleText);
  const jobContextCount = jobContextSignals.filter((signal) => signal.test(visibleText)).length;
  if (!title || !hasRoleDetails || jobContextCount < 2) {
    throw new JobPageFetchError("JOB_PAGE_UNRECOGNIZED");
  }
  let canonicalUrl = finalUrl.toString();
  if (canonical) {
    try {
      const parsed = new URL(canonical, finalUrl);
      if (/^https?:$/u.test(parsed.protocol) && hasRelatedHost(finalUrl, parsed)) canonicalUrl = parsed.toString();
    } catch { /* 无效 canonical 不能影响页面抓取。 */ }
  }
  return { visibleText, canonicalUrl };
}

function visit(node: HtmlNode, hidden: boolean, text: string[], h1Texts: string[][], onElement: (tagName: string, attributes: Array<{ name: string; value: string }>, visible: boolean) => void, h1Index?: number): void {
  if ("nodeName" in node && node.nodeName === "#text" && !hidden && "value" in node && typeof node.value === "string") {
    text.push(node.value);
    if (h1Index !== undefined) h1Texts[h1Index]?.push(node.value);
  }
  if (!("tagName" in node) || typeof node.tagName !== "string") {
    for (const child of "childNodes" in node && Array.isArray(node.childNodes) ? node.childNodes : []) visit(child, hidden, text, h1Texts, onElement, h1Index);
    return;
  }
  const attributes = "attrs" in node && Array.isArray(node.attrs) ? node.attrs : [];
  const style = attribute(attributes, "style")?.toLowerCase() ?? "";
  const nextHidden = hidden || ["script", "style", "template", "noscript", "head"].includes(node.tagName)
    || attribute(attributes, "hidden") !== undefined || attribute(attributes, "aria-hidden") === "true"
    || /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$))/u.test(style);
  onElement(node.tagName, attributes, !nextHidden);
  const nextH1Index = !nextHidden && node.tagName === "h1" ? h1Texts.push([]) - 1 : h1Index;
  for (const child of "childNodes" in node && Array.isArray(node.childNodes) ? node.childNodes : []) visit(child, nextHidden, text, h1Texts, onElement, nextH1Index);
}

function attribute(attributes: Array<{ name: string; value: string }>, name: string): string | undefined {
  return attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function hasRelatedHost(left: URL, right: URL): boolean {
  return normalizedHostname(left.hostname) === normalizedHostname(right.hostname);
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, "");
}

function sourceKind(url: URL, config: { appEnv: string; testOrigin?: string }): "official" | "aggregator" {
  if (config.appEnv === "test" && config.testOrigin && url.origin === config.testOrigin) return "official";
  return ["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "apply.workable.com", "jobs.smartrecruiters.com"].includes(normalizedHostname(url.hostname))
    ? "official"
    : "aggregator";
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("::ffff:")) return false;
    return /^2|^3/u.test(normalized) && !normalized.startsWith("2001:db8:") && !normalized.startsWith("2001:10:");
  }
  const [first = 0, second = 0, third = 0] = address.split(".").map(Number);
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168 || second === 88 && third === 99 || second === 0 && third === 2)) return false;
  if (first === 198 && (second === 18 || second === 19 || second === 51 && third === 100)) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}
