import { createInternalPublicSourceClient } from "./internal.js";

export { PublicSourceAccessError, type PublicSourceAccessFailureCode, type PublicSourceClient } from "./internal.js";

/** Production construction accepts only an immutable exact-host capability. */
export function createPublicSourceClient(config: { exactHosts: readonly string[] }) {
  return createInternalPublicSourceClient({
    exactHosts: config.exactHosts,
    testOrigin: process.env.APP_ENV === "test" ? process.env.PUBLIC_SOURCE_TEST_ORIGIN : undefined,
  });
}
