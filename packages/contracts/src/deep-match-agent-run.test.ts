import { describe, expect, it } from "vitest";
import {
  DEEP_MATCH_AGENT_RUN_BUDGET,
  DEEP_MATCH_AGENT_RUN_STEPS,
  DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION,
  DeepMatchAgentRunExecutionSpecSchema,
} from "./agent-runs";

describe("deep matching agent run execution spec", () => {
  it("has an isolated bounded model budget and exactly three constrained steps", () => {
    expect(DEEP_MATCH_AGENT_RUN_STEPS).toEqual(["select_candidates", "assess_matches", "create_recommendations"]);
    expect(DEEP_MATCH_AGENT_RUN_BUDGET).toMatchObject({ maxModelCalls: 10, maxTokens: 20_000, maxResults: 10 });
  });

  it("accepts a matching spec without changing the discovery fake budget", () => {
    expect(DeepMatchAgentRunExecutionSpecSchema.parse({
      workflowVersion: DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION,
      targetSnapshot: { targetId: "00000000-0000-4000-8000-000000000001", version: 1, priority: "primary", state: "active", constraints: { roleFamily: "frontend", seniority: "senior", locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } } },
      sourceScope: { kind: "deep_match", trigger: "manual" },
      ruleVersion: "deep-match-rules-v1", adapter: "fake-deep-match", adapterVersion: "fake-deep-match-v1", outputSchemaVersion: "deep-match-result-v1", toolAllowlist: [],
      model: { provider: "fake", model: "fake-deep-match-model-v1" }, budget: DEEP_MATCH_AGENT_RUN_BUDGET,
    })).toMatchObject({ workflowVersion: DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION });
  });
});
