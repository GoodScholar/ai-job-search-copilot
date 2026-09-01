import { describe, expect, it } from "vitest";
import { runDeepMatchWorkflow } from "./deep-match-workflow";

const candidate = {
  opportunityId: "00000000-0000-4000-8000-000000000001", sourcePostingVersionId: "00000000-0000-4000-8000-000000000002",
  triageVersionId: "00000000-0000-4000-8000-000000000003", profileId: "00000000-0000-4000-8000-000000000004", profileVersion: 1, targetVersion: 1, overallScore: 80,
  jobEvidence: [{ id: "job:1", value: "TypeScript" }], profileEvidence: [{ id: "profile:1", profileFactRevisionId: "00000000-0000-4000-8000-000000000005", value: "TypeScript" }],
};

describe("deep match workflow", () => {
  it("runs only the selected budgeted candidates and creates a daily immutable list", async () => {
    const created: string[] = [];
    const result = await runDeepMatchWorkflow({
      userId: "00000000-0000-4000-8000-000000000006", targetId: "00000000-0000-4000-8000-000000000007",
      queries: { selectCandidates: async () => Array.from({ length: 12 }, () => candidate) },
      commands: { createMatch: async ({ candidate: item }) => ({ matchVersionId: `match-${created.push(item.opportunityId)}`, sequence: created.length, overallScore: 80, displayBand: "highly_matched" as const }), createDailyList: async ({ matchVersionIds }) => ({ recommendationListId: "list", targetId: "x", localDate: "2026-09-01", sequence: 1, items: matchVersionIds.map((matchVersionId, index) => ({ matchVersionId, highlighted: index < 3, ordinal: index + 1 })) }) },
    });
    expect(created).toHaveLength(10);
    expect(result.items).toHaveLength(10);
    expect(result.items.filter((item) => item.highlighted)).toHaveLength(3);
  });
});
