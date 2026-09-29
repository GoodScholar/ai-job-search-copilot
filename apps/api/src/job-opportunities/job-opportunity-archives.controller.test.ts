import { expect, it } from "vitest";
import { JobOpportunityArchiveError } from "@job-copilot/domain/job-opportunity-archives";
import { JobOpportunityArchivesController } from "./job-opportunity-archives.controller.js";

it("归档 API 把归属外资源隐藏为 404，并把版本冲突映射为 409", async () => {
  const controller = new JobOpportunityArchivesController({
    change: async () => { throw new JobOpportunityArchiveError("JOB_OPPORTUNITY_NOT_FOUND"); },
  } as never, {} as never);
  await expect(controller.change({ authenticatedAccount: { userId: "owner" } } as never, { opportunityId: "00000000-0000-4000-8000-000000000001" } as never, {
    action: "archive", commandId: "00000000-0000-4000-8000-000000000002", expectedVersion: 0,
  } as never)).rejects.toMatchObject({ code: "JOB_OPPORTUNITY_NOT_FOUND", status: 404 });

  const conflicting = new JobOpportunityArchivesController({
    change: async () => { throw new JobOpportunityArchiveError("JOB_OPPORTUNITY_ARCHIVE_VERSION_CONFLICT"); },
  } as never, {} as never);
  await expect(conflicting.change({ authenticatedAccount: { userId: "owner" } } as never, { opportunityId: "00000000-0000-4000-8000-000000000001" } as never, {
    action: "restore", commandId: "00000000-0000-4000-8000-000000000003", expectedVersion: 1,
  } as never)).rejects.toMatchObject({ code: "JOB_OPPORTUNITY_ARCHIVE_VERSION_CONFLICT", status: 409 });
});
