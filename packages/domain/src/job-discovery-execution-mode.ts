import { SourceHealthSourceIdSchema } from "@job-copilot/contracts/agent-runs";
import { z } from "zod";

/** Selects the execution specification for every newly-created discovery run. */
export type JobDiscoveryExecutionMode = "fake" | "greenhouse" | "layered_public";
type RuntimeEnvironment = NodeJS.ProcessEnv | Partial<Record<"APP_ENV" | "PUBLIC_JOB_DISCOVERY_ADAPTER" | "E2E_AGENT_RUN_SCENARIOS" | "E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS" | "E2E_ANYSEARCH_PUBLIC_JOB_PHASE" | "ANYSEARCH_BASE_URL" | "ANYSEARCH_PROVIDER_BASE_URL", string | undefined>>;

export const PUBLIC_SOURCE_HEALTH_SCENARIOS = ["healthy", "zero_valid_results", "missing_field", "invalid_url", "invalid_identity", "rate_limited", "hard_failed"] as const;
export type PublicSourceHealthScenario = typeof PUBLIC_SOURCE_HEALTH_SCENARIOS[number];
export const FAKE_ANYSEARCH_PUBLIC_JOB_PHASE = "fake-anysearch-public-job-v1";
const FakeScenarioMapSchema = z.record(z.uuid(), z.enum(["slow_checkpoint", "retry_once", "retry_until_budget"]));
const SourceHealthScenarioMapSchema = z.record(z.uuid(), z.record(SourceHealthSourceIdSchema, z.enum(PUBLIC_SOURCE_HEALTH_SCENARIOS)));
export type AgentRunScenarioMap = Readonly<z.infer<typeof FakeScenarioMapSchema>>;
export type SourceHealthScenarioMap = Readonly<z.infer<typeof SourceHealthScenarioMapSchema>>;
export type JobDiscoveryRuntimeConfig = Readonly<{ environment: "production" | "local" | "test"; executionMode: JobDiscoveryExecutionMode; agentRunScenarios: AgentRunScenarioMap; sourceHealthScenarios: SourceHealthScenarioMap; anysearchPublicJobPhase: typeof FAKE_ANYSEARCH_PUBLIC_JOB_PHASE | null }>;

function configured(value: string | undefined): boolean { return Boolean(value?.trim()); }
function invalid(): never { throw new Error("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID"); }
function parseScenario<T>(value: string | undefined, schema: z.ZodType<T>): T {
  if (value === undefined || !value.trim()) return {} as T;
  try { return schema.parse(JSON.parse(value)); } catch { return invalid(); }
}

/** 唯一的环境/测试夹具 authority；消费者只读取已解析的结果，绝不再次解析 process.env。 */
export function resolveJobDiscoveryRuntimeConfig(environment: RuntimeEnvironment): JobDiscoveryRuntimeConfig {
  const appEnv = environment.APP_ENV;
  if (appEnv !== "production" && appEnv !== "local" && appEnv !== "test") return invalid();
  if (environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== undefined && environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== "fake" && environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== "greenhouse") return invalid();
  if (appEnv === "production" && environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== undefined) return invalid();
  const configuredAnysearchPublicJobPhase = environment.E2E_ANYSEARCH_PUBLIC_JOB_PHASE;
  if (appEnv !== "test" && (environment.E2E_AGENT_RUN_SCENARIOS !== undefined || environment.E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS !== undefined || configuredAnysearchPublicJobPhase !== undefined || configured(environment.ANYSEARCH_BASE_URL) || configured(environment.ANYSEARCH_PROVIDER_BASE_URL))) return invalid();
  if (appEnv === "test" && configuredAnysearchPublicJobPhase !== undefined && configuredAnysearchPublicJobPhase !== FAKE_ANYSEARCH_PUBLIC_JOB_PHASE) return invalid();
  const anysearchPublicJobPhase = configuredAnysearchPublicJobPhase === FAKE_ANYSEARCH_PUBLIC_JOB_PHASE ? FAKE_ANYSEARCH_PUBLIC_JOB_PHASE : null;
  if (anysearchPublicJobPhase && (environment.E2E_AGENT_RUN_SCENARIOS !== undefined || environment.E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS !== undefined)) return invalid();
  const agentRunScenarios = appEnv === "test" ? parseScenario(environment.E2E_AGENT_RUN_SCENARIOS, FakeScenarioMapSchema) : {};
  const sourceHealthScenarios = appEnv === "test" ? parseScenario(environment.E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS, SourceHealthScenarioMapSchema) : {};
  const executionMode = appEnv === "production" ? "layered_public" as const : appEnv === "test" ? (anysearchPublicJobPhase ? "layered_public" as const : Object.keys(sourceHealthScenarios).length > 0 ? "greenhouse" as const : "fake" as const) : environment.PUBLIC_JOB_DISCOVERY_ADAPTER === "greenhouse" ? "greenhouse" as const : "fake" as const;
  return Object.freeze({ environment: appEnv, executionMode, agentRunScenarios: Object.freeze(agentRunScenarios), sourceHealthScenarios: Object.freeze(sourceHealthScenarios), anysearchPublicJobPhase: anysearchPublicJobPhase ?? null });
}

export function validateJobDiscoveryRuntimeConfig(environment: RuntimeEnvironment): void { resolveJobDiscoveryRuntimeConfig(environment); }
export function resolveJobDiscoveryExecutionMode(environment: RuntimeEnvironment): JobDiscoveryExecutionMode { return resolveJobDiscoveryRuntimeConfig(environment).executionMode; }
