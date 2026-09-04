import { describe, expect, it } from "vitest";
import { deepMatchDiscoveryIdempotencyKey } from "./deep-match-agent-runs";

describe("deep match discovery trigger", () => {
  it("derives a stable UUID idempotency key from one completed discovery run", () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    expect(deepMatchDiscoveryIdempotencyKey(runId)).toBe(deepMatchDiscoveryIdempotencyKey(runId));
    expect(deepMatchDiscoveryIdempotencyKey(runId)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
