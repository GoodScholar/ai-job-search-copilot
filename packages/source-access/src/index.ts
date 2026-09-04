import { createInternalPublicSourceClient } from "./internal.js";

export { PublicSourceAccessError, type PublicSourceAccessFailureCode, type PublicSourceClient } from "./internal.js";
export {
  JOB_PAGE_MAX_BYTES,
  JobPageFetchError,
  SecureJobPageFetcher,
  type FetchedJobPage,
  type JobPageFetcher,
  type JobPageFetchFailureCode,
} from "./job-page-fetcher.js";

/** Production construction accepts only an immutable exact-host capability. */
export function createPublicSourceClient(config: { exactHosts: readonly string[] }) {
  return createInternalPublicSourceClient({
    exactHosts: config.exactHosts,
  });
}
