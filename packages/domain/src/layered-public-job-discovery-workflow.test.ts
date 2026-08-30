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
        search: async ({ query, beforeRequest }) => {
          await beforeRequest();
          calls.push(`search:${query.queryId}`);
          return { candidates: [{ normalizedUrl: "https://careers.example.com/jobs/1", stableFingerprint: "a".repeat(64) }] };
        },
        extract: async ({ beforeRequest }) => { await beforeRequest(); calls.push("extract"); return { normalizedUrl: "https://careers.example.com/jobs/1" }; },
      },
      preflight: async () => ({ normalizedUrl: "https://careers.example.com/jobs/1" }),
      leads: { recordPending: async () => { calls.push("pending"); return { leadId: "66666666-6666-8666-8666-666666666666" }; } },
      fetcher: { fetch: async () => { calls.push("fetch"); return { requestedUrl: "https://careers.example.com/jobs/1", finalUrl: "https://careers.example.com/jobs/1", canonicalUrl: "https://careers.example.com/jobs/1", rawHtml: "<h1>AI Engineer</h1>", visibleText: "AI Engineer", pageClassification: "job", sourceKind: "official" }; } },
      gate: { verify: async () => { calls.push("verify"); return { sourcePostingVersionId: "77777777-7777-8777-8777-777777777777" }; }, reject: async () => { calls.push("reject"); } },
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
    const result = await workflow.run({ userId: targetId, runId, now: new Date(), executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async ({ kind }) => { calls.push(`checkpoint:${kind}`); }, signal: new AbortController().signal });

    expect(calls).toEqual(["trusted", "checkpoint:search", `search:${queryId}`, "pending", "checkpoint:extract", "extract", "checkpoint:fetch", "fetch", "verify"]);
    expect(result).toEqual({ hasTrustedSuccess: true, branchSuccess: { trusted: true, publicDiscovery: true }, sourcePostingVersionIds: ["44444444-4444-8444-8444-444444444444", "77777777-7777-8777-8777-777777777777"], trustedSourcePostingVersionIds: ["44444444-4444-8444-8444-444444444444"], sourceIssues: [], diagnostics: [] });
    expect(JSON.stringify(result)).not.toContain("careers.example.com");
  });

  it("未配置 provider 不调用 beforeRequest，因此不占用物理 search 预算", async () => {
    let checkpoints = 0; let posts = 0;
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async () => ({ error: { code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, httpStatus: null } }),
        extract: async () => { throw new Error("UNUSED"); },
      },
      preflight: async () => null,
      leads: { recordPending: async () => ({ leadId: "66666666-6666-8666-8666-666666666666" }) },
      fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
      gate: { verify: async () => ({ sourcePostingVersionId: "77777777-7777-8777-8777-777777777777" }), reject: async () => undefined },
    });
    const executionSpec = {
      targetSnapshot: { targetId, version: 1, priority: "primary" as const, state: "active" as const, constraints: { roleFamily: "AI 工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } } },
      profileSnapshot: { targetId, version: 1, confirmedActiveSkillNames: [] }, watchlistSnapshot: { targetId, version: 0, companies: [] },
      sourceScope: { kind: "layered_public" as const, trustedSources: [], publicDiscovery: { provider: "anysearch" as const, queries: [{ ordinal: 1, queryId, kind: "general" as const, stableFingerprint: "b".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 as const }], batchSize: 5 as const, maxVerificationCandidates: 10 as const } },
      workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, adapter: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, adapterVersion: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, toolAllowlist: ["job_discovery.list_source", "job_discovery.search", "job_discovery.extract", "job_discovery.fetch"] as const, model: null, budget: PUBLIC_JOB_DISCOVERY_BUDGET,
    };
    executionSpec.sourceScope.publicDiscovery.queries.push({ ordinal: 2, queryId: "88888888-8888-8888-8888-888888888888", kind: "general", stableFingerprint: "c".repeat(64), query: "AI 工程师 远程", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 });
    const outcome = await workflow.run({ userId: targetId, runId, now: new Date(), executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async () => { checkpoints += 1; }, signal: new AbortController().signal });
    expect({ posts, checkpoints, outcome }).toEqual({ posts: 0, checkpoints: 0, outcome: expect.objectContaining({ hasTrustedSuccess: false, diagnostics: [expect.objectContaining({ scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 2 })], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 2 }] }) });
  });
});
