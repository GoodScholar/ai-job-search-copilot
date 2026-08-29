import { createInternalPublicSourceClient, type InternalPublicSourceClientConfig } from "./internal.js";

type TestingOverrides = Omit<InternalPublicSourceClientConfig, "exactHosts" | "appEnv">;

/** Test-only construction seam. HTTP test origins work only under the real APP_ENV=test. */
export function createPublicSourceClientForTest(config: { exactHosts: readonly string[] } & TestingOverrides) {
  return createInternalPublicSourceClient({ ...config, allowTestTransport: config.transport !== undefined });
}
