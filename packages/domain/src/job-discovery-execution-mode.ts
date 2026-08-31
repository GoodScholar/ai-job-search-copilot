/** Selects the execution specification for every newly-created discovery run. */
export type JobDiscoveryExecutionMode = "fake" | "greenhouse" | "layered_public";

type RuntimeEnvironment = Partial<Record<"APP_ENV" | "PUBLIC_JOB_DISCOVERY_ADAPTER" | "E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS", string | undefined>>;

export function resolveJobDiscoveryExecutionMode(environment: RuntimeEnvironment): JobDiscoveryExecutionMode {
  if (environment.APP_ENV === "production") return "layered_public";
  if (environment.APP_ENV === "test") return environment.E2E_PUBLIC_SOURCE_HEALTH_SCENARIOS ? "greenhouse" : "fake";
  if (environment.APP_ENV === "local") return environment.PUBLIC_JOB_DISCOVERY_ADAPTER === "greenhouse" ? "greenhouse" : "fake";
  throw new Error("JobDiscoveryAdapter 环境未获允许");
}
