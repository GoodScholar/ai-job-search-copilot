/** Selects the execution specification for every newly-created discovery run. */
export type JobDiscoveryExecutionMode = "fake" | "greenhouse" | "layered_public";

type RuntimeEnvironment = Partial<Record<"APP_ENV" | "PUBLIC_JOB_DISCOVERY_ADAPTER" | "E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS" | "ANYSEARCH_BASE_URL" | "ANYSEARCH_PROVIDER_BASE_URL", string | undefined>>;

function configured(value: string | undefined): boolean { return Boolean(value?.trim()); }

function validate(environment: RuntimeEnvironment): void {
  if (environment.APP_ENV !== "production" && environment.APP_ENV !== "local" && environment.APP_ENV !== "test") throw new Error("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
  if (environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== undefined && environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== "fake" && environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== "greenhouse") throw new Error("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
  if (environment.APP_ENV === "production" && environment.PUBLIC_JOB_DISCOVERY_ADAPTER !== undefined) throw new Error("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
  if (environment.APP_ENV !== "test" && (configured(environment.E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS) || configured(environment.ANYSEARCH_BASE_URL) || configured(environment.ANYSEARCH_PROVIDER_BASE_URL))) throw new Error("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
}

export function resolveJobDiscoveryExecutionMode(environment: RuntimeEnvironment): JobDiscoveryExecutionMode {
  validate(environment);
  if (environment.APP_ENV === "production") return "layered_public";
  if (environment.APP_ENV === "test") return environment.E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS ? "greenhouse" : "fake";
  if (environment.APP_ENV === "local") return environment.PUBLIC_JOB_DISCOVERY_ADAPTER === "greenhouse" ? "greenhouse" : "fake";
  throw new Error("JOB_DISCOVERY_RUNTIME_CONFIG_INVALID");
}
