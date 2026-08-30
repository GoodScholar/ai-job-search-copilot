import { PublicSourceAccessError, createInternalPublicSourceClient, type InternalPublicSourceClientConfig } from "./internal.js";

type TestingOverrides = Omit<InternalPublicSourceClientConfig, "exactHosts" | "appEnv">;
export type TestPublicSourceClient = ReturnType<typeof createInternalPublicSourceClient> & { hostPermitCountForTest(): number };

/** Test-only construction seam. HTTP test origins work only under the real APP_ENV=test. */
export function createPublicSourceClientForTest(config: { exactHosts: readonly string[] } & TestingOverrides): TestPublicSourceClient {
  if (process.env.APP_ENV !== "test") throw new PublicSourceAccessError("PUBLIC_SOURCE_TESTING_DISABLED");
  const hasInjectedNetwork = config.transport !== undefined && config.lookup !== undefined;
  return createInternalPublicSourceClient({
    ...config,
    allowTestTransport: hasInjectedNetwork,
    allowTesting: true,
    allowTestOrigin: hasInjectedNetwork || isLoopbackLiteralOrigin(config.testOrigin),
    exposeHostPermitCountForTesting: true,
  }) as TestPublicSourceClient;
}

function isLoopbackLiteralOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/gu, "");
    return hostname === "::1" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
