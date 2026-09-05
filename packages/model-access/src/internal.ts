import { createHash } from "node:crypto";
import {
  ModelDiagnosticProbeResultSchema,
  type ModelDiagnosticAdapter,
  type ModelDiagnosticChecks,
  type ModelDiagnosticLatencyBucket,
  type ModelDiagnosticProbeResult,
  type ModelDiagnosticReasonCode,
} from "@job-copilot/contracts/model-diagnostics";

const DIAGNOSTIC_VERSION = "model-diagnostic-v1";
const DIAGNOSTIC_TIMEOUT_MS = 20_000;
const LOW_COST_MODEL = "gpt-5.6-luna";
const HIGH_QUALITY_MODEL = "gpt-5.6-terra";
const PROBE_NAME = "model_diagnostic_probe";
const PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["probe"],
  properties: { probe: { type: "string", enum: ["ok"] } },
} as const;

export type OpenAiModelDiagnosticConfig = {
  apiKey: string;
  endpoint?: string;
  organization?: string;
  project?: string;
  lowCostModel?: string;
  highQualityModel?: string;
};

export type ModelDiagnosticTestTransport = (input: { url: string; init: RequestInit; signal: AbortSignal }) => Promise<Response>;

type AttemptKind = "success" | "authentication_failed" | "access_restricted" | "low_cost_model_unavailable" | "high_quality_model_unavailable" | "strict_output_unsupported" | "timeout" | "rate_limited" | "provider_unavailable" | "generic_failure";
type Attempt = { kind: AttemptKind; checks: ModelDiagnosticChecks };
export type ModelDiagnosticTestOptions = { now?: () => number };

export function createInternalOpenAiModelDiagnosticAdapter(config: OpenAiModelDiagnosticConfig, transport: ModelDiagnosticTestTransport = fetchTransport, options: ModelDiagnosticTestOptions = {}): ModelDiagnosticAdapter {
  const normalized = normalizeConfig(config);
  const configurationFingerprint = fingerprint(normalized);
  const now = options.now ?? Date.now;

  return {
    configurationFingerprint,
    async diagnose({ signal }) {
      if (!normalized.valid) return result("failed", notVerifiedChecks(), "MODEL_DIAGNOSTIC_CONFIGURATION_MISSING", "under_1s");
      if (signal.aborted) return result("temporarily_unavailable", notVerifiedChecks("timeout"), "MODEL_DIAGNOSTIC_TIMEOUT", "timeout");

      const startedAt = now();
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(), DIAGNOSTIC_TIMEOUT_MS);
      const abort = () => deadline.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const attempts = await Promise.all([
          probe({ model: normalized.lowCostModel, kind: "low_cost_model_unavailable", config: normalized, signal: deadline.signal, transport }),
          probe({ model: normalized.highQualityModel, kind: "high_quality_model_unavailable", config: normalized, signal: deadline.signal, transport }),
        ]);
        return aggregate(attempts, latencyBucket(now() - startedAt, attempts));
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        deadline.abort();
      }
    },
  };
}

async function probe(input: {
  model: string;
  kind: "low_cost_model_unavailable" | "high_quality_model_unavailable";
  config: NormalizedConfig;
  signal: AbortSignal;
  transport: ModelDiagnosticTestTransport;
}): Promise<Attempt> {
  try {
    const response = await beforeDeadline(input.transport({
      url: `${input.config.endpoint}/responses`,
      init: { ...requestFor(input.model, input.config), signal: input.signal },
      signal: input.signal,
    }), input.signal);
    if (response.status === 401) return attempt("authentication_failed");
    if (response.status === 403) return attempt("access_restricted");
    if (response.status === 404) return attempt(input.kind);
    if (response.status === 408) return attempt("timeout");
    if (response.status === 429) return attempt("rate_limited");
    if (response.status >= 500) return attempt("provider_unavailable");
    if (response.status < 200 || response.status >= 300) return attempt("generic_failure");

    const body = await beforeDeadline(response.text(), input.signal);
    return attempt(validCompletedResponse(body) ? "success" : "strict_output_unsupported");
  } catch {
    return attempt(input.signal.aborted ? "timeout" : "provider_unavailable");
  }
}

