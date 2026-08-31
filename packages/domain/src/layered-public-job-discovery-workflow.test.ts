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
import { createLayeredPublicJobDiscoveryWorkflow, LayeredPublicWorkflowInterruption } from "./layered-public-job-discovery-workflow";
import { createLayeredPublicJobDiscoveryRuntime } from "./layered-public-job-discovery-runtime";

const runId = "11111111-1111-8111-8111-111111111111";
const targetId = "22222222-2222-8222-8222-222222222222";
const queryId = "33333333-3333-8333-8333-333333333333";

function executionSpecFor(queries: Array<Record<string, unknown>>, trustedSources: unknown[] = []) {
  return {
    targetSnapshot: { targetId, version: 1, priority: "primary" as const, state: "active" as const, constraints: { roleFamily: "AI 工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } } },
    profileSnapshot: { targetId, version: 1, confirmedActiveSkillNames: [] },
    watchlistSnapshot: { targetId, version: 0, companies: [] },
    sourceScope: { kind: "layered_public" as const, trustedSources, publicDiscovery: { provider: "anysearch" as const, queries, batchSize: 5 as const, maxVerificationCandidates: 10 as const } },
    workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, adapter: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, adapterVersion: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, toolAllowlist: ["job_discovery.list_source", "job_discovery.search", "job_discovery.extract", "job_discovery.fetch"] as const, model: null, budget: PUBLIC_JOB_DISCOVERY_BUDGET,
  };
}

describe("layered public job discovery workflow", () => {
  it("进程重建后从同一 run 的 pending Lead 恢复 capability，即使新的 search 已经 clean-zero", async () => {
    const pending = {
      leadId: "66666666-6666-8666-8666-666666666666", userId: targetId, runId, queryId,
      queryFingerprint: "b".repeat(64), normalizedUrl: "https://careers.example.com/jobs/1",
      stableFingerprint: "a".repeat(64), allowedSiteDomains: [],
    };
    let pendingPersisted = false;
    const firstProcess = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ beforeRequest }) => { await beforeRequest(); return { candidates: [{ normalizedUrl: pending.normalizedUrl, stableFingerprint: pending.stableFingerprint }] }; },
        extract: async ({ beforeRequest }) => { await beforeRequest(); throw new Error("UNUSED"); },
      },
      preflight: async ({ candidate }) => ({ normalizedUrl: candidate.normalizedUrl }),
      leads: { recordPendingForClaim: async () => { pendingPersisted = true; return { leadId: pending.leadId }; } },
      fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
      gate: { verifyForClaim: async () => { throw new Error("UNUSED"); }, rejectForClaim: async () => undefined },
    });
    await expect(firstProcess.run({
      userId: targetId, runId, claimToken: "99999999-9999-8999-8999-999999999999", now: new Date(), attemptCount: 1,
      executionSpec: executionSpecFor([{ ordinal: 1, queryId, kind: "general", stableFingerprint: pending.queryFingerprint, query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 }]) as never,
      beforePhysicalOperation: async ({ kind }) => { if (kind === "extract") throw new LayeredPublicWorkflowInterruption("paused"); }, onDiagnostics: () => undefined, signal: new AbortController().signal,
    })).resolves.toMatchObject({ interruption: "paused" });
    expect(pendingPersisted).toBe(true);

    const calls: string[] = [];
    const rebuiltProcess = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ beforeRequest }) => { await beforeRequest(); return { candidates: [] }; },
        extract: async ({ candidate, beforeRequest }) => { calls.push(`extract:${candidate.leadId}`); await beforeRequest(); return { normalizedUrl: candidate.normalizedUrl }; },
      },
      preflight: async () => { throw new Error("recovered lead must not depend on a fresh search preflight"); },
      leads: {
        recordPendingForClaim: async () => { throw new Error("recovered lead must not be inserted again"); },
        recoverPendingForClaim: async (input: unknown) => {
          expect(input).toMatchObject({ userId: targetId, runId, queryId, claimToken: "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa" });
          return [pending];
        },
      },
      fetcher: { fetch: async ({ candidate }) => { calls.push(`fetch:${candidate.leadId}`); return { requestedUrl: candidate.normalizedUrl, finalUrl: candidate.normalizedUrl, canonicalUrl: candidate.normalizedUrl, rawHtml: "<h1>job</h1>", visibleText: "job", pageClassification: "job", sourceKind: "official" }; } },
      gate: { verifyForClaim: async ({ candidate }) => { calls.push(`verify:${candidate.leadId}`); return { sourcePostingVersionId: "77777777-7777-8777-8777-777777777777" }; }, rejectForClaim: async () => undefined },
    });
    await expect(rebuiltProcess.run({
      userId: targetId, runId, claimToken: "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa", now: new Date(), attemptCount: 2,
      executionSpec: executionSpecFor([{ ordinal: 1, queryId, kind: "general", stableFingerprint: pending.queryFingerprint, query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 }]) as never,
      beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined, signal: new AbortController().signal,
    })).resolves.toMatchObject({ branchOutcome: { trusted: "failed", publicDiscovery: "verified" }, sourcePostingVersionIds: ["77777777-7777-8777-8777-777777777777"] });
    expect(calls).toEqual([`extract:${pending.leadId}`, `fetch:${pending.leadId}`, `verify:${pending.leadId}`]);
  });

  it("factory 对空 trusted scope 不发请求且报告 failed/empty trusted branch", async () => {
    let adapterCalls = 0;
    const runtime = createLayeredPublicJobDiscoveryRuntime({
      db: {} as never, id: () => "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa", auditTrail: {} as never,
      contentStore: { put: async () => undefined, delete: async () => undefined }, evidenceStore: { put: async () => ({ created: true }), delete: async () => undefined },
      trustedSourceAdapter: { listSource: async () => { adapterCalls += 1; throw new Error("UNUSED"); }, getSourceDetail: async () => { adapterCalls += 1; throw new Error("UNUSED"); } },
      anySearch: { search: async () => ({ candidates: [] }), extract: async () => { throw new Error("UNUSED"); } },
      preflight: async () => null, fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
    });
    const outcome = await runtime.run({ userId: targetId, runId, claimToken: "99999999-9999-8999-8999-999999999999", now: new Date(), executionSpec: executionSpecFor([{ ordinal: 1, queryId, kind: "general", stableFingerprint: "a".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 }], []) as never, attemptCount: 1, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ branchOutcome: { trusted: "failed", publicDiscovery: "clean_zero" }, trustedSourcePostingVersionIds: [] });
    expect(adapterCalls).toBe(0);
  });

  it("在同一 run 调度可信来源和 AnySearch，并仅返回脱敏事实", async () => {
    const calls: string[] = [];
    const proofs: Record<string, unknown> = {};
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: {
        discover: async ({ beforeRequest }) => {
          await beforeRequest("55555555-5555-8555-8555-555555555555");
          await beforeRequest("55555555-5555-8555-8555-555555555555");
          calls.push("trusted");
          return { succeeded: true, verifiedSourcePostingVersionIds: ["44444444-4444-8444-8444-444444444444"] };
        },
      },
      anySearch: {
        search: async (input) => {
          const { query, beforeRequest } = input;
          proofs.search = input;
          await beforeRequest();
          calls.push(`search:${query.queryId}`);
          return { candidates: [{ normalizedUrl: "https://careers.example.com/jobs/1", stableFingerprint: "a".repeat(64) }] };
        },
        extract: async (input) => { proofs.extract = input; await input.beforeRequest(); calls.push("extract"); return { normalizedUrl: "https://careers.example.com/jobs/1" }; },
      },
      preflight: async (input) => { proofs.preflight = input; return { normalizedUrl: "https://careers.example.com/jobs/1" }; },
      leads: { recordPendingForClaim: async (input) => { proofs.pending = input; calls.push("pending"); return { leadId: "66666666-6666-8666-8666-666666666666" }; } },
      fetcher: { fetch: async (input) => { proofs.fetch = input; calls.push("fetch"); return { requestedUrl: "https://careers.example.com/jobs/1", finalUrl: "https://careers.example.com/jobs/1", canonicalUrl: "https://careers.example.com/jobs/1", rawHtml: "<h1>AI Engineer</h1>", visibleText: "AI Engineer", pageClassification: "job", sourceKind: "official" }; } },
      gate: { verifyForClaim: async (input) => { proofs.verify = input; calls.push("verify"); return { sourcePostingVersionId: "77777777-7777-8777-8777-777777777777" }; }, rejectForClaim: async () => { calls.push("reject"); } },
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
    const controller = new AbortController();
    const claimToken = "99999999-9999-8999-8999-999999999999";
    const result = await workflow.run({ userId: targetId, runId, claimToken, now: new Date(), executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async ({ kind }) => { calls.push(`checkpoint:${kind}`); }, onDiagnostics: () => undefined, signal: controller.signal });

    expect(calls).toEqual(["checkpoint:search", "checkpoint:search", "trusted", "checkpoint:search", `search:${queryId}`, "checkpoint:record_pending", "pending", "checkpoint:extract", "extract", "checkpoint:fetch", "fetch", "checkpoint:gate_verify", "verify"]);
    expect(result).toEqual({ branchOutcome: { trusted: "succeeded", publicDiscovery: "verified" }, sourcePostingVersionIds: ["44444444-4444-8444-8444-444444444444", "77777777-7777-8777-8777-777777777777"], trustedSourcePostingVersionIds: ["44444444-4444-8444-8444-444444444444"], sourceIssues: [], diagnostics: [] });
    const capability = { userId: targetId, runId, queryId, queryFingerprint: "b".repeat(64), normalizedUrl: "https://careers.example.com/jobs/1", stableFingerprint: "a".repeat(64), allowedSiteDomains: [] };
    expect(proofs.preflight).toMatchObject({ candidate: capability });
    expect(proofs.pending).toMatchObject({ candidate: capability, claimToken });
    expect(proofs.extract).toMatchObject({ candidate: { ...capability, leadId: "66666666-6666-8666-8666-666666666666" } });
    expect(proofs.fetch).toMatchObject({ candidate: { ...capability, leadId: "66666666-6666-8666-8666-666666666666" } });
    expect(proofs.verify).toMatchObject({ candidate: { ...capability, leadId: "66666666-6666-8666-8666-666666666666" }, claimToken });
    expect(proofs.search).toMatchObject({ signal: controller.signal });
    expect(proofs.extract).toMatchObject({ signal: controller.signal });
    expect(proofs.fetch).toMatchObject({ signal: controller.signal });
    expect(JSON.stringify(result)).not.toContain("careers.example.com");
  });

  it("未配置 provider 不调用 beforeRequest，因此不占用物理 search 预算", async () => {
    let checkpoints = 0; let posts = 0;
    const diagnosticSnapshots: unknown[] = [];
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ query }) => ({ error: query.ordinal === 2
          ? { code: "ANYSEARCH_AUTH_FAILED", retryable: false, httpStatus: 401 }
          : { code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, httpStatus: null } }),
        extract: async () => { throw new Error("UNUSED"); },
      },
      preflight: async () => null,
      leads: { recordPendingForClaim: async () => ({ leadId: "66666666-6666-8666-8666-666666666666" }) },
      fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
      gate: { verifyForClaim: async () => ({ sourcePostingVersionId: "77777777-7777-8777-8777-777777777777" }), rejectForClaim: async () => undefined },
    });
    const executionSpec = {
      targetSnapshot: { targetId, version: 1, priority: "primary" as const, state: "active" as const, constraints: { roleFamily: "AI 工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } } },
      profileSnapshot: { targetId, version: 1, confirmedActiveSkillNames: [] }, watchlistSnapshot: { targetId, version: 0, companies: [] },
      sourceScope: { kind: "layered_public" as const, trustedSources: [], publicDiscovery: { provider: "anysearch" as const, queries: [{ ordinal: 1, queryId, kind: "general" as const, stableFingerprint: "b".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 as const }], batchSize: 5 as const, maxVerificationCandidates: 10 as const } },
      workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, adapter: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, adapterVersion: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, toolAllowlist: ["job_discovery.list_source", "job_discovery.search", "job_discovery.extract", "job_discovery.fetch"] as const, model: null, budget: PUBLIC_JOB_DISCOVERY_BUDGET,
    };
    executionSpec.sourceScope.publicDiscovery.queries.push({ ordinal: 2, queryId: "88888888-8888-8888-8888-888888888888", kind: "general", stableFingerprint: "c".repeat(64), query: "AI 工程师 远程", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 });
    executionSpec.sourceScope.publicDiscovery.queries.push({ ordinal: 3, queryId: "99999999-9999-8999-8999-999999999999", kind: "general", stableFingerprint: "d".repeat(64), query: "AI 工程师 杭州", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 });
    const outcome = await workflow.run({ userId: targetId, runId, claimToken: crypto.randomUUID(), now: new Date(), executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async () => { checkpoints += 1; }, onDiagnostics: (snapshot) => { diagnosticSnapshots.push(snapshot); }, signal: new AbortController().signal });
    expect({ posts, checkpoints }).toEqual({ posts: 0, checkpoints: 0 });
    expect(outcome).toMatchObject({
      branchOutcome: { trusted: "failed", publicDiscovery: "failed" },
      diagnostics: [
        { scope: "provider", code: "ANYSEARCH_AUTH_FAILED", retryable: false, affectedCount: 1 },
        { scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 2 },
      ],
      sourceIssues: [
        { provider: "anysearch", code: "ANYSEARCH_AUTH_FAILED", affectedCount: 1 },
        { provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 2 },
      ],
    });
    expect(diagnosticSnapshots).toEqual([
      [{ scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 1 }],
      [{ scope: "provider", code: "ANYSEARCH_AUTH_FAILED", retryable: false, affectedCount: 1 }, { scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 1 }],
      [{ scope: "provider", code: "ANYSEARCH_AUTH_FAILED", retryable: false, affectedCount: 1 }, { scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 2 }],
    ]);
  });

  it("暂停在下一物理操作前会返回此前的脱敏 diagnostic，不泄漏 source issue", async () => {
    let checkpointCalls = 0;
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ beforeRequest }) => { await beforeRequest(); return { error: { code: "ANYSEARCH_UNAVAILABLE", retryable: true, httpStatus: 503 } }; },
        extract: async () => { throw new Error("UNUSED"); },
      },
      preflight: async () => null,
      leads: { recordPendingForClaim: async () => { throw new Error("UNUSED"); } },
      fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
      gate: { verifyForClaim: async () => { throw new Error("UNUSED"); }, rejectForClaim: async () => undefined },
    });
    const secondQueryId = "88888888-8888-8888-8888-888888888888";
    await expect(workflow.run({
      userId: targetId, runId, claimToken: crypto.randomUUID(), now: new Date(), attemptCount: 1, signal: new AbortController().signal,
      executionSpec: executionSpecFor([
        { ordinal: 1, queryId, kind: "general", stableFingerprint: "f".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 },
        { ordinal: 2, queryId: secondQueryId, kind: "general", stableFingerprint: "e".repeat(64), query: "AI 工程师 远程", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 },
      ]) as never,
      beforePhysicalOperation: async () => {
        checkpointCalls += 1;
        if (checkpointCalls === 2) throw new LayeredPublicWorkflowInterruption("paused");
      },
      onDiagnostics: () => undefined,
    })).resolves.toEqual(expect.objectContaining({
      interruption: "paused",
      diagnostics: [{ scope: "provider", code: "ANYSEARCH_UNAVAILABLE", retryable: true, affectedCount: 1 }],
      sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_UNAVAILABLE", affectedCount: 1 }],
    }));
  });

  it("可信来源成功但零 postings 仍是成功分支", async () => {
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: true, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ beforeRequest }) => { await beforeRequest(); return { candidates: [] }; },
        extract: async () => { throw new Error("UNUSED"); },
      },
      preflight: async () => null,
      leads: { recordPendingForClaim: async () => ({ leadId: "66666666-6666-8666-8666-666666666666" }) },
      fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
      gate: { verifyForClaim: async () => ({ sourcePostingVersionId: "77777777-7777-8777-8777-777777777777" }), rejectForClaim: async () => undefined },
    });
    const outcome = await workflow.run({
      userId: targetId, runId, claimToken: crypto.randomUUID(), now: new Date(), attemptCount: 1, signal: new AbortController().signal,
      executionSpec: executionSpecFor([{ ordinal: 1, queryId, kind: "general", stableFingerprint: "e".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 }]) as never,
      beforePhysicalOperation: async () => undefined,
      onDiagnostics: () => undefined,
    });
    expect(outcome).toMatchObject({ branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [] });
  });

  it("真实 search 零候选是 clean-zero 成功，而非依赖 trusted 分支", async () => {
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: { search: async ({ beforeRequest }) => { await beforeRequest(); return { candidates: [] }; }, extract: async () => { throw new Error("UNUSED"); } },
      preflight: async () => null, leads: { recordPendingForClaim: async () => { throw new Error("UNUSED"); } }, fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
      gate: { verifyForClaim: async () => { throw new Error("UNUSED"); }, rejectForClaim: async () => undefined },
    });
    await expect(workflow.run({ userId: targetId, runId, claimToken: crypto.randomUUID(), now: new Date(), attemptCount: 1, signal: new AbortController().signal, executionSpec: executionSpecFor([{ ordinal: 1, queryId, kind: "general", stableFingerprint: "e".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 }]) as never, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined }))
      .resolves.toMatchObject({ branchOutcome: { trusted: "failed", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [] });
  });

  it("extract URL 不一致会终结 Lead 并记录局部 source issue", async () => {
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ beforeRequest }) => { await beforeRequest(); return { candidates: [{ normalizedUrl: "https://careers.example.com/jobs/1", stableFingerprint: "a".repeat(64) }] }; },
        extract: async ({ beforeRequest }) => { await beforeRequest(); return { normalizedUrl: "https://careers.example.com/jobs/other" }; },
      },
      preflight: async ({ candidate }) => ({ normalizedUrl: candidate.normalizedUrl }), leads: { recordPendingForClaim: async () => ({ leadId: "66666666-6666-8666-8666-666666666666" }) },
      fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
      gate: { verifyForClaim: async () => { throw new Error("UNUSED"); }, rejectForClaim: async (input) => { expect(input.code).toBe("JOB_PAGE_URL_INVALID"); } },
    });
    await expect(workflow.run({ userId: targetId, runId, claimToken: crypto.randomUUID(), now: new Date(), attemptCount: 1, signal: new AbortController().signal, executionSpec: executionSpecFor([{ ordinal: 1, queryId, kind: "general", stableFingerprint: "b".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 }]) as never, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined }))
      .resolves.toMatchObject({ branchOutcome: { trusted: "failed", publicDiscovery: "candidate_failures" }, sourcePostingVersionIds: [], diagnostics: [expect.objectContaining({ scope: "lead", code: "JOB_PAGE_URL_INVALID", retryable: false })], sourceIssues: [expect.objectContaining({ provider: "anysearch", code: "JOB_PAGE_URL_INVALID" })] });
  });

  it("一个 verified result 与局部失败仍标记 verified，并保留脱敏问题", async () => {
    let candidate = 0;
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ beforeRequest }) => { await beforeRequest(); return { candidates: ["a", "b"].map((suffix) => ({ normalizedUrl: `https://careers.example.com/jobs/${suffix}`, stableFingerprint: suffix.repeat(64) })) }; },
        extract: async ({ beforeRequest, candidate: input }) => { await beforeRequest(); return { normalizedUrl: input.normalizedUrl }; },
      },
      preflight: async ({ candidate: input }) => ({ normalizedUrl: input.normalizedUrl }), leads: { recordPendingForClaim: async () => ({ leadId: candidate++ === 0 ? "66666666-6666-8666-8666-666666666666" : "77777777-7777-8777-8777-777777777777" }) },
      fetcher: { fetch: async ({ candidate: input }) => { if (input.normalizedUrl.endsWith("/b")) throw { code: "JOB_PAGE_TIMEOUT" }; return { requestedUrl: input.normalizedUrl, finalUrl: input.normalizedUrl, canonicalUrl: input.normalizedUrl, rawHtml: "<h1>job</h1>", visibleText: "job", pageClassification: "job", sourceKind: "official" }; } },
      gate: { verifyForClaim: async () => ({ sourcePostingVersionId: "88888888-8888-8888-8888-888888888888" }), rejectForClaim: async () => undefined },
    });
    await expect(workflow.run({ userId: targetId, runId, claimToken: crypto.randomUUID(), now: new Date(), attemptCount: 1, signal: new AbortController().signal, executionSpec: executionSpecFor([{ ordinal: 1, queryId, kind: "general", stableFingerprint: "c".repeat(64), query: "AI 工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 }]) as never, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined }))
      .resolves.toMatchObject({ branchOutcome: { trusted: "failed", publicDiscovery: "verified" }, sourcePostingVersionIds: ["88888888-8888-8888-8888-888888888888"], diagnostics: [expect.objectContaining({ code: "JOB_PAGE_TIMEOUT", retryable: true })] });
  });

  it("只允许已签发 URL capability，并将安全但不在批准域的候选终结为 policy rejected Lead", async () => {
    const calls: string[] = [];
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ beforeRequest }) => {
          await beforeRequest();
          return { candidates: [
            { normalizedUrl: "https://approved.acme.com/jobs?id=one", stableFingerprint: "f".repeat(64) },
            { normalizedUrl: "https://unapproved.acme.com/jobs?id=two", stableFingerprint: "0".repeat(64) },
          ] };
        },
        extract: async () => { calls.push("extract"); throw new Error("UNUSED"); },
      },
      preflight: async ({ candidate }) => candidate.normalizedUrl.includes("approved.acme.com") && !candidate.normalizedUrl.includes("unapproved")
        ? { normalizedUrl: "https://approved.acme.com/jobs?id=rewritten" }
        : { normalizedUrl: candidate.normalizedUrl },
      leads: { recordPendingForClaim: async ({ candidate }) => { calls.push(`pending:${candidate.normalizedUrl}`); return { leadId: "66666666-6666-8666-8666-666666666666" }; } },
      fetcher: { fetch: async () => { calls.push("fetch"); throw new Error("UNUSED"); } },
      gate: { verifyForClaim: async () => { calls.push("verify"); throw new Error("UNUSED"); }, rejectForClaim: async ({ code }) => { calls.push(`reject:${String(code)}`); } },
    });
    const outcome = await workflow.run({
      userId: targetId, runId, claimToken: crypto.randomUUID(), now: new Date(), attemptCount: 1, signal: new AbortController().signal,
      executionSpec: executionSpecFor([{ ordinal: 1, queryId, kind: "target_company", stableFingerprint: "1".repeat(64), query: "AI 工程师 Acme", allowedSiteDomains: ["approved.acme.com"], targetCompanyNames: ["Acme"], resultLimit: 5 }]) as never,
      beforePhysicalOperation: async () => undefined,
      onDiagnostics: () => undefined,
    });
    expect(calls).toEqual([
      "pending:https://unapproved.acme.com/jobs?id=two",
      "reject:POLICY_REJECTED",
    ]);
    expect(outcome).toMatchObject({
      diagnostics: [expect.objectContaining({ scope: "query", code: "ANYSEARCH_POLICY_REJECTED", affectedCount: 2 })],
      sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_POLICY_REJECTED", affectedCount: 2 }],
    });
  });

  it("达到全 run 验证上限后不再 preflight 或创建额外 Lead", async () => {
    let preflightCount = 0;
    let leadCount = 0;
    const queries = [1, 2, 3].map((ordinal) => ({ ordinal, queryId: `${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}-${ordinal}${ordinal}${ordinal}${ordinal}-8${ordinal}${ordinal}${ordinal}-8${ordinal}${ordinal}${ordinal}-${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}${ordinal}`, kind: "general" as const, stableFingerprint: String(ordinal).repeat(64), query: `AI 工程师 ${ordinal}`, allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 as const }));
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: {
        search: async ({ query, beforeRequest }) => {
          await beforeRequest();
          return { candidates: Array.from({ length: 5 }, (_, index) => ({ normalizedUrl: `https://jobs.acme.com/${query.ordinal}-${index}?id=${query.ordinal}${index}`, stableFingerprint: `${query.ordinal}${index}`.repeat(32) })) };
        },
        extract: async ({ beforeRequest, candidate }) => { await beforeRequest(); return { error: { code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, httpStatus: null } }; },
      },
      preflight: async ({ candidate }) => { preflightCount += 1; return { normalizedUrl: candidate.normalizedUrl }; },
      leads: { recordPendingForClaim: async () => { leadCount += 1; return { leadId: crypto.randomUUID() }; } },
      fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
      gate: { verifyForClaim: async () => { throw new Error("UNUSED"); }, rejectForClaim: async () => undefined },
    });
    await workflow.run({ userId: targetId, runId, claimToken: crypto.randomUUID(), now: new Date(), attemptCount: 1, signal: new AbortController().signal, executionSpec: executionSpecFor(queries) as never, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined });
    expect({ preflightCount, leadCount }).toEqual({ preflightCount: 10, leadCount: 10 });
  });
});
