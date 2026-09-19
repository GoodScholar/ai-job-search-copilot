import { expect, it } from "vitest";
import { JobOpportunityArchiveCommandSchema, JobOpportunityArchivePageSchema } from "./job-opportunity-archives";

it("归档命令和归档清单公开当前状态而不携带推荐或忽略字段", () => {
  expect(JobOpportunityArchiveCommandSchema.parse({
    action: "archive", commandId: "00000000-0000-4000-8000-000000000001", expectedVersion: 0,
  })).toEqual({ action: "archive", commandId: "00000000-0000-4000-8000-000000000001", expectedVersion: 0 });
  expect(JobOpportunityArchivePageSchema.parse({
    items: [{ opportunityId: "00000000-0000-4000-8000-000000000002", company: "示例科技", title: "前端工程师", location: "上海", archivedAt: "2026-09-15T08:00:00.000Z", version: 1 }],
    nextCursor: null,
    counts: { active: 3, archived: 1 },
  })).toMatchObject({ counts: { active: 3, archived: 1 } });
});
