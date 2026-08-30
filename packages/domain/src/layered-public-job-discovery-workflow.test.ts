import { describe, expect, it } from "vitest";
import {
  PUBLIC_JOB_DISCOVERY_BUDGET,
} from "@job-copilot/contracts/agent-runs";
import {
  LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER,
  LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION,
  LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
  LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION,
  LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION,
} from "@job-copilot/contracts/job-discovery";
import { createLayeredPublicJobDiscoveryWorkflow } from "./layered-public-job-discovery-workflow";

const runId = "11111111-1111-8111-8111-111111111111";
const targetId = "22222222-2222-8222-8222-222222222222";
const queryId = "33333333-3333-8333-8333-333333333333";

describe("layered public job discovery workflow", () => {
  it("在同一 run 调度可信来源和 AnySearch，并仅返回脱敏事实", async () => {
    const calls: string[] = [];
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: {
        discover: async () => {
          calls.push("trusted");
          return { verifiedSourcePostingVersionIds: ["44444444-4444-8444-8444-444444444444"] };
        },
      },
      anySearch: {
        search: async ({ query }) => {
          calls.push(`search:${query.queryId}`);
          return { candidates: [{ normalizedUrl: "https://careers.example.com/jobs/1", stableFingerprint: "a".repeat(64) }] };
        },
      },
    });

    const executionSpec = {
      targetSnapshot: {
        targetId, version: 1, priority: "primary" as const, state: "active" as const,
        constraints: { roleFamily: "AI 工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } },
      },
      profileSnapshot: { targetId, version: 1, confirmedActiveSkillNames: [] },
      watchlistSnapshot: { targetId, version: 0, companies: [] },
      sourceScope: {
        kind: "layered_public" as const,
        trustedSources: [{ kind: "greenhouse_trusted_source" as const, source: { sourceId: "greenhouse:example", watchlistItemId: "55555555-5555-8555-8555-555555555555", canonicalCompanyName: "Example", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "example" } }],
        publicDiscovery: { provider: "anysearch" as const, queries: [{ ordinal: 1, queryId, kind: "general" as const, stableFingerprint: "b".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 as const }], batchSize: 5 as const, maxVerificationCandidates: 10 as const },
      },
      workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION,
      ruleVersion: LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION,
      adapter: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER,
      adapterVersion: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION,
      outputSchemaVersion: LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
      toolAllowlist: ["job_discovery.list_source", "job_discovery.search", "job_discovery.extract", "job_discovery.fetch"] as const,
      model: null,
      budget: PUBLIC_JOB_DISCOVERY_BUDGET,
    };
    const result = await workflow.run({ runId, executionSpec });

    expect(calls).toEqual(["trusted", `search:${queryId}`]);
    expect(result).toEqual({
      verifiedSourcePostingVersionIds: ["44444444-4444-8444-8444-444444444444"],
      candidates: [{ queryId, kind: "general", stableFingerprint: "a".repeat(64) }],
      diagnostics: [],
    });
    expect(JSON.stringify(result)).not.toContain("careers.example.com");
  });
});
