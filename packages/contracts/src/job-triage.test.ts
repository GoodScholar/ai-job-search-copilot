import { describe, expect, it } from "vitest";
import { CreateJobTriageVersionCommandSchema, EvidenceGapSchema, JOB_TRIAGE_MAX_CANDIDATE_EVIDENCE_VALUE_LENGTH, JOB_TRIAGE_MAX_JOB_EVIDENCE_VALUE_LENGTH, JobTriageVersionSchema } from "./job-triage";

describe("job triage contracts", () => {
  it("requires a strict target selection when creating a triage version", () => {
    expect(CreateJobTriageVersionCommandSchema.parse({ targetId: "00000000-0000-4000-8000-000000000001" }))
      .toEqual({ targetId: "00000000-0000-4000-8000-000000000001" });
    expect(() => CreateJobTriageVersionCommandSchema.parse({ targetId: "00000000-0000-4000-8000-000000000001", unexpected: true }))
      .toThrow();
  });

  it("exposes evidence references and scored-dimension explanations without source prose", () => {
    const passedLocation = { verdict: "pass" as const, reasonCode: "LOCATION_ALLOWED", jobEvidence: { sourcePostingVersionId: "00000000-0000-4000-8000-000000000004", field: "location", path: "location", value: "上海" }, candidateEvidence: { kind: "target_constraint" as const, targetId: "00000000-0000-4000-8000-000000000001", version: 1, path: "locations", label: "求职目标条件", value: "上海" } };
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
        technical: { score: 50, reasonCode: "REQUIRED_SKILLS_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: [{ kind: "job_requirements" }] },
        experience: { score: 50, reasonCode: "EXPERIENCE_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: [{ kind: "profile_experience" }] },
        targetAlignment: { score: 50, reasonCode: "TARGET_ALIGNMENT_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: [{ kind: "target_alignment" }] },
      },
      overallScore: 50, threshold: 60, sequence: 1, createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(version.dimensionScores?.experience).toMatchObject({ score: 50, missing: [{ kind: "profile_experience" }] });
    expect(() => JobTriageVersionSchema.parse({ ...version, sourceProse: "不得记录" })).toThrow();
    expect(() => JobTriageVersionSchema.parse({ ...version, gateResults: { ...version.gateResults, location: { ...passedLocation, reasonCode: "UNRECOGNIZED_REASON" } } })).toThrow();
  });

  it("以共享、有界的结构化缺口和证据文本保护公开三态结果", () => {
    expect(EvidenceGapSchema.parse({ kind: "profile_skills", count: 100, examples: Array.from({ length: 20 }, (_, index) => `技能${index + 1}`) }))
      .toMatchObject({ kind: "profile_skills", count: 100 });
    expect(() => EvidenceGapSchema.parse({ kind: "profile_skills", count: 101, examples: ["技能"] })).toThrow();

    const version = JobTriageVersionSchema.parse({
      triageVersionId: "00000000-0000-4000-8000-000000000002", opportunityId: "00000000-0000-4000-8000-000000000003", targetId: "00000000-0000-4000-8000-000000000001", overallVerdict: "pass",
      gateResults: Object.fromEntries(["location", "work_mode", "relocation", "salary", "seniority", "education", "language", "work_eligibility", "deal_breakers"].map((gate) => [gate, { verdict: "pass", reasonCode: "LOCATION_ALLOWED", jobEvidence: { sourcePostingVersionId: "00000000-0000-4000-8000-000000000004", field: "location", path: "location", value: "岗位".repeat(200).slice(0, JOB_TRIAGE_MAX_JOB_EVIDENCE_VALUE_LENGTH) }, candidateEvidence: { kind: "target_constraint", targetId: "00000000-0000-4000-8000-000000000001", version: 1, path: "locations", label: "求职目标条件", value: "目标".repeat(200).slice(0, JOB_TRIAGE_MAX_CANDIDATE_EVIDENCE_VALUE_LENGTH) } }])),
      pendingItems: [], deadlineStatus: "valid", confidenceBasisPoints: 0,
      dimensionScores: {
        technical: { score: 50, reasonCode: "REQUIRED_SKILLS_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: [{ kind: "profile_skills", count: 100, examples: Array.from({ length: 20 }, (_, index) => `技能${index + 1}`) }] },
        experience: { score: 50, reasonCode: "EXPERIENCE_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: [{ kind: "profile_experience" }] },
        targetAlignment: { score: 50, reasonCode: "TARGET_ALIGNMENT_EVIDENCE_MISSING_NEUTRAL", jobEvidence: [], candidateEvidence: [], missing: [{ kind: "target_alignment" }] },
      }, overallScore: 50, threshold: 60, sequence: 1, createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(version.dimensionScores?.technical.missing).toHaveLength(1);
    expect(() => JobTriageVersionSchema.parse({ ...version, dimensionScores: { ...version.dimensionScores!, technical: { ...version.dimensionScores!.technical, jobEvidence: [{ sourcePostingVersionId: "00000000-0000-4000-8000-000000000004", field: "title", path: "title", value: "x".repeat(JOB_TRIAGE_MAX_JOB_EVIDENCE_VALUE_LENGTH + 1) }] } } })).toThrow();
  });
});
