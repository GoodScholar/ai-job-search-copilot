import { expect, it } from "vitest";
import { JobExportCommandSchema, JobExportListSchema, JobExportSchema } from "./job-exports";

it("岗位导出契约只接受版本化命令和脱敏的导出快照", () => {
  const exportId = "00000000-0000-4000-8000-000000000001";
  expect(JobExportCommandSchema.parse({ commandId: exportId, filter: "all", fieldVersion: 1 })).toEqual({ commandId: exportId, filter: "all", fieldVersion: 1 });
  expect(JobExportCommandSchema.safeParse({ commandId: exportId, filter: "all", fieldVersion: 2 }).success).toBe(false);

  const snapshot = {
    id: exportId,
    status: "ready",
    filter: "active",
    fieldVersion: 1,
    rowCount: 1,
    createdAt: "2026-09-19T00:00:00.000Z",
    expiresAt: "2026-09-20T00:00:00.000Z",
    failureCode: null,
  };
  expect(JobExportSchema.parse(snapshot)).toEqual(snapshot);
  expect(JobExportListSchema.parse({ items: [snapshot] })).toEqual({ items: [snapshot] });
  expect(JobExportSchema.safeParse({ ...snapshot, objectKey: "must-not-escape" }).success).toBe(false);
});
