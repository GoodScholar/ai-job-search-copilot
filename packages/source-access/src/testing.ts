import { PublicSourceAccessError, createInternalPublicSourceClient, type InternalPublicSourceClientConfig } from "./internal.js";

type TestingOverrides = Omit<InternalPublicSourceClientConfig, "exactHosts" | "appEnv">;

/** Test-only construction seam. HTTP test origins work only under the real APP_ENV=test. */
export function createPublicSourceClientForTest(config: { exactHosts: readonly string[] } & TestingOverrides) {
  if (process.env.APP_ENV !== "test") throw new PublicSourceAccessError("PUBLIC_SOURCE_TESTING_DISABLED");
  return createInternalPublicSourceClient({
    ...config,
    allowTestTransport: config.transport !== undefined,
  });
}
