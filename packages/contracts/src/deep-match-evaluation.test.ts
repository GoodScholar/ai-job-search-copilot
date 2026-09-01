import { describe, expect, it } from "vitest";
import { FakeDeepMatchAdapter } from "./deep-match";
import { DEEP_MATCH_EVALUATION_VERSION, runDeepMatchEvaluation } from "./deep-match-evaluation";

describe("deep-match-rules-v1 versioned evaluation gate", () => {
  it("keeps the Fake adapter's evidence closure, stable ranking, quality floor, and per-call token ceiling", async () => {
    const report = await runDeepMatchEvaluation(new FakeDeepMatchAdapter());
    expect(report).toEqual({
      evaluationVersion: DEEP_MATCH_EVALUATION_VERSION,
      cases: 2,
      acceptedOpportunityIds: ["00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000011"],
      rejectedOpportunityIds: ["00000000-0000-4000-8000-000000000012"],
    });
  });
});
