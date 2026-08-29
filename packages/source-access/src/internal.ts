import { lookup as systemLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const USER_AGENT = "AI-Job-Search-Copilot/0.1 (+https://github.com/GoodScholar/ai-job-search-copilot)";
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2;
const MAX_RETRY_AFTER_MS = 30_000;

export type PublicSourceAccessFailureCode =
  | "PUBLIC_SOURCE_NETWORK_DISABLED"
  | "PUBLIC_SOURCE_TARGET_REJECTED"
  | "PUBLIC_SOURCE_REDIRECT_INVALID"
  | "PUBLIC_SOURCE_TIMEOUT"
  | "PUBLIC_SOURCE_ABORTED"
  | "PUBLIC_SOURCE_UNREACHABLE"
  | "PUBLIC_SOURCE_RESPONSE_TOO_LARGE"
  | "PUBLIC_SOURCE_CONTENT_TYPE_INVALID";

export class PublicSourceAccessError extends Error {
  readonly retryable: boolean;

  constructor(public readonly code: PublicSourceAccessFailureCode, public readonly attemptCount = 0) {
    super(code);
    this.retryable = code === "PUBLIC_SOURCE_UNREACHABLE" || code === "PUBLIC_SOURCE_TIMEOUT";
  }
}

export interface PublicSourceClient {
  get(input: {
    url: URL;
    allowedDomains: readonly string[];
    accept: "text/html" | "application/json";
    maxRedirects: 0 | 3;
    retry: "none" | "bounded";
    signal?: AbortSignal;
  }): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array; finalUrl: URL; attemptCount: number }>;
}

type Address = { address: string; family: number };
type TransportResponse = { status: number; headers: Readonly<Record<string, string>>; body: Uint8Array };
type Transport = (input: { url: URL; target: { address: string; family: 4 | 6 }; accept: "text/html" | "application/json"; timeoutMs: number; signal?: AbortSignal }) => Promise<TransportResponse>;

/** The optional dependencies are an internal test seam; production callers only need exactHosts. */
export type InternalPublicSourceClientConfig = {
  exactHosts: readonly string[];
  appEnv?: string;
  testOrigin?: string;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  lookup?: (hostname: string) => Promise<readonly Address[]>;
  transport?: Transport;
  sleep?: (milliseconds: number) => Promise<void>;
  allowTestTransport?: boolean;
};

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(size: number) { this.available = size; }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new PublicSourceAccessError("PUBLIC_SOURCE_ABORTED");
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { this.waiters.splice(this.waiters.indexOf(resume), 1); cleanup(); reject(new PublicSourceAccessError("PUBLIC_SOURCE_ABORTED")); };
      const resume = () => { cleanup(); resolve(); };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.waiters.push(resume);
      signal?.addEventListener("abort", abort, { once: true });
    });
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}

const globalRequests = new Semaphore(2);
const hostRequests = new Map<string, Semaphore>();

export function createInternalPublicSourceClient(config: InternalPublicSourceClientConfig): PublicSourceClient {
  const exactHosts = new Set(config.exactHosts.map(normalizeHost));
  if (exactHosts.size === 0 || [...exactHosts].some((host) => !host)) throw new Error("exactHosts must contain exact host names");
  const testOrigin = config.testOrigin ? parseOrigin(config.testOrigin) : undefined;
  const appEnv = process.env.APP_ENV ?? "development";
  const networkMode = process.env.PUBLIC_SOURCE_NETWORK_MODE === "disabled" ? "disabled" : appEnv === "test" && !config.allowTestTransport ? "test" : "enabled";
  const lookup = config.lookup ?? ((hostname: string) => systemLookup(hostname, { all: true, verbatim: true }));
  const transport = config.transport ?? nodeTransport(config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  const sleep = config.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const totalTimeoutMs = config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  return {
    async get(input) {
      assertInitialPolicy(input, exactHosts, networkMode, testOrigin);
      const startedAt = Date.now();
      let current = input.url;
      let redirects = 0;
      let attemptCount = 0;

      for (;;) {
        throwIfAborted(input.signal);
        const target = await resolveTarget(current, lookup, remaining(startedAt, totalTimeoutMs), testOrigin, input.signal);
        const globalRelease = await globalRequests.acquire(input.signal);
        const hostKey = normalizeHost(current.hostname);
        const hostSemaphore = hostRequests.get(hostKey) ?? new Semaphore(1);
        hostRequests.set(hostKey, hostSemaphore);
        let hostRelease: (() => void) | undefined;
        let result: { response: TransportResponse; hopAttemptCount: number };
        try {
          hostRelease = await hostSemaphore.acquire(input.signal);
          result = await requestWithRetry({ current, target, input, startedAt, totalTimeoutMs, transport, sleep });
        } catch (error) {
          const mapped = mapError(error);
          throw new PublicSourceAccessError(mapped.code, attemptCount + mapped.attemptCount);
        } finally {
          hostRelease?.();
          globalRelease();
        }
        const { response, hopAttemptCount } = result;
        attemptCount += hopAttemptCount;

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location;
          if (!location || redirects === input.maxRedirects) throw new PublicSourceAccessError("PUBLIC_SOURCE_REDIRECT_INVALID", attemptCount);
          let redirected: URL;
          try { redirected = new URL(location, current); } catch { throw new PublicSourceAccessError("PUBLIC_SOURCE_REDIRECT_INVALID", attemptCount); }
          if (!isAuthorizedUrl(redirected, input.allowedDomains, exactHosts, testOrigin) || normalizeHost(redirected.hostname) !== normalizeHost(current.hostname)) {
            throw new PublicSourceAccessError("PUBLIC_SOURCE_REDIRECT_INVALID", attemptCount);
          }
          current = redirected;
          redirects += 1;
          continue;
        }
        if (response.status >= 200 && response.status < 300) assertContentType(response.headers["content-type"], input.accept, attemptCount);
        return { ...response, finalUrl: current, attemptCount };
      }
    },
  };
}