function requestFor(model: string, config: NormalizedConfig): RequestInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
  };
  if (config.organization) headers["openai-organization"] = config.organization;
  if (config.project) headers["openai-project"] = config.project;
  return {
    method: "POST",
    headers,
    redirect: "error",
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: "Return the requested JSON object." }] }],
      reasoning: { effort: "none" },
      max_output_tokens: 256,
      text: { format: { type: "json_schema", name: PROBE_NAME, strict: true, schema: PROBE_SCHEMA } },
    }),
  };
}

function validCompletedResponse(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { status?: unknown; output?: unknown };
    if (parsed.status !== "completed" || !Array.isArray(parsed.output)) return false;
    const texts: string[] = [];
    for (const item of parsed.output) {
      if (!item || typeof item !== "object") return false;
      if ((item as { type?: unknown }).type === "refusal") return false;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") return false;
        if ((part as { type?: unknown }).type === "refusal") return false;
        if ((part as { type?: unknown }).type === "output_text") {
          if (typeof (part as { text?: unknown }).text !== "string") return false;
          texts.push((part as { text: string }).text);
        }
      }
    }
    if (texts.length !== 1) return false;
    const output = JSON.parse(texts[0]!) as unknown;
    return Boolean(output && typeof output === "object" && Object.keys(output).length === 1 && (output as { probe?: unknown }).probe === "ok");
  } catch {
    return false;
  }
}

