import { describe, expect, it } from "vitest";
import { CareerFactConflictReviewError } from "./career-fact-conflict-review";

describe("career fact conflict review", () => {
  it("exposes stable conflict review failures", () => {
    expect(new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_NOT_FOUND").code).toBe("CAREER_FACT_CONFLICT_NOT_FOUND");
  });
});
