import { describe, expect, it } from "vitest";

import { jobImportAttemptContext } from "./job-import-consumer.js";

describe("jobImportAttemptContext", () => {
  it("将 BullMQ 的零起始 attemptsMade 映射为审计的一起始 attemptCount", () => {
    expect(jobImportAttemptContext(0, 3)).toEqual({ attemptCount: 1, finalAttempt: false });
    expect(jobImportAttemptContext(2, 3)).toEqual({ attemptCount: 3, finalAttempt: true });
  });
});
