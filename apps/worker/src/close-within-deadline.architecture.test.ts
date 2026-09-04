import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const files = [
  new URL("./career-import/career-import-consumer.ts", import.meta.url),
  new URL("./heartbeat/redis-heartbeat.adapter.ts", import.meta.url),
  new URL("./agent-runs/agent-run-consumer.ts", import.meta.url),
];

describe("worker close deadline architecture", () => {
  it("keeps one shared implementation and three consumers", async () => {
    const [shared, ...consumers] = await Promise.all([readFile(new URL("./close-within-deadline.ts", import.meta.url), "utf8"), ...files.map((file) => readFile(file, "utf8"))]);
    const importedCount = consumers.filter((source) => source.includes("close-within-deadline.js")).length;
    const localCount = consumers.filter((source) => source.includes("function closeWithinDeadline")).length;
    expect(shared.includes("function closeWithinDeadline") && importedCount === 3 && localCount === 0).toBe(true);
  });
});
