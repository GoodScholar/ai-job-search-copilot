import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const adapterTest = new URL("./agent-runs/anysearch-public-job-adapter.test.ts", import.meta.url);
const e2eTest = new URL("../../web/e2e/anysearch-public-job-discovery.spec.ts", import.meta.url);

function violations(adapter: string, e2e: string): number {
  const bearer = "Bearer " + "${";
  const directValue = "toHaveValue(approvedEntry)";
  const attribute = "toHaveAttribute(" + "\"h" + "ref\"";
  return Number(adapter.includes(bearer)) + Number(e2e.includes(directValue)) + Number(e2e.includes(attribute));
}

describe("review source safety", () => {
  it("keeps sensitive assertion shapes out of failure frames", async () => {
    const [adapter, e2e] = await Promise.all([readFile(adapterTest, "utf8"), readFile(e2eTest, "utf8")]);
    expect(violations(adapter, e2e)).toBe(0);
  });
});
