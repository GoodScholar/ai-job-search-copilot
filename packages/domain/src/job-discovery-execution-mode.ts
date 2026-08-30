/** Selects the execution specification for every newly-created discovery run. */
export type JobDiscoveryExecutionMode = "fake" | "greenhouse";

type RuntimeEnvironment = Partial<Record<"APP_ENV" | "PUBLIC_JOB_DISCOVERY_ADAPTER", string | undefined>>;

export function resolveJobDiscoveryExecutionMode(environment: RuntimeEnvironment): JobDiscoveryExecutionMode {
  if (environment.APP_ENV === "production") return "greenhouse";
  if (environment.APP_ENV === "test") return "fake";
  if (environment.APP_ENV === "local") return environment.PUBLIC_JOB_DISCOVERY_ADAPTER === "greenhouse" ? "greenhouse" : "fake";
  throw new Error("JobDiscoveryAdapter 环境未获允许");
}
