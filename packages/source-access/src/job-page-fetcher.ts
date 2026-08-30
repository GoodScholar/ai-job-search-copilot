import { parse, type DefaultTreeAdapterMap } from "parse5";
import { PublicSourceAccessError, createInternalPublicSourceClient } from "./internal.js";
import { createPublicSourceClientForTest } from "./testing.js";

export const JOB_PAGE_MAX_BYTES = 2 * 1024 * 1024;

export type JobPageFetchFailureCode =
  | "JOB_PAGE_URL_INVALID"
  | "JOB_PAGE_TARGET_REJECTED"
  | "JOB_PAGE_REDIRECT_INVALID"
  | "JOB_PAGE_TIMEOUT"
  | "JOB_PAGE_CANCELLED"
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
  fetch(input: { url: string; signal?: AbortSignal }): Promise<FetchedJobPage>;
}

type HtmlNode = DefaultTreeAdapterMap["node"];

export class SecureJobPageFetcher implements JobPageFetcher {
  constructor(private readonly config: { appEnv?: string; testOrigin?: string; connectTimeoutMs?: number; totalTimeoutMs?: number; lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>> } = {}) {}

  async fetch({ url, signal }: { url: string; signal?: AbortSignal }): Promise<FetchedJobPage> {
    const requested = this.parseUrl(url, "JOB_PAGE_URL_INVALID");
    const client = process.env.APP_ENV === "test"
      ? createPublicSourceClientForTest({
        exactHosts: [requested.hostname], testOrigin: this.config.testOrigin ?? process.env.JOB_PAGE_FETCHER_TEST_ORIGIN,
        connectTimeoutMs: this.config.connectTimeoutMs, totalTimeoutMs: this.config.totalTimeoutMs, lookup: this.config.lookup,
      })
      : createInternalPublicSourceClient({ exactHosts: [requested.hostname] });
    let response: { status: number; headers: Readonly<Record<string, string>>; body: Uint8Array; finalUrl: URL; attemptCount: number };
    try {
      response = await client.get({ url: requested, allowedDomains: [requested.hostname], accept: "text/html", maxRedirects: 3, retry: "none", signal });
    } catch (error) {
      throw this.mapError(error);
    }
    this.assertStatus(response.status);
    const finalUrl = response.finalUrl;
    const rawHtml = Buffer.from(response.body).toString("utf8");
    const extracted = extractJobPage(rawHtml, finalUrl);
    return {
      requestedUrl: requested.toString(), finalUrl: finalUrl.toString(), canonicalUrl: extracted.canonicalUrl,
      rawHtml, visibleText: extracted.visibleText, pageClassification: "job", sourceKind: sourceKind(finalUrl, this.config.testOrigin ?? process.env.JOB_PAGE_FETCHER_TEST_ORIGIN),
    };
  }

  private parseUrl(value: string, code: JobPageFetchFailureCode, base?: URL): URL {
    let parsed: URL;
    try { parsed = new URL(value, base); } catch { throw new JobPageFetchError(code); }
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) throw new JobPageFetchError(code);
    return parsed;
  }

  private mapError(error: unknown): JobPageFetchError {
    if (!(error instanceof PublicSourceAccessError)) return new JobPageFetchError("JOB_PAGE_UNREACHABLE");
    const codes: Record<PublicSourceAccessError["code"], JobPageFetchFailureCode> = {
      PUBLIC_SOURCE_NETWORK_DISABLED: "JOB_PAGE_TARGET_REJECTED",
      PUBLIC_SOURCE_TESTING_DISABLED: "JOB_PAGE_TARGET_REJECTED",
      PUBLIC_SOURCE_TARGET_REJECTED: "JOB_PAGE_TARGET_REJECTED",
      PUBLIC_SOURCE_REDIRECT_INVALID: "JOB_PAGE_REDIRECT_INVALID",
      PUBLIC_SOURCE_TIMEOUT: "JOB_PAGE_TIMEOUT",
      PUBLIC_SOURCE_ABORTED: "JOB_PAGE_CANCELLED",
      PUBLIC_SOURCE_UNREACHABLE: "JOB_PAGE_UNREACHABLE",
      PUBLIC_SOURCE_RESPONSE_TOO_LARGE: "JOB_PAGE_RESPONSE_TOO_LARGE",
      PUBLIC_SOURCE_CONTENT_TYPE_INVALID: "JOB_PAGE_CONTENT_TYPE_INVALID",
    };
    return new JobPageFetchError(codes[error.code]);
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
  const hasDetailEvidence = /(职责|responsibilit|任职要求|qualif|岗位要求|职位描述|job\s+description)/iu.test(visibleText);
  if (/^(?:登录后查看职位|请登录后查看职位|sign\s*in\s*to\s*(?:view|see).{0,40}job)/iu.test(title ?? "")
    || (visibleFormCount > 0 && hasLoginText && !hasJobDetails && visibleText.length < 800)) throw new JobPageFetchError("JOB_PAGE_LOGIN_REQUIRED");
  if (/(职位|岗位).{0,12}(已下架|已关闭|过期)|(?:已下架|已关闭|过期).{0,12}(职位|岗位)|this\s+(?:job|position)\s+is\s+no\s+longer\s+available|(?:job|position)\s+closed/iu.test(visibleText)) throw new JobPageFetchError("JOB_PAGE_EXPIRED");
  if ((h1Texts.length === 0 && headingCount >= 2) || (h2Count >= 2 && !hasDetailEvidence)) throw new JobPageFetchError("JOB_PAGE_LISTING");
  if (isNonJobPageTitle(title)) throw new JobPageFetchError("JOB_PAGE_UNRECOGNIZED");
  const jobContextSignals = [/(公司|company)/iu, /(地点|location)/iu, /(薪资|salary)/iu, /(经验|experience)/iu, /(职责|responsibilit|任职要求|qualif|负责)/iu];
  if (!title || jobContextSignals.filter((signal) => signal.test(visibleText)).length < 2 || (!hasJobTitleEvidence(title) && !hasDetailEvidence)) throw new JobPageFetchError("JOB_PAGE_UNRECOGNIZED");
  let canonicalUrl = finalUrl.toString();
  if (canonical) {
    try {
      const parsed = new URL(canonical, finalUrl);
      if (!parsed.username && !parsed.password && /^https?:$/u.test(parsed.protocol) && parsed.origin === finalUrl.origin) canonicalUrl = parsed.toString();
    } catch { /* 无效 canonical 不能影响页面抓取。 */ }
  }
  return { visibleText, canonicalUrl };
}

