import * as publicApi from "@job-copilot/domain/verified-job-source-gate";
import { describe, expect, it } from "vitest";

describe("verified job source gate public API", () => {
  it("不向包消费者暴露 claim-bound 终态 mutation", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "VerifiedJobEvidenceStoreUnavailableError",
      "VerifiedJobSourceGateError",
      "createVerifiedJobSourceGate",
    ]);

    const createGate = publicApi.createVerifiedJobSourceGate as unknown as (
      input: unknown,
    ) => Record<string, unknown>;

    expect(Object.keys(createGate({})).sort()).toEqual([
      "reject",
      "verify",
    ]);
  });
});
