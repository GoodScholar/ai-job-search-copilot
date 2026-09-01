import { describe, expect, it } from "vitest";
import { CreateJobTriageVersionCommandSchema, JobTriageVersionSchema } from "./job-triage";

describe("job triage contracts", () => {
  it("requires a strict target selection when creating a triage version", () => {
    expect(CreateJobTriageVersionCommandSchema.parse({ targetId: "00000000-0000-4000-8000-000000000001" }))
      .toEqual({ targetId: "00000000-0000-4000-8000-000000000001" });
    expect(() => CreateJobTriageVersionCommandSchema.parse({ targetId: "00000000-0000-4000-8000-000000000001", unexpected: true }))
      .toThrow();
  });

  it("exposes evidence references and scored-dimension explanations without source prose", () => {
    const passedLocation = { verdict: "pass" as const, reasonCode: "LOCATION_ALLOWED", jobEvidence: { sourcePostingVersionId: "00000000-0000-4000-8000-000000000004", field: "location", path: "location", value: "上海" }, candidateEvidence: { kind: "target_constraint" as const, path: "locations" } };
    const version = JobTriageVersionSchema.parse({
      triageVersionId: "00000000-0000-4000-8000-000000000002",
      opportunityId: "00000000-0000-4000-8000-000000000003",
      targetId: "00000000-0000-4000-8000-000000000001",
      overallVerdict: "pass",
      gateResults: {
        location: passedLocation, work_mode: passedLocation, relocation: passedLocation, salary: passedLocation,
        seniority: passedLocation, education: passedLocation, language: passedLocation,
        work_eligibility: passedLocation, deal_breakers: passedLocation,
      },
      pendingItems: [], deadlineStatus: "valid", confidenceBasisPoints: 10000,
      dimensionScores: {
        technical: { score: 50, reasonCode: "REQUIRED_SKILLS_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: ["job.requirements"] },
        experience: { score: 50, reasonCode: "EXPERIENCE_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: ["profile.experience"] },
        targetAlignment: { score: 50, reasonCode: "TARGET_ALIGNMENT_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: ["target.alignment"] },
      },
      overallScore: 50, threshold: 60, sequence: 1, createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(version.dimensionScores?.experience).toMatchObject({ score: 50, missing: ["profile.experience"] });
    expect(() => JobTriageVersionSchema.parse({ ...version, sourceProse: "不得记录" })).toThrow();
    expect(() => JobTriageVersionSchema.parse({ ...version, gateResults: { ...version.gateResults, location: { ...passedLocation, reasonCode: "UNRECOGNIZED_REASON" } } })).toThrow();
  });
});