function attempt(kind: AttemptKind): Attempt {
  switch (kind) {
    case "success": return { kind, checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" } };
    case "authentication_failed": return { kind, checks: { authentication: "failed", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" } };
    case "access_restricted": return { kind, checks: { authentication: "passed", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "passed" } };
    case "low_cost_model_unavailable":
    case "high_quality_model_unavailable": return { kind, checks: { authentication: "passed", modelAvailability: "failed", structuredOutput: "not_verified", timeout: "passed" } };
    case "strict_output_unsupported": return { kind, checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "failed", timeout: "passed" } };
    case "timeout": return { kind, checks: notVerifiedChecks("timeout") };
    case "rate_limited":
    case "provider_unavailable":
    case "generic_failure": return { kind, checks: notVerifiedChecks("timeout_passed") };
  }
}

function aggregate(attempts: readonly Attempt[], latencyBucket: ModelDiagnosticLatencyBucket): ModelDiagnosticProbeResult {
  const kinds = new Set(attempts.map((attempt) => attempt.kind));
  const checks = kinds.has("authentication_failed")
    ? { authentication: "failed", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" } as const
    : combineChecks(attempts);
  if (kinds.has("authentication_failed")) return result("failed", checks, "MODEL_DIAGNOSTIC_AUTHENTICATION_FAILED", latencyBucket);
  if (kinds.has("access_restricted")) return result("failed", checks, "MODEL_DIAGNOSTIC_ACCESS_RESTRICTED", latencyBucket);
  if (kinds.has("low_cost_model_unavailable")) return result("failed", checks, "MODEL_DIAGNOSTIC_LOW_COST_MODEL_UNAVAILABLE", latencyBucket);
  if (kinds.has("high_quality_model_unavailable")) return result("failed", checks, "MODEL_DIAGNOSTIC_HIGH_QUALITY_MODEL_UNAVAILABLE", latencyBucket);
  if (kinds.has("strict_output_unsupported")) return result("failed", checks, "MODEL_DIAGNOSTIC_STRICT_OUTPUT_UNSUPPORTED", latencyBucket);
  if (kinds.has("generic_failure")) return result("failed", checks, "MODEL_DIAGNOSTIC_FAILED", latencyBucket);
  if (kinds.has("timeout")) return result("temporarily_unavailable", checks, "MODEL_DIAGNOSTIC_TIMEOUT", latencyBucket);
  if (kinds.has("rate_limited")) return result("temporarily_unavailable", checks, "MODEL_DIAGNOSTIC_RATE_LIMITED", latencyBucket);
  if (kinds.has("provider_unavailable")) return result("temporarily_unavailable", checks, "MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE", latencyBucket);
  return result("available", checks, "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket);
}

function combineChecks(attempts: readonly Attempt[]): ModelDiagnosticChecks {
  const combine = (key: keyof ModelDiagnosticChecks) => attempts.some((attempt) => attempt.checks[key] === "failed") ? "failed" : attempts.every((attempt) => attempt.checks[key] === "passed") ? "passed" : "not_verified";
  return { authentication: combine("authentication"), modelAvailability: combine("modelAvailability"), structuredOutput: combine("structuredOutput"), timeout: combine("timeout") };
}

function latencyBucket(elapsedMs: number, attempts: readonly Attempt[]): ModelDiagnosticLatencyBucket {
  if (attempts.some((attempt) => attempt.kind === "timeout")) return "timeout";
  if (elapsedMs < 1_000) return "under_1s";
  if (elapsedMs < 5_000) return "1_to_5s";
  if (elapsedMs < 10_000) return "5_to_10s";
  return "10_to_20s";
}

function notVerifiedChecks(timeout: "timeout" | "timeout_passed" | undefined = undefined): ModelDiagnosticChecks {
  return {
    authentication: "not_verified",
    modelAvailability: "not_verified",
    structuredOutput: "not_verified",
    timeout: timeout === "timeout" ? "failed" : timeout === "timeout_passed" ? "passed" : "not_verified",
  };
}

function result(status: ModelDiagnosticProbeResult["status"], checks: ModelDiagnosticChecks, reasonCode: ModelDiagnosticReasonCode, latencyBucket: ModelDiagnosticLatencyBucket): ModelDiagnosticProbeResult {
  return ModelDiagnosticProbeResultSchema.parse({ status, checks, reasonCode, latencyBucket });
}

function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("MODEL_DIAGNOSTIC_TIMEOUT")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

type NormalizedConfig = Required<Pick<OpenAiModelDiagnosticConfig, "apiKey">> & {
  endpoint: string;
  organization: string | undefined;
  project: string | undefined;
  lowCostModel: string;
  highQualityModel: string;
  valid: boolean;
};

function normalizeConfig(config: OpenAiModelDiagnosticConfig): NormalizedConfig {
  const endpoint = (config.endpoint ?? "https://api.openai.com/v1").replace(/\/$/u, "");
  const lowCostModel = config.lowCostModel ?? LOW_COST_MODEL;
  const highQualityModel = config.highQualityModel ?? HIGH_QUALITY_MODEL;
  let validEndpoint = false;
  try {
    const parsed = new URL(endpoint);
    validEndpoint = parsed.protocol === "https:" && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch { /* Invalid configuration becomes a stable diagnostic result. */ }
  return {
    apiKey: config.apiKey,
    endpoint,
    organization: config.organization,
    project: config.project,
    lowCostModel,
    highQualityModel,
    valid: Boolean(config.apiKey.trim() && lowCostModel.trim() && highQualityModel.trim() && validEndpoint),
  };
}

function fingerprint(config: NormalizedConfig): string {
  return createHash("sha256").update(JSON.stringify({
    version: DIAGNOSTIC_VERSION,
    endpoint: config.endpoint,
    organization: config.organization,
    project: config.project,
    lowCostModel: config.lowCostModel,
    highQualityModel: config.highQualityModel,
    probe: { name: PROBE_NAME, schema: PROBE_SCHEMA, reasoning: "none", maxOutputTokens: 256, timeoutMs: DIAGNOSTIC_TIMEOUT_MS },
    apiKey: config.apiKey,
  })).digest("hex");
}

async function fetchTransport({ url, init, signal }: Parameters<ModelDiagnosticTestTransport>[0]): Promise<Response> {
  return fetch(url, { ...init, signal });
}
