import { describe, expect, it } from "vitest";
import {
  DEEP_MATCH_DIMENSIONS,
  DEEP_MATCH_MAX_CANDIDATES,
  DeepMatchAssessmentSchema,
  FakeDeepMatchAdapter,
  validateDeepMatchEvidenceClosure,
} from "./deep-match";

const ids = {
  opportunityId: "00000000-0000-4000-8000-000000000001",
  sourcePostingVersionId: "00000000-0000-4000-8000-000000000002",
  profileFactRevisionId: "00000000-0000-4000-8000-000000000003",
};
const modelCall = () => ({ signal: new AbortController().signal, usageKey: "test-model-call", budget: { maxTokens: 20_000, reservedInputTokens: 32, reservedOutputTokens: 48 } });

describe("FakeDeepMatchAdapter", () => {
  it("produces all six dimensions with closed job and confirmed-profile evidence", async () => {
    const adapter = new FakeDeepMatchAdapter();
    const result = await adapter.assess({
      candidates: [{
        opportunityId: ids.opportunityId,
        sourcePostingVersionId: ids.sourcePostingVersionId,
        jobEvidence: [{ id: "job:skills", value: "TypeScript" }],
        profileEvidence: [{ id: "profile:typescript", profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript" }],
      }],
    }, modelCall());

    expect(result).toHaveLength(1);
    expect(result[0]?.dimensions.map((dimension) => dimension.dimension)).toEqual(DEEP_MATCH_DIMENSIONS);
    expect(result[0]?.dimensions.every((dimension) => dimension.judgment === "evidence_backed_inference")).toBe(true);
    expect(() => DeepMatchAssessmentSchema.parse(result[0])).not.toThrow();
  });

  it("returns the exclusion score only for the explicit CI quality fixture", async () => {
    const adapter = new FakeDeepMatchAdapter();
    const result = await adapter.assess({ candidates: [{
      opportunityId: ids.opportunityId, sourcePostingVersionId: ids.sourcePostingVersionId,
      jobEvidence: [{ id: "job:quality", value: "MATCH_QUALITY_INSUFFICIENT" }],
      profileEvidence: [{ id: "profile:typescript", profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript" }],
    }] }, modelCall());
    expect(result[0]).toMatchObject({ overallScore: 50 });
  });

  it("rejects model output whose citation is absent from the supplied evidence closure", () => {
    const invalid = DeepMatchAssessmentSchema.parse({
      opportunityId: ids.opportunityId,
      overallScore: 80,
      dimensions: DEEP_MATCH_DIMENSIONS.map((dimension) => ({
        dimension,
        score: 80,
        judgment: "evidence_backed_inference",
        jobEvidenceIds: ["job:not-provided"],
        profileEvidenceIds: ["profile:not-provided"],
        summary: "有匹配证据",
      })),
    });
    expect(() => validateDeepMatchEvidenceClosure(invalid, {
      jobEvidenceIds: ["job:skills"],
      profileEvidenceIds: ["profile:typescript"],
    })).toThrow(/citation/i);
  });

  it("enforces the automatic matching budget before a model adapter can be called", async () => {
    const adapter = new FakeDeepMatchAdapter();
    const candidate = {
      opportunityId: ids.opportunityId,
      sourcePostingVersionId: ids.sourcePostingVersionId,
      jobEvidence: [{ id: "job:skills", value: "TypeScript" }],
      profileEvidence: [{ id: "profile:typescript", profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript" }],
    };
    await expect(adapter.assess({ candidates: Array.from({ length: DEEP_MATCH_MAX_CANDIDATES + 1 }, () => candidate) }, modelCall())).rejects.toThrow("expected array");
  });
});