function isNonJobPageTitle(title: string | undefined): boolean {
  if (/(?:\b(?:role|job|position)\b|职位|岗位)/iu.test(title ?? "")) return false;
  return /^(?:about(?:\s+us)?|company\s+profile)(?:\s|[:：|—-]|$)|^(?:关于我们|公司介绍)(?:\s|[:：|—-]|$)/iu.test(title ?? "");
}

function hasJobTitleEvidence(title: string): boolean {
  return /(工程师|经理|总监|专员|顾问|分析师|架构师|设计师|实习生|销售代表|开发者|\b(?:scientist|engineer|developer|designer|manager|executive|director|analyst|architect|consultant|specialist|intern|officer)\b)/iu.test(title);
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
    || isVisuallyHiddenInlineStyle(style);
  onElement(node.tagName, attributes, !nextHidden);
  const nextH1Index = !nextHidden && node.tagName === "h1" ? h1Texts.push([]) - 1 : h1Index;
  for (const child of "childNodes" in node && Array.isArray(node.childNodes) ? node.childNodes : []) visit(child, nextHidden, text, h1Texts, onElement, nextH1Index);
}

function attribute(attributes: Array<{ name: string; value: string }>, name: string): string | undefined { return attributes.find((attribute) => attribute.name.toLowerCase() === name)?.value; }

function isVisuallyHiddenInlineStyle(style: string): boolean {
  const declarations = new Map(style.split(";").flatMap((declaration) => {
    const separator = declaration.indexOf(":");
    return separator < 0 ? [] : [[declaration.slice(0, separator).trim(), normalizeCssValue(declaration.slice(separator + 1))]];
  }));
  const value = (property: string) => declarations.get(property);
  if (value("display") === "none" || value("visibility") === "hidden" || value("color") === "transparent") return true;
  if (Number(value("opacity")) === 0) return true;
  if ((value("clip") && value("clip") !== "auto") || (value("clip-path") && value("clip-path") !== "none")) return true;
  if (isFarNegativeOffset(value("text-indent"))) return true;
  if ((value("position") === "absolute" || value("position") === "fixed") && ["left", "right", "top", "bottom"].some((property) => isFarNegativeOffset(value(property)))) return true;
  return isCssZeroLength(value("width")) && isCssZeroLength(value("height")) && /^(?:hidden|clip)$/u.test(value("overflow") ?? "");
}

function normalizeCssValue(value: string): string { return value.trim().replace(/\s*!important\s*$/u, "").trim(); }
function isCssZeroLength(value: string | undefined): boolean { return value !== undefined && /^0(?:\.0+)?(?:px|em|rem|%)?$/u.test(value); }

function isFarNegativeOffset(value: string | undefined): boolean {
  if (!value) return false;
  const match = /^(-?\d+(?:\.\d+)?)(?:px|em|rem|%|vw|vh)?$/u.exec(value.replace(/\s+/gu, ""));
  return match !== null && Number(match[1]) <= -100;
}

function normalizedHostname(hostname: string): string { return hostname.toLowerCase().replace(/^www\./u, ""); }
function sourceKind(url: URL, testOrigin: string | undefined): "official" | "aggregator" {
  if (process.env.APP_ENV === "test" && testOrigin && url.origin === testOrigin) return "official";
  return ["boards.greenhouse.io", "job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com", "apply.workable.com", "jobs.smartrecruiters.com"].includes(normalizedHostname(url.hostname)) ? "official" : "aggregator";
}
