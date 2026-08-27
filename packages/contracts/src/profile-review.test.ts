import { describe, expect, it } from "vitest";
import {
  CandidateFactDecisionCommandSchema,
  CreateProfileFactCommandSchema,
  ProfileFactSchema,
  ProfileSnapshotSchema,
  ReviseProfileFactCommandSchema,
} from "./profile-review";

const id = () => crypto.randomUUID();
const now = "2026-08-27T00:00:00.000Z";

describe("profile review contracts", () => {
  it("accepts a manually maintained work eligibility fact", () => {
    expect(CreateProfileFactCommandSchema.parse({
      expectedVersion: 0,
      factType: "work_eligibility",
      factValue: { summary: "中国大陆，可合法工作" },
    })).toEqual({
      expectedVersion: 0,
      factType: "work_eligibility",
      factValue: { summary: "中国大陆，可合法工作" },
    });
  });

  it("requires a correction reason and value while keeping confirmation and rejection narrow", () => {
    expect(CandidateFactDecisionCommandSchema.parse({
      expectedVersion: 2,
      decision: "confirmed",
    })).toMatchObject({ decision: "confirmed" });
    expect(CandidateFactDecisionCommandSchema.parse({
      expectedVersion: 2,
      decision: "rejected",
    })).toMatchObject({ decision: "rejected" });
    expect(CandidateFactDecisionCommandSchema.parse({
      expectedVersion: 2,
      decision: "corrected",
      factValue: { name: "TypeScript" },
      reason: "补充实际技能名称",
    })).toMatchObject({ decision: "corrected", reason: "补充实际技能名称" });
    expect(() => CandidateFactDecisionCommandSchema.parse({
      expectedVersion: 2,
      decision: "corrected",
      factValue: { name: "TypeScript" },
    })).toThrow();
    expect(() => CandidateFactDecisionCommandSchema.parse({
      expectedVersion: 2,
      decision: "rejected",
      reason: "不相关",
    })).toThrow();
  });

  it("requires a reason to revise a manually maintained fact", () => {
    expect(ReviseProfileFactCommandSchema.safeParse({
      expectedVersion: 1,
      factValue: { name: "React" },
      reason: "更新主要技术栈",
    }).success).toBe(true);
    expect(ReviseProfileFactCommandSchema.safeParse({
      expectedVersion: 1,
      factValue: { name: "React" },
    }).success).toBe(false);
  });

  it("returns only active current profile fact revisions in a trusted snapshot", () => {
    expect(ProfileSnapshotSchema.parse({
      profileId: id(),
      version: 3,
      facts: [{
        factId: id(),
        revisionId: id(),
        factType: "language",
        factValue: { name: "英语", level: "专业工作水平" },
        source: "candidate_fact",
        candidateFactId: id(),
        createdAt: now,
      }],
    })).toMatchObject({ version: 3, facts: [{ source: "candidate_fact" }] });
    expect(ProfileFactSchema.safeParse({
      factId: id(),
      revisionId: id(),
      factType: "skill",
      factValue: { name: "TypeScript" },
      source: "candidate_fact",
      createdAt: now,
      state: "removed",
    }).success).toBe(false);
  });

  it("does not add work eligibility to imported-candidate decisions", () => {
    expect(CandidateFactDecisionCommandSchema.safeParse({
      expectedVersion: 0,
      decision: "corrected",
      factValue: { summary: "中国大陆，可合法工作" },
      reason: "人工确认",
      factType: "work_eligibility",
    }).success).toBe(false);
  });
});
