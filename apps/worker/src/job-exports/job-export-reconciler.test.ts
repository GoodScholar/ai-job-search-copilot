import { expect, it } from "vitest";
import { JobExportReconciler } from "./job-export-reconciler";

it("入队故障不会阻止过期对象在后续扫描中清理", async () => {
  const deleted: string[] = [];
  const marked: string[] = [];
  const reconciler = new JobExportReconciler({
    queries: {
      expire: async () => undefined,
      listRecoverable: async () => [{ version: 1, exportId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" }],
      listCleanupPending: async () => [{ exportId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002", objectKey: "accounts/a/job-exports/e.csv" }],
      markObjectDeleted: async (item: { exportId: string }) => { marked.push(item.exportId); },
    } as never,
    queue: { enqueue: async () => { throw new Error("redis unavailable"); } },
    store: { put: async () => undefined, get: async () => new Uint8Array(), delete: async ({ objectKey }) => { deleted.push(objectKey); } },
  });

  await reconciler.onModuleInit();
  await reconciler.close();
  expect(deleted).toEqual(["accounts/a/job-exports/e.csv"]);
  expect(marked).toEqual(["00000000-0000-4000-8000-000000000001"]);
});