async function requestWithRetry(args: {
  current: URL; target: { address: string; family: 4 | 6 }; input: Parameters<PublicSourceClient["get"]>[0]; startedAt: number; totalTimeoutMs: number; transport: Transport; sleep: (milliseconds: number) => Promise<void>;
}): Promise<{ response: TransportResponse; hopAttemptCount: number }> {
  let attempts = 0;
  for (;;) {
    const timeoutMs = remaining(args.startedAt, args.totalTimeoutMs);
    if (timeoutMs <= 0) throw new PublicSourceAccessError("PUBLIC_SOURCE_TIMEOUT", attempts);
    attempts += 1;
    let response: TransportResponse;
    try {
      response = await args.transport({ url: args.current, target: args.target, accept: args.input.accept, timeoutMs, signal: args.input.signal });
    } catch (error) {
      if (args.input.retry !== "bounded" || attempts >= MAX_ATTEMPTS || !isRetryable(error)) throw withAttempts(mapError(error), attempts);
      await args.sleep(Math.min(250, remaining(args.startedAt, args.totalTimeoutMs)));
      continue;
    }
    if (args.input.retry !== "bounded" || attempts >= MAX_ATTEMPTS || (response.status !== 429 && response.status < 500)) return { response, hopAttemptCount: attempts };
    const delay = retryDelay(response.headers["retry-after"]);
    await args.sleep(Math.min(delay, remaining(args.startedAt, args.totalTimeoutMs)));
  }
}

function assertInitialPolicy(input: Parameters<PublicSourceClient["get"]>[0], exactHosts: ReadonlySet<string>, networkMode: "disabled" | "test" | "enabled", testOrigin: URL | undefined): void {
  throwIfAborted(input.signal);
  if (!isAuthorizedUrl(input.url, input.allowedDomains, exactHosts, testOrigin)) throw new PublicSourceAccessError("PUBLIC_SOURCE_TARGET_REJECTED");
  if (networkMode === "disabled" || (networkMode === "test" && (!testOrigin || input.url.origin !== testOrigin.origin))) throw new PublicSourceAccessError("PUBLIC_SOURCE_NETWORK_DISABLED");
}

function isAuthorizedUrl(url: URL, allowedDomains: readonly string[], exactHosts: ReadonlySet<string>, testOrigin: URL | undefined): boolean {
  const host = normalizeHost(url.hostname);
  const isControlledTestUrl = process.env.APP_ENV === "test" && testOrigin?.origin === url.origin;
  if ((!isControlledTestUrl && url.protocol !== "https:") || url.username || url.password || !host) return false;
  return exactHosts.has(host) && allowedDomains.map(normalizeHost).includes(host);
}

