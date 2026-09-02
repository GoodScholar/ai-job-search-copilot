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
        jobEvidence: [{ id: "job:skills", value: "TypeScript", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
        profileEvidence: [{ id: "profile:typescript", kind: "profile_fact", profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
      }],
    }, modelCall());

    expect(result.assessments).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 32, outputTokens: 48, latencyMs: 0 });
    expect(result.assessments[0]?.dimensions.map((dimension) => dimension.dimension)).toEqual(DEEP_MATCH_DIMENSIONS);
    expect(result.assessments[0]?.dimensions.every((dimension) => dimension.judgment === "evidence_backed_inference")).toBe(true);
    expect(() => DeepMatchAssessmentSchema.parse(result.assessments[0])).not.toThrow();
  });

  it("returns the exclusion score only for the explicit CI quality fixture", async () => {
    const adapter = new FakeDeepMatchAdapter();
    const result = await adapter.assess({ candidates: [{
      opportunityId: ids.opportunityId, sourcePostingVersionId: ids.sourcePostingVersionId,
      jobEvidence: [{ id: "job:quality", value: "普通岗位描述", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
      profileEvidence: [{ id: "profile:typescript", kind: "profile_fact" as const, profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
    }] }, { ...modelCall(), fixture: { qualityInsufficientOpportunityIds: [ids.opportunityId] } });
    expect(result.assessments[0]).toMatchObject({ overallScore: 30 });
  });

  it("allows an explicit CI-only score fixture to exercise stable deep-match ordering", async () => {
    const adapter = new FakeDeepMatchAdapter();
    const result = await adapter.assess({ candidates: [{
      opportunityId: ids.opportunityId, sourcePostingVersionId: ids.sourcePostingVersionId,
      jobEvidence: [{ id: "job:ordering", value: "普通岗位描述", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
      profileEvidence: [{ id: "profile:typescript", kind: "profile_fact", profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
    }] }, { ...modelCall(), fixture: { overallScoresByOpportunityId: { [ids.opportunityId]: 99 } } });
    expect(result.assessments[0]).toMatchObject({ overallScore: 99 });
  });

  it("does not interpret ordinary job text as a test control signal", async () => {
    const adapter = new FakeDeepMatchAdapter();
    const result = await adapter.assess({ candidates: [{
      opportunityId: ids.opportunityId, sourcePostingVersionId: ids.sourcePostingVersionId,
      jobEvidence: [{ id: "job:ordinary", value: "MATCH_QUALITY_INSUFFICIENT", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
      profileEvidence: [{ id: "profile:typescript", kind: "profile_fact", profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
    }] }, modelCall());
    expect(result.assessments[0]?.overallScore).toBe(80);
  });

  it("does not label a candidate highly matched when most dimensions lack evidence on either side", async () => {
    const adapter = new FakeDeepMatchAdapter();
    const result = await adapter.assess({ candidates: [{
      opportunityId: ids.opportunityId, sourcePostingVersionId: ids.sourcePostingVersionId,
      jobEvidence: [{ id: "job:skills", value: "TypeScript", dimensions: ["skills"] }],
      profileEvidence: [{ id: "profile:typescript", kind: "profile_fact", profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript", dimensions: ["skills"] }],
    }] }, modelCall());

    expect(result.assessments[0]).toMatchObject({ overallScore: 50 });
    expect(result.assessments[0]?.dimensions.filter((dimension) => dimension.judgment === "insufficient_evidence")).toHaveLength(5);
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
      jobEvidence: [{ id: "job:skills", dimensions: ["skills"] }],
      profileEvidence: [{ id: "profile:typescript", dimensions: ["skills"] }],
    })).toThrow(/citation/i);
  });

  it("enforces the automatic matching budget before a model adapter can be called", async () => {
    const adapter = new FakeDeepMatchAdapter();
    const candidate = {
      opportunityId: ids.opportunityId,
      sourcePostingVersionId: ids.sourcePostingVersionId,
      jobEvidence: [{ id: "job:skills", value: "TypeScript", dimensions: [...DEEP_MATCH_DIMENSIONS] },],
      profileEvidence: [{ id: "profile:typescript", kind: "profile_fact" as const, profileFactRevisionId: ids.profileFactRevisionId, value: "TypeScript", dimensions: [...DEEP_MATCH_DIMENSIONS] }],
    };
    await expect(adapter.assess({ candidates: Array.from({ length: DEEP_MATCH_MAX_CANDIDATES + 1 }, () => candidate) }, modelCall())).rejects.toThrow("expected array");
  });
});
