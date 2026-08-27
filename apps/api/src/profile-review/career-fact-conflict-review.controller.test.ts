import { describe, expect, it } from "vitest";
import { CareerFactConflictReviewController } from "./career-fact-conflict-review.controller.js";
import { CareerFactConflictReviewError } from "@job-copilot/domain/career-fact-conflict-review";

const userId = "3e153c8c-d85d-4ec3-8f01-7c08e0b94c36";
const conflictId = "c6294ea2-91c3-4b3f-938b-7cc435e7d130";
const request = { authenticatedAccount: { userId }, requestId: "adfbd5ec-4b3a-4b63-af71-f1635205704c" } as never;

describe("CareerFactConflictReviewController", () => {
  it("passes the session owner, request id and strict command to the deep module", async () => {
    const calls: unknown[] = [];
    const controller = new CareerFactConflictReviewController({ resolve: async (input: unknown) => { calls.push(input); return { profile: { version: 1, facts: [] } }; } } as never);
    await expect(controller.resolve(request, { conflictId }, { expectedVersion: 0, resolution: "use_existing" })).resolves.toMatchObject({ profile: { version: 1 } });
    expect(calls).toEqual([expect.objectContaining({ userId, conflictId, requestId: expect.any(String), command: { expectedVersion: 0, resolution: "use_existing" } })]);
  });

  it.each([
    ["notfound", new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_NOT_FOUND"), 404],
    ["version", new CareerFactConflictReviewError("PROFILE_VERSION_CONFLICT"), 409],
    ["resolved", new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_ALREADY_RESOLVED"), 409],
    ["incompatible", new CareerFactConflictReviewError("CAREER_FACT_CONFLICT_DECISION_INCOMPATIBLE"), 400],
  ])("maps %s without exposing fact contents", async (_name, error, status) => {
    const controller = new CareerFactConflictReviewController({ resolve: async () => { throw error; } } as never);
    await expect(controller.resolve(request, { conflictId }, { expectedVersion: 0, resolution: "use_existing" })).rejects.toMatchObject({ status });
  });
});
