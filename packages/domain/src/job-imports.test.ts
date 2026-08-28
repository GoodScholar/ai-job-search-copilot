import { describe, expect, it } from "vitest";
import { createJobImportCommands } from "./job-imports";

const commands = createJobImportCommands({
  db: undefined as never,
  auditTrail: undefined as never,
  contentStore: undefined as never,
  queue: undefined as never,
  id: () => crypto.randomUUID(),
  clock: () => new Date(),
});

describe("job import submission validation", () => {
  it("在任何持久化前拒绝规范化后为空的正文", async () => {
    await expect(commands.submit({
      userId: crypto.randomUUID(), requestId: crypto.randomUUID(),
      command: { inputType: "pasted_text", content: " \r\n\t " },
    })).rejects.toThrow("JOB_IMPORT_CONTENT_INVALID");
  });

  it("按 UTF-8 字节而非 JavaScript 字符数拒绝超过 524288 字节的正文", async () => {
    await expect(commands.submit({
      userId: crypto.randomUUID(), requestId: crypto.randomUUID(),
      command: { inputType: "pasted_text", content: "😀".repeat(131_073) },
    })).rejects.toThrow("JOB_IMPORT_CONTENT_INVALID");
  });
});
