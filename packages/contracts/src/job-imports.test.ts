import { describe, expect, it } from "vitest";
import {
  CreateJobImportCommandSchema,
  JobImportDetailSchema,
} from "./job-imports";

describe("job import contracts", () => {
  const importId = "20f47b34-2ec9-4429-9b22-ff60244eb60a";
  const opportunityId = "9e7da78b-9405-49c9-8ca8-45e92bb18487";
  const sourcePostingId = "138cb799-6e0d-43ac-9285-8119dca89ce1";
  const sourcePostingVersionId = "c855fb30-1a1b-490c-9e2e-4e454ea801f2";
  const now = "2026-08-28T00:00:00.000Z";

  it("accepts a pasted job description", () => {
    expect(CreateJobImportCommandSchema.parse({
      inputType: "pasted_text",
      content: "# 高级前端工程师\n公司：示例科技",
    })).toEqual({ inputType: "pasted_text", content: "# 高级前端工程师\n公司：示例科技" });
  });

  it("accepts a completed import without exposing stored source content", () => {
    expect(JobImportDetailSchema.parse({
      importId, inputType: "pasted_text", originalFilename: null,
      status: "completed", failureCode: null,
      createdAt: now, updatedAt: now,
      opportunity: {
        opportunityId, company: "示例科技", title: "高级前端工程师",
        location: null, postedAt: null, deadline: null,
        description: null,
        evidence: { sourcePostingId, sourcePostingVersionId, version: 1,
          sourceType: "user_import", retrievedAt: now, originalFilename: null },
      },
    })).toBeDefined();
  });
});
