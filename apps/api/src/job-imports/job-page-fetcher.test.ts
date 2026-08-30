import { JOB_PAGE_MAX_BYTES as sharedMaxBytes, JobPageFetchError as SharedJobPageFetchError, SecureJobPageFetcher as SharedSecureJobPageFetcher } from "@job-copilot/source-access";
import { describe, expect, it } from "vitest";
import { JOB_PAGE_MAX_BYTES, JobPageFetchError, SecureJobPageFetcher } from "./job-page-fetcher.js";

describe("job-page-fetcher API adapter", () => {
  it("重导出共享安全验证器而不复制其行为", () => {
    expect(SecureJobPageFetcher).toBe(SharedSecureJobPageFetcher);
    expect(JobPageFetchError).toBe(SharedJobPageFetchError);
    expect(JOB_PAGE_MAX_BYTES).toBe(sharedMaxBytes);
  });
});