async function resolveTarget(url: URL, lookup: (hostname: string) => Promise<readonly Address[]>, timeoutMs: number, testOrigin: URL | undefined, signal?: AbortSignal): Promise<{ address: string; family: 4 | 6 }> {
  if (timeoutMs <= 0) throw new PublicSourceAccessError("PUBLIC_SOURCE_TIMEOUT");
  throwIfAborted(signal);
  const family = isIP(url.hostname);
  if (family === 4 || family === 6) {
    if (testOrigin?.origin !== url.origin) throw new PublicSourceAccessError("PUBLIC_SOURCE_TARGET_REJECTED");
    return { address: url.hostname, family };
  }
  let addresses: readonly Address[];
  try { addresses = await withTimeout(lookup(url.hostname), timeoutMs, signal); } catch (error) { throw mapError(error); }
  if (addresses.length === 0 || addresses.some((address) => !validAddress(address)) || (testOrigin?.origin !== url.origin && addresses.some((address) => !isPublicAddress(address.address, address.family)))) {
    throw new PublicSourceAccessError("PUBLIC_SOURCE_TARGET_REJECTED");
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

function nodeTransport(connectTimeoutMs: number): Transport {
  return ({ url, target, accept, timeoutMs, signal }) => new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, {
      headers: { accept, "user-agent": USER_AGENT },
      lookup: (_hostname, options, callback) => {
        if (options.all) (callback as (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void)(null, [target]);
        else (callback as (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void)(null, target.address, target.family);
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(new PublicSourceAccessError("PUBLIC_SOURCE_RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: headers(response.headers), body: Buffer.concat(chunks) }));
    });
    const totalTimer = setTimeout(() => request.destroy(new PublicSourceAccessError("PUBLIC_SOURCE_TIMEOUT")), timeoutMs);
    const connectTimer = setTimeout(() => request.destroy(new PublicSourceAccessError("PUBLIC_SOURCE_TIMEOUT")), Math.min(connectTimeoutMs, timeoutMs));
    const clearTimers = () => { clearTimeout(totalTimer); clearTimeout(connectTimer); signal?.removeEventListener("abort", abort); };
    const abort = () => request.destroy(new PublicSourceAccessError("PUBLIC_SOURCE_ABORTED"));
    signal?.addEventListener("abort", abort, { once: true });
    request.once("error", (error) => { clearTimers(); reject(error); });
    request.once("socket", (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    request.once("response", () => clearTimeout(connectTimer));
    request.once("response", (response) => response.once("end", clearTimers));
    request.end();
  });
}

function headers(input: Record<string, string | string[] | undefined>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(input).flatMap(([key, value]) => typeof value === "string" ? [[key.toLowerCase(), value]] : []));
}

function assertContentType(contentType: string | undefined, accept: "text/html" | "application/json", attemptCount: number): void {
  const expected = accept === "text/html" ? /^text\/html(?:\s*;|$)/iu : /^application\/json(?:\s*;|$)/iu;
  if (!contentType || !expected.test(contentType)) throw new PublicSourceAccessError("PUBLIC_SOURCE_CONTENT_TYPE_INVALID", attemptCount);
}

function retryDelay(value: string | undefined): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS) : 250;
}

function remaining(startedAt: number, totalTimeoutMs: number): number { return totalTimeoutMs - (Date.now() - startedAt); }

function withTimeout<T>(promise: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new PublicSourceAccessError("PUBLIC_SOURCE_TIMEOUT")); }, milliseconds);
    const abort = () => { cleanup(); reject(new PublicSourceAccessError("PUBLIC_SOURCE_ABORTED")); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    signal?.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new PublicSourceAccessError("PUBLIC_SOURCE_ABORTED"); }

function mapError(error: unknown): PublicSourceAccessError {
  if (error instanceof PublicSourceAccessError) return error;
  return new PublicSourceAccessError("PUBLIC_SOURCE_UNREACHABLE");
}

function withAttempts(error: unknown, attemptCount: number): PublicSourceAccessError {
  const mapped = mapError(error);
  return new PublicSourceAccessError(mapped.code, Math.max(mapped.attemptCount, attemptCount));
}

function isRetryable(error: unknown): boolean { return !(error instanceof PublicSourceAccessError) || error.code === "PUBLIC_SOURCE_UNREACHABLE" || error.code === "PUBLIC_SOURCE_TIMEOUT"; }

function parseOrigin(value: string): URL {
  const origin = new URL(value);
  if (!origin.hostname || origin.username || origin.password || !/^https?:$/u.test(origin.protocol)) throw new Error("testOrigin must be an origin");
  return origin;
}

function normalizeHost(host: string): string { return host.toLowerCase().replace(/\.$/u, ""); }
function validAddress(address: Address): boolean { return (address.family === 4 || address.family === 6) && isIP(address.address) === address.family; }

function isPublicAddress(address: string, family: number): boolean {
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("::ffff:")) return false;
    return /^(2|3)/u.test(normalized) && !normalized.startsWith("2001:db8:") && !normalized.startsWith("2001:10:");
  }
  const [first = 0, second = 0, third = 0] = address.split(".").map(Number);
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && (second === 0 || second === 168 || (second === 88 && third === 99) || (second === 0 && third === 2))) return false;
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}
