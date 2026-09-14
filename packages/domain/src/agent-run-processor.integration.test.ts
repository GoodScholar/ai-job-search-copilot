import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { agentInboxItems, agentRunEvents, agentRunJobResults, agentRunSteps, agentRunUsageEntries, agentRuns, auditEvents, createDatabase, deepMatchRunCandidates, firstRecommendationJourneyCompletions, jobAccounts, jobDiscoveryAttributions, jobDiscoveryDiagnostics, jobDiscoveryLeads, jobDiscoveryRunResults, jobDiscoverySourceIssues, jobMatchVersions, jobOpportunities, jobOpportunitySources, jobProfiles, jobSourceHealthChecks, jobSourcePostings, jobSourcePostingVersions, jobTargetRevisions, jobTargets, jobTriageVersions, migrateDatabase, modelDiagnosticResults, profileFactRevisions, profileFacts, recommendationExclusions, recommendationListItems, recommendationLists, recommendationResults, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAgentRunCheckpoint, createAgentRunCommands, createAgentRunProcessor as createDomainAgentRunProcessor, createAgentRunQueries, createAgentRunRecoveryQueries, createRecommendationRunQueries, type AgentRunCheckpoint, type AgentRunQueue, type DiscoveryContentStore, type JobDiscoveryAdapter, type JobDiscoveryAdapterResolver } from "./agent-runs";
import { createCompanyWatchlistCommands } from "./company-watchlists";
import { AgentRunDetailSchema, AgentRunEventSchema, ControlAgentRunResponseSchema, DEEP_MATCH_AGENT_RUN_BUDGET, GREENHOUSE_JOB_DISCOVERY_ADAPTER, GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, GREENHOUSE_JOB_DISCOVERY_RULE_VERSION, GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, PUBLIC_JOB_DISCOVERY_BUDGET } from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST, LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/job-discovery";
import { createLayeredPublicJobDiscoveryWorkflow, LayeredPublicWorkflowInterruption } from "./layered-public-job-discovery-workflow";
import { createLayeredPublicJobDiscoveryRuntime } from "./layered-public-job-discovery-runtime";
import { createJobDiscoveryPersistence } from "./job-discovery-persistence";
import { createDeepMatchRunStarter as createDomainDeepMatchRunStarter, ensureDeepMatchRunInTransaction, triggerDeepMatchAfterDiscovery, type DeepMatchRunQueue } from "./deep-match-agent-runs";
import { DeepMatchAdapterError, FakeDeepMatchAdapter } from "@job-copilot/contracts/deep-match";
import { createDeepMatchCommands, createDeepMatchQueries } from "./deep-match-persistence";
import { createAccountRunPolicies } from "./account-run-policies";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { createReadyRunPreflightEvaluator } from "./testing/run-preflight";
import { createRunPreflightEvaluator } from "./run-preflight";
import { createModelDiagnosticProjectionReader } from "./model-diagnostics";
import { createAccountRunControl } from "./account-run-control";
import { createRecommendationRunCommands } from "./recommendation-runs";
import { effectiveAgentRunBudget } from "./effective-agent-run-budget";
import * as effectiveAgentRunBudgetModule from "./effective-agent-run-budget";
import type { SourceHealthDiscoveryAdapter } from "./source-health-discovery-adapter";
import type { SourceCapabilityAdapter } from "./source-capabilities";

const now = new Date("2026-08-29T12:00:00.000Z");
const constraints = { roleFamily: "AI 应用工程师", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } };

class Queue implements AgentRunQueue { async enqueue() {} }
class Store implements DiscoveryContentStore {
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  readonly payloads = new Map<string, Uint8Array>();
  async put({ objectKey, bytes }: { objectKey: string; bytes?: Uint8Array }) {
    this.puts.push(objectKey);
    if (bytes) this.payloads.set(objectKey, bytes);
  }
  async delete({ objectKey }: { objectKey: string }) { this.deletes.push(objectKey); }
}

function createAgentRunProcessor(deps: Omit<Parameters<typeof createDomainAgentRunProcessor>[0], "runPreflight"> & { runPreflight?: Parameters<typeof createDomainAgentRunProcessor>[0]["runPreflight"] }) {
  return createDomainAgentRunProcessor({ ...deps, runPreflight: deps.runPreflight ?? createReadyRunPreflightEvaluator({ clock: deps.clock }) });
}

function createDeepMatchRunStarter(deps: Omit<Parameters<typeof createDomainDeepMatchRunStarter>[0], "runPreflight"> & { runPreflight?: Parameters<typeof createDomainDeepMatchRunStarter>[0]["runPreflight"] }) {
  return createDomainDeepMatchRunStarter({ ...deps, runPreflight: deps.runPreflight ?? createReadyRunPreflightEvaluator({ clock: deps.clock }) });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitUntilAConnectionIsWaitingForAccountAdvisoryLock(database: Database) {
  await expect.poll(async () => {
    const [row] = await database.execute<{ waiting: boolean }>(sql`
      select exists(
        select 1 from pg_stat_activity
        where wait_event_type = 'Lock'
          and wait_event = 'advisory'
          and query like '%pg_advisory_xact_lock%'
      ) as waiting
    `);
    return row?.waiting ?? false;
  }, { timeout: 2_000, interval: 10 }).toBe(true);
}

async function waitForBarrier(input: { barrier: Promise<void>; operation: Promise<unknown>; name: string }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      input.barrier,
      input.operation.then(
        (outcome) => Promise.reject(new Error(`${input.name}: operation settled before barrier: ${String(outcome)}`)),
        (error) => Promise.reject(new Error(`${input.name}: operation rejected before barrier: ${String(error)}`)),
      ),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${input.name}: barrier timeout`)), 2_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("AgentRunProcessor checkpoints", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function run(input: { maxResults?: number; maxAttempts?: number } = {}) {
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    if (input.maxResults !== undefined || input.maxAttempts !== undefined) {
      const settings = structuredClone(systemAccountRunPolicy().effective);
      if (input.maxResults !== undefined) settings.budgets.fake.maxResults = input.maxResults;
      if (input.maxAttempts !== undefined) settings.budgets.fake.maxAttempts = input.maxAttempts;
      await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now })
        .save({ userId, command: { expectedVersion: 0, settings } });
    }
    const started = await createAgentRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) })
      .start({ userId, requestId: crypto.randomUUID(), command: { targetId, idempotencyKey: crypto.randomUUID() } });
    return { userId, targetId, runId: started.runId };
  }

  async function deepMatchRun(input: { maxCandidates?: number } = {}) {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const profileId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    const profileFactId = crypto.randomUUID();
    await database.insert(profileFacts).values({ id: profileFactId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    const opportunityIds: string[] = [];
    for (const index of [1, 2]) {
      const sourcePostingId = crypto.randomUUID(); const sourcePostingVersionId = crypto.randomUUID(); const opportunityId = crypto.randomUUID(); const sourceHash = `${index}`.repeat(64);
      opportunityIds.push(opportunityId);
      await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "user_import", sourceIdentifier: sourceHash, sourceIdentity: { hash: sourceHash }, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: sourceHash, rawContentSha256: sourceHash, rawObjectReference: {}, normalizedData: { qualifications: { workMode: null, relocationRequired: null, salary: null, seniority: null, education: null, languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } } } }, retrievedAt: now, availability: "open", createdAt: now });
      await database.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: sourceHash, company: "示例科技", title: `前端工程师 ${index}`, location: "上海", postedAt: null, deadline: new Date("2026-09-20T00:00:00.000Z"), description: "需要 TypeScript", normalizedData: {}, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      await database.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId, createdAt: now });
      await database.insert(jobTriageVersions).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId, profileId, profileVersion: 1, targetId, targetVersion: 1, qualificationRuleVersion: "q1", coarseRuleVersion: "c1", overallVerdict: "pass", gateResults: {}, pendingItems: [], deadlineStatus: "valid", confidenceBasisPoints: 10_000, dimensionScores: {}, overallScore: 90 - index, threshold: 70, sequence: 1, createdAt: now });
    }
    if (input.maxCandidates !== undefined) {
      const settings = structuredClone(systemAccountRunPolicy().effective);
      settings.budgets.deepMatch.maxResults = input.maxCandidates;
      settings.budgets.deepMatch.maxModelCalls = input.maxCandidates;
      await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now })
        .save({ userId, command: { expectedVersion: 0, settings } });
    }
    const started = await createDeepMatchRunStarter({ db: database, queue: new Queue(), id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId, targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    return { userId, targetId, runId: started.runId, opportunityIds };
  }

  async function realDeepMatchPreflight(userId: string) {
    const profileId = crypto.randomUUID(); const factId = crypto.randomUUID(); const fingerprint = crypto.randomUUID();
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    return createRunPreflightEvaluator({ capabilityAdapter: { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) }, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "greenhouse", id: () => crypto.randomUUID(), clock: () => now });
  }

  it("automatic child 使用真实 evaluator 的 policy；warning 无需确认且重放至多一个 child", async () => {
    const parent = await run(); const real = await realDeepMatchPreflight(parent.userId);
    const warning = { evaluate: async (tx: Database, input: any) => {
      const evaluation = await real.evaluate(tx, input);
      return { ...evaluation, report: { ...evaluation.report, status: "ready_with_warnings" as const, warningFingerprint: "b".repeat(64), items: [...evaluation.report.items, { code: "SOURCE_HEALTH_UNCHECKED", severity: "warning" as const, summary: "warning", impact: "warning", retryable: true, suggestedActions: ["review_source_health"], evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null } }] } };
    } };
    const key = crypto.randomUUID();
    const first = await database.transaction((tx) => ensureDeepMatchRunInTransaction({ transaction: tx, id: () => crypto.randomUUID(), clock: () => now, runPreflight: warning as any, userId: parent.userId, targetId: parent.targetId, idempotencyKey: key, trigger: "automatic", discoveryRunId: parent.runId }));
    const replay = await database.transaction((tx) => ensureDeepMatchRunInTransaction({ transaction: tx, id: () => crypto.randomUUID(), clock: () => now, runPreflight: warning as any, userId: parent.userId, targetId: parent.targetId, idempotencyKey: key, trigger: "automatic", discoveryRunId: parent.runId }));
    expect(first).toMatchObject({ kind: "created", reused: false }); expect(replay).toMatchObject({ kind: "created", reused: true });
    await expect(database.select({ preflight: agentRuns.preflightSnapshot, policy: agentRuns.accountPolicySnapshot }).from(agentRuns).where(eq(agentRuns.id, (first as any).run.id))).resolves.toEqual([{ preflight: expect.objectContaining({ status: "ready_with_warnings", warningFingerprint: "b".repeat(64) }), policy: (await real.evaluate(database, { userId: parent.userId, targetId: parent.targetId, workflow: "deep_match", trigger: "automatic" })).policy.snapshot }]);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, parent.userId), eq(agentRuns.idempotencyKey, key)))).resolves.toHaveLength(1);
  });

  it("automatic blocker 在 afterCompleted 与提交后补偿均重检，父结果仍完成", async () => {
    const parent = await run();
    const observer = createDatabase(container.getConnectionUri()); const trace: string[] = [];
    const blocked = createRunPreflightEvaluator({ capabilityAdapter: { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: [] }) }, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: crypto.randomUUID() }), discoveryExecutionMode: "greenhouse", id: () => crypto.randomUUID(), clock: () => now });
    const evaluator = { evaluate: async (tx: Database, input: any) => { const [seen] = await observer.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, parent.runId)); trace.push(seen!.status); return blocked.evaluate(tx, input); } };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, runPreflight: evaluator as any });
    try { await expect(processor.process({ version: 1, ...parent, finalAttempt: true })).resolves.toBe("completed"); } finally { await observer.$client.end(); }
    expect(trace).toEqual(["running", "completed"]);
    await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, parent.runId))).resolves.toEqual([{ status: "completed" }]);
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, parent.runId), eq(agentRunEvents.eventType, "run.completed")))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, parent.runId))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRuns).where(eq(agentRuns.userId, parent.userId))).resolves.toHaveLength(1);
    await expect(database.transaction((tx) => ensureDeepMatchRunInTransaction({ transaction: tx, id: () => crypto.randomUUID(), clock: () => now, runPreflight: { evaluate: async () => { throw new Error("unexpected-preflight"); } } as any, userId: parent.userId, targetId: parent.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: parent.runId }))).rejects.toThrow("unexpected-preflight");
  }, 15_000);

  async function layeredRun() {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const runId = crypto.randomUUID(); const queryId = crypto.randomUUID(); const watchlistItemId = crypto.randomUUID(); const sourcePostingId = crypto.randomUUID(); const sourcePostingVersionId = crypto.randomUUID();
    const targetSnapshot = { targetId, version: 1, priority: "primary" as const, state: "active" as const, constraints };
    const profileSnapshot = { targetId, version: 1, confirmedActiveSkillNames: [] };
    const watchlistSnapshot = { targetId, version: 0, companies: [] };
    const sourceScope = { kind: "layered_public" as const, trustedSources: [{ kind: "greenhouse_trusted_source" as const, source: { sourceId: "greenhouse:example", watchlistItemId, canonicalCompanyName: "Example", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "example" } }], publicDiscovery: { provider: "anysearch" as const, batchSize: 5 as const, maxVerificationCandidates: 10 as const, queries: [{ ordinal: 1, queryId, kind: "general" as const, stableFingerprint: "a".repeat(64), query: "AI 应用工程师", allowedSiteDomains: [], targetCompanyNames: [], resultLimit: 5 as const }] } };
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "company_careers", sourceIdentifier: "greenhouse:example:opening-1", sourceId: "greenhouse:example", sourceIdentity: { sourceId: "greenhouse:example", detailId: "opening-1" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: "a".repeat(64), rawContentSha256: "b".repeat(64), rawObjectReference: {}, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(agentRuns).values({ id: runId, userId, targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1, targetSnapshot, profileSnapshot, watchlistSnapshot, sourceScope, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: LAYERED_PUBLIC_JOB_DISCOVERY_RULE_VERSION, adapter: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER, adapterVersion: LAYERED_PUBLIC_JOB_DISCOVERY_ADAPTER_VERSION, outputSchemaVersion: LAYERED_PUBLIC_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, toolAllowlist: LAYERED_PUBLIC_JOB_DISCOVERY_TOOL_ALLOWLIST, modelSnapshot: null, status: "queued", currentStep: "queued", controlState: "none", version: 1, attemptCount: 0, activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: false, queuedAt: now, createdAt: now, updatedAt: now });
    await database.insert(agentRunSteps).values(["batch_search", "fetch_details", "persist_results"].map((stepKey, index) => ({ id: crypto.randomUUID(), userId, runId, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
    return { userId, targetId, runId, queryId, sourcePostingVersionId };
  }

  async function extraTrustedVersion(job: { userId: string }, index: number, input: { sourceType?: "company_careers" | "public_web"; isOfficial?: boolean } = {}) {
    const sourcePostingId = crypto.randomUUID();
    const sourcePostingVersionId = crypto.randomUUID();
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId: job.userId, sourceType: input.sourceType ?? "company_careers", sourceIdentifier: `greenhouse:example:opening-extra-${index}`, sourceId: "greenhouse:example", sourceIdentity: { sourceId: "greenhouse:example", detailId: `opening-extra-${index}` }, applicationDeadline: null, isOfficial: input.isOfficial ?? true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId: job.userId, sourcePostingId, version: 1, contentSha256: `${index.toString(16)}`.repeat(64).slice(0, 64), rawContentSha256: `${(index + 8).toString(16)}`.repeat(64).slice(0, 64), rawObjectReference: {}, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    return sourcePostingVersionId;
  }

  function resolver(adapter: JobDiscoveryAdapter): JobDiscoveryAdapterResolver { return { resolve: () => adapter }; }
  function plannedLayeredDiscoveryFacts(executionSpec: any) {
    return {
      version: "recommendation-discovery-facts-v1" as const,
      trusted: executionSpec.sourceScope.trustedSources.map(({ source }: any) => ({ sourceId: source.sourceId, checked: true as const, outcome: "credible_zero" as const, losses: [] })),
      publicQueries: executionSpec.sourceScope.publicDiscovery.queries.map((query: any) => ({ queryId: query.queryId, checked: true as const, outcome: "credible_zero" as const, losses: [] })),
    };
  }
  function checkpoint(): AgentRunCheckpoint {
    return createAgentRunCheckpoint({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
  }

  async function createFullyQualifiedLayeredRecommendationFixture(input: { ownerUserId?: string; withFrontExclusion?: boolean; withQualityCandidate?: boolean; deepMatchMaxActiveDurationMs?: number; deepMatchMaxResults?: number; deepMatchMaxModelCalls?: number } = {}) {
    const userId = input.ownerUserId ?? crypto.randomUUID(); const targetId = crypto.randomUUID(); const profileId = crypto.randomUUID(); const factId = crypto.randomUUID();
    const qualifiedConstraints = { roleFamily: "AI 应用工程师", seniority: "senior", locations: ["上海"], workModes: ["remote"], relocation: "willing" as const, salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } };
    if (!input.ownerUserId) await database.insert(jobAccounts).values({ id: userId });
    if (input.deepMatchMaxActiveDurationMs !== undefined || input.deepMatchMaxResults !== undefined || input.deepMatchMaxModelCalls !== undefined) {
      const settings = structuredClone(systemAccountRunPolicy().effective);
      if (input.deepMatchMaxActiveDurationMs !== undefined) settings.budgets.deepMatch.maxActiveDurationMs = input.deepMatchMaxActiveDurationMs;
      if (input.deepMatchMaxResults !== undefined) settings.budgets.deepMatch.maxResults = input.deepMatchMaxResults;
      if (input.deepMatchMaxModelCalls !== undefined) settings.budgets.deepMatch.maxModelCalls = input.deepMatchMaxModelCalls;
      await createAccountRunPolicies({ db: database, id: () => crypto.randomUUID(), clock: () => now })
        .save({ userId, command: { expectedVersion: 0, settings } });
    }
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints: qualifiedConstraints, createdAt: now });
    if (!input.ownerUserId) {
      await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
      await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
      await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
      for (const [factType, factValue] of [["education", { summary: "本科" }], ["language", { name: "英语", level: "C1" }], ["work_eligibility", { summary: "中国工作许可" }]] as const) {
        const completeFactId = crypto.randomUUID();
        await database.insert(profileFacts).values({ id: completeFactId, userId, profileId, factType, createdAt: now });
        await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: completeFactId, revisionNumber: 1, factType, factValue, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
      }
    }
    const fingerprint = crypto.randomUUID();
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    const preflight = createRunPreflightEvaluator({ capabilityAdapter: { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) }, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "layered_public", id: () => crypto.randomUUID(), clock: () => now });
    const service = createRecommendationRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode: "layered_public", id: () => crypto.randomUUID(), clock: () => now });
    const preparation = await preflight.evaluate(database, { userId, workflow: "recommendation", trigger: "manual" });
    const started = await service.start({ userId, requestId: crypto.randomUUID(), command: { idempotencyKey: crypto.randomUUID(), warningFingerprint: preparation.report.warningFingerprint } });
    const [rootBeforeCompletion] = await database.select({ sourceScope: agentRuns.sourceScope, recommendationContext: agentRuns.recommendationContext }).from(agentRuns).where(eq(agentRuns.id, started.run.runId));
    const plannedQuery = (rootBeforeCompletion!.sourceScope as any).publicDiscovery.queries[0]!;
    const sourcePostingId = crypto.randomUUID(); const sourcePostingVersionId = crypto.randomUUID(); const sourceHash = createHash("sha256").update(targetId).digest("hex");
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "company_careers", sourceIdentifier: sourceHash, sourceIdentity: { sourceId: "greenhouse:qualified", detailId: "1" }, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: sourceHash, rawContentSha256: sourceHash, rawObjectReference: { key: "qualified" }, normalizedData: { sourceId: "greenhouse:qualified", detailId: "1", company: "Qualified Co", title: "AI Engineer", location: "上海", postedAt: now.toISOString(), deadline: null, sourceType: "company_careers", isOfficial: true, qualifications: { workMode: { value: "remote", evidence: { field: "workMode", path: "工作方式", value: "远程" } }, relocationRequired: { value: true, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "是" } }, salary: null, seniority: { value: "senior", evidence: { field: "seniority", path: "级别", value: "senior" } }, education: { value: "本科", evidence: { field: "education", path: "学历", value: "本科" } }, languages: { value: [{ name: "英语", level: "C1" }], evidence: { field: "languages", path: "语言", value: "英语(C1)" } }, workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } }, industry: null, employmentType: null, requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } } } }, retrievedAt: now, availability: "open", createdAt: now });
    const leadId = crypto.randomUUID();
    await database.insert(jobDiscoveryLeads).values({ id: leadId, userId, runId: started.run.runId, targetId, provider: "anysearch", queryId: plannedQuery.queryId, queryKind: plannedQuery.kind, queryFingerprint: plannedQuery.stableFingerprint, normalizedUrl: "https://fixture.invalid/qualified", stableFingerprint: "d".repeat(64), expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), state: "verified", sourcePostingVersionId, verifiedFinalUrl: "https://fixture.invalid/qualified", rejectionCode: null, createdAt: now, updatedAt: now });
    await database.insert(jobDiscoveryAttributions).values({ id: crypto.randomUUID(), userId, runId: started.run.runId, leadId, queryId: plannedQuery.queryId, provider: "anysearch", sourcePostingVersionId, createdAt: now });
    let qualitySourcePostingVersionId: string | undefined;
    if (input.withQualityCandidate) {
      const qualityPostingId = crypto.randomUUID(); qualitySourcePostingVersionId = crypto.randomUUID();
      await database.insert(jobSourcePostings).values({ id: qualityPostingId, userId, sourceType: "company_careers", sourceIdentifier: "b".repeat(64), sourceIdentity: { sourceId: "greenhouse:quality", detailId: "1" }, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      const [qualifiedVersion] = await database.select({ normalizedData: jobSourcePostingVersions.normalizedData }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.id, sourcePostingVersionId));
      await database.insert(jobSourcePostingVersions).values({ id: qualitySourcePostingVersionId, userId, sourcePostingId: qualityPostingId, version: 1, contentSha256: "b".repeat(64), rawContentSha256: "b".repeat(64), rawObjectReference: { key: "quality" }, normalizedData: qualifiedVersion!.normalizedData, retrievedAt: now, availability: "open", createdAt: now });
      const qualityLeadId = crypto.randomUUID();
      await database.insert(jobDiscoveryLeads).values({ id: qualityLeadId, userId, runId: started.run.runId, targetId, provider: "anysearch", queryId: plannedQuery.queryId, queryKind: plannedQuery.kind, queryFingerprint: plannedQuery.stableFingerprint, normalizedUrl: "https://fixture.invalid/quality", stableFingerprint: "a".repeat(64), expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), state: "verified", sourcePostingVersionId: qualitySourcePostingVersionId, verifiedFinalUrl: "https://fixture.invalid/quality", rejectionCode: null, createdAt: now, updatedAt: now });
      await database.insert(jobDiscoveryAttributions).values({ id: crypto.randomUUID(), userId, runId: started.run.runId, leadId: qualityLeadId, queryId: plannedQuery.queryId, provider: "anysearch", sourcePostingVersionId: qualitySourcePostingVersionId, createdAt: now });
    }
    let excludedSourcePostingVersionId: string | undefined;
    if (input.withFrontExclusion) {
      const excludedPostingId = crypto.randomUUID();
      excludedSourcePostingVersionId = crypto.randomUUID();
      await database.insert(jobSourcePostings).values({ id: excludedPostingId, userId, sourceType: "company_careers", sourceIdentifier: "e".repeat(64), sourceIdentity: { sourceId: "greenhouse:excluded", detailId: "1" }, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      await database.insert(jobSourcePostingVersions).values({ id: excludedSourcePostingVersionId, userId, sourcePostingId: excludedPostingId, version: 1, contentSha256: "e".repeat(64), rawContentSha256: "e".repeat(64), rawObjectReference: { key: "excluded" }, normalizedData: { sourceId: "greenhouse:excluded", detailId: "1", company: "Excluded Co", title: "AI Engineer", location: "上海", postedAt: now.toISOString(), deadline: null, sourceType: "company_careers", isOfficial: true }, retrievedAt: now, availability: "open", createdAt: now });
      const excludedLeadId = crypto.randomUUID();
      await database.insert(jobDiscoveryLeads).values({ id: excludedLeadId, userId, runId: started.run.runId, targetId, provider: "anysearch", queryId: plannedQuery.queryId, queryKind: plannedQuery.kind, queryFingerprint: plannedQuery.stableFingerprint, normalizedUrl: "https://fixture.invalid/excluded", stableFingerprint: "f".repeat(64), expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), state: "verified", sourcePostingVersionId: excludedSourcePostingVersionId, verifiedFinalUrl: "https://fixture.invalid/excluded", rejectionCode: null, createdAt: now, updatedAt: now });
      await database.insert(jobDiscoveryAttributions).values({ id: crypto.randomUUID(), userId, runId: started.run.runId, leadId: excludedLeadId, queryId: plannedQuery.queryId, provider: "anysearch", sourcePostingVersionId: excludedSourcePostingVersionId, createdAt: now });
    }
    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: (input) => ({ run: async () => {
      const facts = plannedLayeredDiscoveryFacts(input.executionSpec);
      return { branchOutcome: { trusted: "succeeded", publicDiscovery: "verified" }, diagnostics: [], sourcePostingVersionIds: [sourcePostingVersionId, ...(qualitySourcePostingVersionId ? [qualitySourcePostingVersionId] : []), ...(excludedSourcePostingVersionId ? [excludedSourcePostingVersionId] : [])], trustedSourcePostingVersionIds: [], discoveryFacts: { ...facts, publicQueries: facts.publicQueries.map((fact: any) => fact.queryId === plannedQuery.queryId ? { ...fact, outcome: "credible_results" as const } : fact) } };
    } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId, runId: started.run.runId, finalAttempt: true });
    const [triage] = await database.select({ id: jobTriageVersions.id, userId: jobTriageVersions.userId, opportunityId: jobTriageVersions.opportunityId, sourcePostingVersionId: jobTriageVersions.sourcePostingVersionId, profileId: jobTriageVersions.profileId, profileVersion: jobTriageVersions.profileVersion, targetId: jobTriageVersions.targetId, targetVersion: jobTriageVersions.targetVersion, overallVerdict: jobTriageVersions.overallVerdict, overallScore: jobTriageVersions.overallScore }).from(jobTriageVersions).where(eq(jobTriageVersions.sourcePostingVersionId, sourcePostingVersionId));
    const [rootAfterCompletion] = await database.select({ sourceScope: agentRuns.sourceScope, recommendationContext: agentRuns.recommendationContext }).from(agentRuns).where(eq(agentRuns.id, started.run.runId));
    const [child] = await database.select({ id: agentRuns.id, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.parentRunId, started.run.runId));
    return { userId, targetId, profileId, sourcePostingVersionId, qualitySourcePostingVersionId, excludedSourcePostingVersionId, plannedQuery, rootRunId: started.run.runId, rootBeforeCompletion, rootAfterCompletion, outcome, triage: triage!, child: child! };
  }

  async function stageFullyQualifiedLayeredRecommendationFixture(input: { withFrontExclusion?: boolean } = {}) {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture(input);
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, fixture.child.id));
    const commands = createDeepMatchCommands({ db: database, id: () => crypto.randomUUID(), clock: () => now, adapter: new FakeDeepMatchAdapter() });
    const [candidate] = await createDeepMatchQueries({ db: database }).getFrozenCandidates({ userId: fixture.userId, runId: fixture.child.id });
    const value = await commands.invokeAndValidate({ userId: fixture.userId, runId: fixture.child.id, candidate: candidate!, modelCall: { signal: new AbortController().signal, usageKey: crypto.randomUUID(), budget: { maxTokens: 20_000, reservedInputTokens: 32, reservedOutputTokens: 48 } } });
    await commands.stageValidatedAssessment({ userId: fixture.userId, runId: fixture.child.id, claimToken, candidate: candidate!, assessment: value.assessment, usage: value.usage });
    const publicationInput = { userId: fixture.userId, targetId: fixture.targetId, runId: fixture.child.id, fence: { claimToken }, selectionExclusions: [], ruleConfig: { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] }, recommendation: { rootRunId: fixture.rootRunId }, onPublished: async () => undefined };
    return { ...fixture, commands, input: publicationInput };
  }

  async function expectPublicationStillUnwritten(input: { userId: string; childId: string }) {
    await expect(Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, input.userId)),
      database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, input.userId)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, input.childId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.userId, input.userId)),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, input.userId)),
      database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, input.childId), eq(agentRunEvents.eventType, "run.completed"))),
      database.select({ status: agentRuns.status, currentStep: agentRuns.currentStep, claimToken: agentRuns.claimToken }).from(agentRuns).where(eq(agentRuns.id, input.childId)),
    ])).resolves.toEqual([[], [], [], [], [], [], [], [], [{ status: "running", currentStep: "assess_matches", claimToken: expect.any(String) }]]);
  }

  async function recommendationRoot(executionMode: "fake" | "greenhouse" | "layered_public", input: { withWatchlist?: boolean; watchlistCount?: number } = {}) {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const profileId = crypto.randomUUID(); const factId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    const watchlistCount = input.watchlistCount ?? (executionMode !== "layered_public" || input.withWatchlist ? 1 : 0);
    for (let index = 0; index < watchlistCount; index += 1) {
      const suffix = index === 0 ? "concurrency" : `concurrency-${index}`;
      await createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).addItem({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: index, canonicalCompanyName: index === 0 ? "Concurrency Co" : `Concurrency Co ${index}`, careersUrl: `https://boards.greenhouse.io/${suffix}`, allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    }
    const fingerprint = crypto.randomUUID();
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    const capabilityAdapter: SourceCapabilityAdapter = { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) };
    const preflight = createRunPreflightEvaluator({ capabilityAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: executionMode, id: () => crypto.randomUUID(), clock: () => now });
    const commands = createRecommendationRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode, id: () => crypto.randomUUID(), clock: () => now });
    const preparation = await preflight.evaluate(database, { userId, workflow: "recommendation", trigger: "manual" });
    const started = await commands.start({ userId, requestId: crypto.randomUUID(), command: { idempotencyKey: crypto.randomUUID(), warningFingerprint: preparation.report.warningFingerprint } });
    return { userId, targetId, runId: started.run.runId };
  }

  function recommendationProcessor(input: { executionMode: "fake" | "greenhouse" | "layered_public"; auditTrail: any; matchingQueue?: DeepMatchRunQueue; collectionEntered?: ReturnType<typeof deferred>; releaseCollection?: ReturnType<typeof deferred>; clock?: () => Date; checkpoint?: AgentRunCheckpoint }) {
    const waitAtCollection = async () => {
      input.collectionEntered?.resolve();
      if (input.releaseCollection) await input.releaseCollection.promise;
    };
    const detail = { sourceId: input.executionMode === "fake" ? "fake:aurora-careers" : "greenhouse:concurrency", detailId: "concurrency-1", company: "Concurrency Co", title: "AI Engineer", location: "上海", postedAt: now.toISOString(), deadline: null, sourceType: "company_careers" as const, isOfficial: true as const, rawPayload: {} };
    const adapter: JobDiscoveryAdapter = {
      adapter: input.executionMode === "greenhouse" ? "greenhouse" : "fake", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: input.executionMode === "greenhouse" ? "greenhouse" : "fake", adapterVersion: "test", contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false as const, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async ({ sourceScope }: any) => ({ ok: true as const, data: { items: [{ sourceId: detail.sourceId, detailId: detail.detailId, company: detail.company, title: detail.title, location: detail.location, postedAt: detail.postedAt, deadline: detail.deadline }], sourceReceipts: sourceScope.sources.map((sourceId: string) => ({ sourceId, checked: true as const, candidateCount: sourceId === detail.sourceId ? 1 : 0 })) } }),
      getDetail: async () => { await waitAtCollection(); return { ok: true as const, data: detail }; },
    };
    const sourceHealthAdapter: SourceHealthDiscoveryAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async ({ source }: { source: { sourceId: string } }) => { await waitAtCollection(); return { ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: [detail.detailId], candidates: [{ sourceId: source.sourceId, detailId: detail.detailId, company: null, title: detail.title, location: detail.location }] } }; },
      getSourceDetail: async ({ source }: { source: { sourceId: string; boardToken: string } }) => ({ ok: true as const, attemptCount: 1, data: { ...detail, sourceId: source.sourceId, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/${detail.detailId}` } }),
    };
    return createAgentRunProcessor({
      db: database, auditTrail: input.auditTrail, id: () => crypto.randomUUID(), clock: input.clock ?? (() => now), contentStore: new Store(), checkpoint: input.checkpoint ?? checkpoint(), matchingQueue: input.matchingQueue,
      ...(input.executionMode === "layered_public"
        ? { adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: (input) => ({ run: async () => { await waitAtCollection(); return { branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const }, diagnostics: [], discoveryFacts: plannedLayeredDiscoveryFacts(input.executionSpec) }; } }) } }
        : { adapterResolver: resolver(adapter), ...(input.executionMode === "greenhouse" ? { sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter } } : {}) }),
    });
  }

  function auditThatPausesAfter(eventType: string, entered: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>) {
    const base = createAuditTrail({ db: database, clock: () => now });
    return {
      append: (event: any) => base.append(event),
      bind(transaction: any) {
        const bound = base.bind(transaction);
        return {
          append: async (event: any) => {
            await bound.append(event);
            if (event.eventType === eventType) { entered.resolve(); await release.promise; }
          },
          bind: bound.bind,
          query: bound.query,
        };
      },
      query: (input: any) => base.query(input),
    };
  }

  it("推荐根以可信公开空分支继续 mixed candidate_failures，并发布空结果 child", async () => {
    const templateRoot = await recommendationRoot("layered_public");
    const [template] = await database.select().from(agentRuns).where(eq(agentRuns.id, templateRoot.runId));
    const sourceScope = template!.sourceScope as any;
    const firstQuery = sourceScope.publicDiscovery.queries[0]!;
    const secondQuery = { ...firstQuery, ordinal: 2, queryId: crypto.randomUUID(), stableFingerprint: "f".repeat(64), query: `${firstQuery.query} 远程` };
    const rootRunId = crypto.randomUUID();
    await database.insert(agentRuns).values({
      ...template!, id: rootRunId, idempotencyKey: crypto.randomUUID(), sourceScope: { ...sourceScope, publicDiscovery: { ...sourceScope.publicDiscovery, queries: [firstQuery, secondQuery] } },
      status: "queued", currentStep: "queued", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, startedAt: null, completedAt: null, failedAt: null, cancelledAt: null, failureCode: null, terminationKind: null, terminationBudgetDimension: null,
      version: 1, attemptCount: 0, activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: false, queuedAt: now, createdAt: now, updatedAt: now,
    });
    await database.insert(agentRunSteps).values(["batch_search", "fetch_details", "persist_results"].map((stepKey, index) => ({ id: crypto.randomUUID(), userId: templateRoot.userId, runId: rootRunId, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));
    const rootProcessor = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({
        branchOutcome: { trusted: "failed" as const, publicDiscovery: "candidate_failures" as const }, diagnostics: [],
        discoveryFacts: {
          version: "recommendation-discovery-facts-v1" as const, trusted: [],
          publicQueries: [
            { queryId: firstQuery.queryId, checked: true, outcome: "credible_zero" as const, losses: [] },
            { queryId: secondQuery.queryId, checked: true, outcome: "verification_failed" as const, losses: [{ code: "VERIFICATION_FAILED" as const, retryable: false }] },
          ],
        },
      }) }) },
    });

    await expect(rootProcessor.process({ version: 1, userId: templateRoot.userId, runId: rootRunId, finalAttempt: true })).resolves.toBe("completed");
    const [child] = await database.select({ id: agentRuns.id, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.parentRunId, rootRunId));
    expect(child!.sourceScope).toMatchObject({ frozenRecommendationEvidence: { discoveryFacts: { publicQueries: expect.arrayContaining([
      expect.objectContaining({ queryId: firstQuery.queryId, outcome: "credible_zero" }),
      expect.objectContaining({ queryId: secondQuery.queryId, outcome: "verification_failed", losses: [{ code: "VERIFICATION_FAILED", retryable: false }] }),
    ]) } } });
    const childProcessor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(childProcessor.process({ version: 1, userId: templateRoot.userId, runId: child!.id, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ kind: recommendationResults.kind, itemCount: recommendationResults.itemCount }).from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id))).resolves.toEqual([{ kind: "no_recommendations", itemCount: 0 }]);
  });

  it("推荐根冻结 runtime 的可信来源 auth/timeout 损失并发布最终 suggestion", async () => {
    const root = await recommendationRoot("layered_public", { withWatchlist: true });
    const [rootRun] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, root.runId));
    const trustedSource = (rootRun!.sourceScope as any).trustedSources[0]!;
    const runtime = createLayeredPublicJobDiscoveryRuntime({
      db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }), contentStore: new Store(), evidenceStore: new Store() as never,
      trustedSourceAdapter: {
        adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
        declareCapabilities: ({ sourceId }: any) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
        listSource: async ({ source }: any) => ({ ok: true as const, data: { sourceId: source.sourceId, observedDetailIds: ["auth", "timeout", "good"], candidates: [{ sourceId: source.sourceId, detailId: "auth" }, { sourceId: source.sourceId, detailId: "timeout" }, { sourceId: source.sourceId, detailId: "good" }] } }),
        getSourceDetail: async ({ source, detailId }: any) => detailId === "good"
          ? { ok: true as const, data: { sourceId: source.sourceId, detailId, company: "Runtime", title: "AI 应用工程师", location: "上海", postedAt: now.toISOString(), deadline: null, sourceType: "company_careers" as const, isOfficial: true as const, rawPayload: { id: detailId } } }
          : { ok: false as const, error: { code: detailId === "timeout" ? "GREENHOUSE_TIMEOUT" : "GREENHOUSE_AUTH_FAILED" } },
      },
      anySearch: { isConfigured: () => false, search: async () => ({ candidates: [] }), extract: async () => { throw new Error("UNUSED"); } }, preflight: async () => null, fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
    });
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), attemptCount: 1, controlState: "none" }).where(eq(agentRuns.id, root.runId));
    const [claimed] = await database.select().from(agentRuns).where(eq(agentRuns.id, root.runId));
    const executionSpec = { targetSnapshot: claimed!.targetSnapshot, profileSnapshot: claimed!.profileSnapshot, watchlistSnapshot: claimed!.watchlistSnapshot, sourceScope: claimed!.sourceScope, workflowVersion: claimed!.workflowVersion, ruleVersion: claimed!.ruleVersion, adapter: claimed!.adapter, adapterVersion: claimed!.adapterVersion, outputSchemaVersion: claimed!.outputSchemaVersion, toolAllowlist: claimed!.toolAllowlist, model: claimed!.modelSnapshot, budget: claimed!.budgetSnapshot };
    const runtimeOutcome = await runtime.run({ userId: root.userId, runId: root.runId, claimToken, now, executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined, signal: new AbortController().signal });
    expect(runtimeOutcome).toMatchObject({ branchOutcome: { trusted: "succeeded" }, discoveryFacts: { trusted: [{ sourceId: trustedSource.source.sourceId, checked: true, outcome: "credible_results", losses: [{ code: "VERIFICATION_FAILED", retryable: false }, { code: "VERIFICATION_FAILED", retryable: true }] }] } });
    await database.update(agentRuns).set({ status: "queued", currentStep: "queued", startedAt: null, activeSliceStartedAt: null, claimToken: null, claimExpiresAt: null, attemptCount: 0 }).where(eq(agentRuns.id, root.runId));
    const rootProcessor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => runtimeOutcome }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(rootProcessor.process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true })).resolves.toBe("completed");
    const [child] = await database.select({ id: agentRuns.id, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.parentRunId, root.runId));
    expect(child!.sourceScope).toMatchObject({ frozenRecommendationEvidence: { discoveryFacts: { trusted: [{ sourceId: trustedSource.source.sourceId, checked: true, outcome: "credible_results", losses: [{ code: "VERIFICATION_FAILED", retryable: false }, { code: "VERIFICATION_FAILED", retryable: true }] }] } } });
    const childProcessor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(childProcessor.process({ version: 1, userId: root.userId, runId: child!.id, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ kind: recommendationResults.kind, evidence: recommendationResults.evidence }).from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id))).resolves.toEqual([expect.objectContaining({ kind: expect.any(String), evidence: expect.objectContaining({
      coverageLosses: expect.arrayContaining([expect.objectContaining({ code: "VERIFICATION_FAILED", retryable: true, affectedCount: 1 })]),
      suggestedActions: expect.arrayContaining(["review_source_health"]),
    }) })]);
  });

  it("推荐根冻结 list auth 失败并把来源修复建议发布到最终 suggestion", async () => {
    const root = await recommendationRoot("layered_public", { watchlistCount: 2 });
    const [rootRun] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, root.runId));
    const trustedSources = (rootRun!.sourceScope as any).trustedSources as Array<{ source: { sourceId: string } }>;
    const failedSourceId = trustedSources[0]!.source.sourceId;
    const runtime = createLayeredPublicJobDiscoveryRuntime({
      db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }), contentStore: new Store(), evidenceStore: new Store() as never,
      trustedSourceAdapter: {
        adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
        declareCapabilities: ({ sourceId }: any) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
        listSource: async ({ source }: any) => source.sourceId === failedSourceId
          ? { ok: false as const, error: { code: "GREENHOUSE_AUTH_FAILED" } }
          : { ok: true as const, data: { sourceId: source.sourceId, observedDetailIds: ["good"], candidates: [{ sourceId: source.sourceId, detailId: "good" }] } },
        getSourceDetail: async ({ source, detailId }: any) => ({ ok: true as const, data: { sourceId: source.sourceId, detailId, company: "Runtime", title: "AI 应用工程师", location: "上海", postedAt: now.toISOString(), deadline: null, sourceType: "company_careers" as const, isOfficial: true as const, rawPayload: { id: detailId } } }),
      },
      anySearch: { isConfigured: () => false, search: async () => ({ candidates: [] }), extract: async () => { throw new Error("UNUSED"); } }, preflight: async () => null, fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
    });
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), attemptCount: 1, controlState: "none" }).where(eq(agentRuns.id, root.runId));
    const [claimed] = await database.select().from(agentRuns).where(eq(agentRuns.id, root.runId));
    const executionSpec = { targetSnapshot: claimed!.targetSnapshot, profileSnapshot: claimed!.profileSnapshot, watchlistSnapshot: claimed!.watchlistSnapshot, sourceScope: claimed!.sourceScope, workflowVersion: claimed!.workflowVersion, ruleVersion: claimed!.ruleVersion, adapter: claimed!.adapter, adapterVersion: claimed!.adapterVersion, outputSchemaVersion: claimed!.outputSchemaVersion, toolAllowlist: claimed!.toolAllowlist, model: claimed!.modelSnapshot, budget: claimed!.budgetSnapshot };
    const runtimeOutcome = await runtime.run({ userId: root.userId, runId: root.runId, claimToken, now, executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined, signal: new AbortController().signal });
    expect(runtimeOutcome).toMatchObject({ branchOutcome: { trusted: "succeeded" }, discoveryFacts: { trusted: expect.arrayContaining([{ sourceId: failedSourceId, checked: true, outcome: "failed", losses: [{ code: "TRUSTED_SOURCE_UNAVAILABLE", retryable: false }] }]) } });
    await database.update(agentRuns).set({ status: "queued", currentStep: "queued", startedAt: null, activeSliceStartedAt: null, claimToken: null, claimExpiresAt: null, attemptCount: 0 }).where(eq(agentRuns.id, root.runId));
    const rootProcessor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => runtimeOutcome }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(rootProcessor.process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true })).resolves.toBe("completed");
    const [child] = await database.select({ id: agentRuns.id, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.parentRunId, root.runId));
    expect(child!.sourceScope).toMatchObject({ frozenRecommendationEvidence: { discoveryFacts: { trusted: expect.arrayContaining([expect.objectContaining({ sourceId: failedSourceId, outcome: "failed", losses: [{ code: "TRUSTED_SOURCE_UNAVAILABLE", retryable: false }] })]) } } });
    const childProcessor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(childProcessor.process({ version: 1, userId: root.userId, runId: child!.id, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ evidence: recommendationResults.evidence }).from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id))).resolves.toEqual([expect.objectContaining({ evidence: expect.objectContaining({
      coverageLosses: expect.arrayContaining([expect.objectContaining({ code: "TRUSTED_SOURCE_UNAVAILABLE", retryable: false, affectedCount: 1 })]),
      suggestedActions: expect.arrayContaining(["review_source_health"]),
    }) })]);
  });

  function successAdapter(calls = { search: 0, detail: 0 }): JobDiscoveryAdapter {
    const summary = { sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null };
    return {
      adapter: "fake", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "fake", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => { calls.search += 1; return { ok: true, data: [summary] }; },
      getDetail: async () => { calls.detail += 1; return { ok: true, data: { ...summary, sourceType: "company_careers", isOfficial: true, rawPayload: { source: "aurora" } } }; },
    };
  }

  it("旧的超硬上限预算快照仍可读取，并按当前系统上限执行", async () => {
    const job = await run();
    await database.update(agentRuns).set({
      budgetSnapshot: { maxActiveDurationMs: 600_000, maxAttempts: 99, maxToolCalls: 99, maxResults: 99, maxModelCalls: 99, maxTokens: 99_999 },
    }).where(eq(agentRuns.id, job.runId));
    const calls = { search: 0, detail: 0 };
    const summaries = Array.from({ length: 5 }, (_, index) => ({ sourceId: "fake:aurora-careers", detailId: `legacy-${index}`, company: "示例科技", title: `AI 工程师 ${index}`, location: "上海", postedAt: null, deadline: null }));
    const adapter: JobDiscoveryAdapter = {
      adapter: "fake", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "fake", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => { calls.search += 1; return { ok: true, data: summaries }; },
      getDetail: async (request) => { calls.detail += 1; const summary = summaries.find((item) => item.sourceId === request.sourceId && item.detailId === request.detailId)!; return { ok: true, data: { ...summary, sourceType: "company_careers", isOfficial: true, rawPayload: {} } }; },
    };
    const processor = createAgentRunProcessor({
      db: database, adapterResolver: resolver(adapter), checkpoint: checkpoint(), contentStore: new Store(),
      auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(calls).toEqual({ search: 1, detail: 5 });
    await expect(database.select({ resultCount: agentRuns.resultCount, status: agentRuns.status, snapshot: agentRuns.budgetSnapshot }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([
      expect.objectContaining({ status: "completed", resultCount: 5, snapshot: expect.objectContaining({ maxResults: 99, maxAttempts: 99 }) }),
    ]);
  });

  it("旧分层来源范围按当前 hard 上限收窄后才交给执行器", async () => {
    const job = await layeredRun();
    const [stored] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, job.runId));
    const original = stored!.sourceScope as any;
    const trustedSources = Array.from({ length: 51 }, (_, index) => ({
      ...original.trustedSources[0],
      source: { ...original.trustedSources[0].source, sourceId: `greenhouse:legacy-${index}`, boardToken: `legacy-${index}`, careersUrl: `https://boards.greenhouse.io/legacy-${index}` },
    }));
    await database.update(agentRuns).set({ sourceScope: { ...original, trustedSources, publicDiscovery: { ...original.publicDiscovery, maxVerificationCandidates: 99 } } }).where(eq(agentRuns.id, job.runId));
    let received: { trustedSources: unknown[]; publicDiscovery: { maxVerificationCandidates: number } } | undefined;
    const processor = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: (input) => { received = input.executionSpec.sourceScope; return { run: async () => ({ branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, diagnostics: [] }) }; } },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(received).toMatchObject({ trustedSources: Array.from({ length: 50 }, () => expect.anything()), publicDiscovery: { maxVerificationCandidates: 10 } });
  });

  it("历史 recommendation root 的第十一条 query 在执行 hardcap 后冻结为预算裁剪事实", async () => {
    const templateRoot = await recommendationRoot("layered_public");
    const [template] = await database.select().from(agentRuns).where(eq(agentRuns.id, templateRoot.runId));
    const originalScope = template!.sourceScope as any;
    const queryTemplate = originalScope.publicDiscovery.queries[0]!;
    const historicalScope = {
      ...originalScope,
      publicDiscovery: {
        ...originalScope.publicDiscovery,
        queries: Array.from({ length: 11 }, (_, index) => ({
          ...queryTemplate,
          ordinal: index + 1,
          queryId: crypto.randomUUID(),
          stableFingerprint: createHash("sha256").update(`legacy-query-${index}`).digest("hex"),
        })),
      },
    };
    const historicalRunId = crypto.randomUUID();
    await database.insert(agentRuns).values({
      ...template!,
      id: historicalRunId,
      idempotencyKey: crypto.randomUUID(),
      sourceScope: historicalScope,
      status: "queued",
      currentStep: "queued",
      claimToken: null,
      claimExpiresAt: null,
      activeSliceStartedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      failureCode: null,
      terminationKind: null,
      terminationBudgetDimension: null,
      version: 1,
      attemptCount: 0,
      activeDurationMs: 0,
      toolCallCount: 0,
      sourceRequestCount: 0,
      modelCallCount: 0,
      inputTokenCount: 0,
      outputTokenCount: 0,
      totalTokenCount: 0,
      resultCount: 0,
      usageComplete: false,
      queuedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await database.insert(agentRunSteps).values(["batch_search", "fetch_details", "persist_results"].map((stepKey, index) => ({ id: crypto.randomUUID(), userId: templateRoot.userId, runId: historicalRunId, stepKey, ordinal: index + 1, status: "pending", attemptCount: 0 })));

    let received: any;
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: (input) => {
        received = input.executionSpec.sourceScope;
        return { run: async () => ({
          branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const },
          diagnostics: [],
          discoveryFacts: plannedLayeredDiscoveryFacts(input.executionSpec),
        }) };
      } },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    await expect(processor.process({ version: 1, userId: templateRoot.userId, runId: historicalRunId, finalAttempt: true })).resolves.toBe("completed");
    expect(received.publicDiscovery.queries).toHaveLength(10);
    await expect(database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, historicalRunId))).resolves.toEqual([{ sourceScope: historicalScope }]);
    const [child] = await database.select({ id: agentRuns.id, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.parentRunId, historicalRunId));
    expect((child!.sourceScope as any).frozenRecommendationEvidence).toMatchObject({
      plannedTrustedSourceCount: historicalScope.trustedSources.length,
      plannedPublicQueryCount: 11,
      discoveryFacts: {
        publicQueries: expect.arrayContaining([
          expect.objectContaining({
            queryId: historicalScope.publicDiscovery.queries[10]!.queryId,
            checked: false,
            outcome: "failed",
            losses: [{ code: "DISCOVERY_BUDGET_EXCEEDED", retryable: false }],
          }),
        ]),
      },
    });
    expect((child!.sourceScope as any).frozenRecommendationEvidence.discoveryFacts.publicQueries).toHaveLength(11);
    const childOutcome = await createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: templateRoot.userId, runId: child!.id, finalAttempt: true });
    expect(childOutcome).toBe("completed");
    await expect(Promise.all([
      database.select({ kind: recommendationResults.kind, evidence: recommendationResults.evidence }).from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, templateRoot.userId)),
    ])).resolves.toEqual([[expect.objectContaining({ kind: "no_recommendations", evidence: expect.objectContaining({ coverageLosses: expect.arrayContaining([expect.objectContaining({ code: "DISCOVERY_BUDGET_EXCEEDED", affectedCount: 1 })]) }) })], []]);
  });

  it("低结果额度的 fake 运行只读取并发布允许的一条详情", async () => {
    const job = await run({ maxResults: 1 });
    const calls = { search: 0, detail: 0 };
    const summaries = Array.from({ length: 3 }, (_, index) => ({ sourceId: "fake:aurora-careers", detailId: `limited-${index}`, company: "示例科技", title: `AI 工程师 ${index}`, location: "上海", postedAt: null, deadline: null }));
    const adapter: JobDiscoveryAdapter = {
      adapter: "fake", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "fake", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => { calls.search += 1; return { ok: true, data: summaries }; },
      getDetail: async (request) => { calls.detail += 1; const summary = summaries.find((item) => item.sourceId === request.sourceId && item.detailId === request.detailId)!; return { ok: true, data: { ...summary, sourceType: "company_careers", isOfficial: true, rawPayload: {} } }; },
    };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(calls).toEqual({ search: 1, detail: 1 });
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ accountPolicyRevisionNumber: 1, budget: { maxResults: 1 }, usage: { results: 1 }, results: [expect.anything()] });
  });

  it("零结果额度安全完成，不读取详情也不报告结果", async () => {
    const job = await run({ maxResults: 0 });
    let details = 0;
    const adapter: JobDiscoveryAdapter = {
      adapter: "fake", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "fake", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => ({ ok: true, data: [{ sourceId: "fake:aurora-careers", detailId: "zero", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null }] }),
      getDetail: async () => { details += 1; return { ok: false, error: { code: "UNUSED", retryable: false } }; },
    };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(details).toBe(0);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "completed", budget: { maxResults: 0 }, usage: { results: 0 }, results: [] });
  });

  it("推荐根可信空发现创建并原子发布 no_recommendations child", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const profileId = crypto.randomUUID(); const factId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    const fingerprint = crypto.randomUUID();
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    const preflight = createRunPreflightEvaluator({ capabilityAdapter: { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) }, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "layered_public", id: () => crypto.randomUUID(), clock: () => now });
    const service = createRecommendationRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode: "layered_public", id: () => crypto.randomUUID(), clock: () => now });
    const preparation = await preflight.evaluate(database, { userId, workflow: "recommendation", trigger: "manual" });
    const started = await service.start({ userId, requestId: crypto.randomUUID(), command: { idempotencyKey: crypto.randomUUID(), warningFingerprint: preparation.report.warningFingerprint } });
    const rootId = started.run.runId;
    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: (input) => ({ run: async () => ({ branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, diagnostics: [], discoveryFacts: plannedLayeredDiscoveryFacts(input.executionSpec) }) }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId, runId: rootId, finalAttempt: true });
    const [terminal] = await database.select({ failureCode: agentRuns.failureCode }).from(agentRuns).where(eq(agentRuns.id, rootId));
    expect({ outcome, terminal }).toEqual({ outcome: "completed", terminal: { failureCode: null } });
    const [root] = await database.select().from(agentRuns).where(eq(agentRuns.id, rootId));
    const [child] = await database.select({ id: agentRuns.id, parentRunId: agentRuns.parentRunId, runPurpose: agentRuns.runPurpose, preflight: agentRuns.preflightSnapshot }).from(agentRuns).where(eq(agentRuns.parentRunId, rootId));
    expect(child).toEqual(expect.objectContaining({ parentRunId: rootId, runPurpose: "recommendation", preflight: root!.preflightSnapshot }));
    const directClaimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "create_recommendations", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken: directClaimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, child!.id));
    const commands = createDeepMatchCommands({ db: database, id: () => crypto.randomUUID(), clock: () => now });
    const directInput = { userId, targetId, runId: child!.id, fence: { claimToken: directClaimToken }, selectionExclusions: [], ruleConfig: { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] } };
    await expect(Reflect.apply(commands.publishStagedRun, commands, [{ ...directInput, onPublished: async () => undefined }])).rejects.toThrow("DEEP_MATCH_RECOMMENDATION_CALLBACK_REQUIRED");
    await expect(commands.publishStagedRun({ ...directInput, recommendation: { rootRunId: rootId }, onPublished: async (transaction) => {
      await transaction.update(agentRuns).set({ status: "completed", currentStep: "completed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, completedAt: now, failedAt: null, cancelledAt: null, failureCode: null, terminationKind: null, terminationBudgetDimension: null, resultCount: 0, usageComplete: false }).where(eq(agentRuns.id, child!.id));
    } })).rejects.toThrow("DEEP_MATCH_RECOMMENDATION_CALLBACK_INCOMPLETE");
    await expect(commands.publishStagedRun({ ...directInput, recommendation: { rootRunId: rootId }, onPublished: async () => undefined })).rejects.toThrow("DEEP_MATCH_RECOMMENDATION_CALLBACK_INCOMPLETE");
    await expect(commands.publishStagedRun({ ...directInput, recommendation: { rootRunId: rootId }, onPublished: async () => { throw new Error("callback failed"); } })).rejects.toThrow("callback failed");
    const extraPostingId = crypto.randomUUID(); const extraVersionId = crypto.randomUUID(); const extraOpportunityId = crypto.randomUUID(); const extraHash = "e".repeat(64);
    await database.insert(jobSourcePostings).values({ id: extraPostingId, userId, sourceType: "company_careers", sourceIdentifier: extraHash, sourceId: "greenhouse:unfrozen", sourceIdentity: { sourceId: "greenhouse:unfrozen", detailId: "unfrozen" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: extraVersionId, userId, sourcePostingId: extraPostingId, version: 1, contentSha256: extraHash, rawContentSha256: extraHash, rawObjectReference: {}, normalizedData: {}, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: extraOpportunityId, userId, importId: null, sourcePostingVersionId: extraVersionId, canonicalOpportunityId: null, dedupKey: extraHash, company: "Unfrozen Co", title: "AI Engineer", location: "上海", postedAt: now, deadline: null, description: "TypeScript", normalizedData: {}, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId: extraOpportunityId, sourcePostingVersionId: extraVersionId, createdAt: now });
    const extraRootResultId = crypto.randomUUID();
    await database.insert(jobDiscoveryRunResults).values({ id: extraRootResultId, userId, runId: rootId, sourcePostingVersionId: extraVersionId, ordinal: 1, createdAt: now });
    await expect(commands.publishStagedRun({ ...directInput, recommendation: { rootRunId: rootId }, onPublished: async () => undefined })).rejects.toThrow("DEEP_MATCH_RECOMMENDATION_FACTS_INVALID");
    await database.delete(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.id, extraRootResultId));
    await expect(Promise.all([
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, userId)),
      database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.kind, "recommendation_result"))),
    ])).resolves.toEqual([[], [], []]);
    await database.update(agentRuns).set({ status: "queued", currentStep: "queued", attemptCount: 0, startedAt: null, activeSliceStartedAt: null, claimToken: null, claimExpiresAt: null }).where(eq(agentRuns.id, child!.id));
    const childProcessor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await database.insert(jobDiscoveryRunResults).values({ id: extraRootResultId, userId, runId: rootId, sourcePostingVersionId: extraVersionId, ordinal: 1, createdAt: now });
    await expect(childProcessor.process({ version: 1, userId, runId: child!.id, finalAttempt: true })).resolves.toBe("failed");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, child!.id)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, userId)),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, userId)),
    ])).resolves.toEqual([[{ status: "failed", failureCode: "AGENT_RUN_PERSIST_FAILED", terminationKind: "persistence_failed" }], [], [], []]);
    await database.delete(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.id, extraRootResultId));
    await database.update(agentRuns).set({ status: "queued", currentStep: "queued", attemptCount: 0, startedAt: null, activeSliceStartedAt: null, claimToken: null, claimExpiresAt: null, completedAt: null, failedAt: null, failureCode: null, terminationKind: null, terminationBudgetDimension: null, usageComplete: false, resultCount: 0 }).where(eq(agentRuns.id, child!.id));
    await database.update(agentRunSteps).set({ status: "pending", attemptCount: 0, startedAt: null, completedAt: null, failedAt: null, failureCode: null }).where(eq(agentRunSteps.runId, child!.id));
    const auditFailure = createAuditTrail({ db: database, clock: () => now });
    const auditFailureProcessor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: { ...auditFailure, bind: (transaction: any) => {
      const bound = auditFailure.bind(transaction);
      return { ...bound, append: async (event: any) => { if (event.eventType === "agent.run_completed") throw new Error("audit publication failed"); return bound.append(event); } };
    } } as any, id: () => crypto.randomUUID(), clock: () => now });
    await expect(auditFailureProcessor.process({ version: 1, userId, runId: child!.id, finalAttempt: true })).resolves.toBe("failed");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, child!.id)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, userId)),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, userId)),
    ])).resolves.toEqual([[{ status: "failed", failureCode: "AGENT_RUN_PERSIST_FAILED", terminationKind: "persistence_failed" }], [], [], []]);
    await database.update(agentRuns).set({ status: "queued", currentStep: "queued", attemptCount: 0, startedAt: null, activeSliceStartedAt: null, claimToken: null, claimExpiresAt: null, completedAt: null, failedAt: null, failureCode: null, terminationKind: null, terminationBudgetDimension: null, usageComplete: false, resultCount: 0 }).where(eq(agentRuns.id, child!.id));
    await database.update(agentRunSteps).set({ status: "pending", attemptCount: 0, startedAt: null, completedAt: null, failedAt: null, failureCode: null }).where(eq(agentRunSteps.runId, child!.id));
    const childOutcome = await childProcessor.process({ version: 1, userId, runId: child!.id, finalAttempt: true });
    expect(childOutcome).toBe("completed");
    await expect(Promise.all([
      database.select({ id: recommendationResults.id, kind: recommendationResults.kind, itemCount: recommendationResults.itemCount, recommendationListId: recommendationResults.recommendationListId }).from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, userId)),
      database.select({ recommendationResultId: agentInboxItems.recommendationResultId }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.kind, "recommendation_result"))),
      database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, userId)),
      database.select({ resultKind: firstRecommendationJourneyCompletions.resultKind }).from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, userId)),
      database.select({ status: agentRuns.status, claimToken: agentRuns.claimToken, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, child!.id)),
    ])).resolves.toEqual([
      [expect.objectContaining({ kind: "no_recommendations", itemCount: 0, recommendationListId: null })], [], [], [expect.any(Object)], [], [{ resultKind: "no_recommendations" }], [{ status: "completed", claimToken: null, resultCount: 0 }],
    ]);
    const [zeroResult] = await database.select({ id: recommendationResults.id }).from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id));
    const [zeroInbox] = await database.select({ recommendationResultId: agentInboxItems.recommendationResultId }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.kind, "recommendation_result")));
    expect(zeroInbox!.recommendationResultId).toBe(zeroResult!.id);
  });

  it("recommendation root 在成功发现但缺失 facts 时于 handoff 原子回滚", async () => {
    const root = await recommendationRoot("fake");
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: resolver(successAdapter()),
      checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    await expect(processor.process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true })).resolves.toBe("retry");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, currentStep: agentRuns.currentStep }).from(agentRuns).where(eq(agentRuns.id, root.runId)),
      database.select().from(agentRuns).where(eq(agentRuns.parentRunId, root.runId)),
      database.select().from(jobTriageVersions).where(eq(jobTriageVersions.userId, root.userId)),
    ])).resolves.toEqual([[{ status: "queued", currentStep: "persist_results" }], [], []]);
  });

  it("recommendation root 在成功发现但 facts identity 错误时于 handoff 原子回滚", async () => {
    const root = await recommendationRoot("layered_public");
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({
        branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const }, diagnostics: [],
        discoveryFacts: { version: "recommendation-discovery-facts-v1" as const, trusted: [], publicQueries: [{ queryId: crypto.randomUUID(), checked: true as const, outcome: "credible_zero" as const, losses: [] }] },
      }) }) },
      checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    await expect(processor.process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true })).resolves.toBe("failed");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, currentStep: agentRuns.currentStep }).from(agentRuns).where(eq(agentRuns.id, root.runId)),
      database.select().from(agentRuns).where(eq(agentRuns.parentRunId, root.runId)),
      database.select().from(jobTriageVersions).where(eq(jobTriageVersions.userId, root.userId)),
    ])).resolves.toEqual([[{ status: "failed", currentStep: "failed" }], [], []]);
  });

  it("recommendation root 在实际执行 query 缺少事实时回滚 child、triage 与完成事件", async () => {
    const root = await recommendationRoot("layered_public");
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: (input) => ({ run: async () => ({
        branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const },
        diagnostics: [],
        discoveryFacts: { ...plannedLayeredDiscoveryFacts(input.executionSpec), publicQueries: plannedLayeredDiscoveryFacts(input.executionSpec).publicQueries.slice(1) },
      }) }) },
      checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    await expect(processor.process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true })).resolves.toBe("failed");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, currentStep: agentRuns.currentStep }).from(agentRuns).where(eq(agentRuns.id, root.runId)),
      database.select().from(agentRuns).where(eq(agentRuns.parentRunId, root.runId)),
      database.select().from(jobTriageVersions).where(eq(jobTriageVersions.userId, root.userId)),
      database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, root.runId), eq(agentRunEvents.eventType, "run.completed"))),
    ])).resolves.toEqual([[{ status: "failed", currentStep: "failed" }], [], [], []]);
  });

  it("layered recommendation 根把真实非空 discovery tuple 保守冻结为 initialized 空 child", async () => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const profileId = crypto.randomUUID(); const factId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    const fingerprint = crypto.randomUUID();
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    const preflight = createRunPreflightEvaluator({ capabilityAdapter: { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) }, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "layered_public", id: () => crypto.randomUUID(), clock: () => now });
    const service = createRecommendationRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode: "layered_public", id: () => crypto.randomUUID(), clock: () => now });
    const preparation = await preflight.evaluate(database, { userId, workflow: "recommendation", trigger: "manual" });
    const started = await service.start({ userId, requestId: crypto.randomUUID(), command: { idempotencyKey: crypto.randomUUID(), warningFingerprint: preparation.report.warningFingerprint } });
    const sourcePostingId = crypto.randomUUID(); const sourcePostingVersionId = crypto.randomUUID(); const sourceHash = "f".repeat(64);
    await database.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "company_careers", sourceIdentifier: sourceHash, sourceIdentity: { sourceId: "greenhouse:metadata", detailId: "1" }, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: sourceHash, rawContentSha256: sourceHash, rawObjectReference: { key: "metadata" }, normalizedData: { sourceId: "greenhouse:metadata", detailId: "1", company: "Metadata Co", title: "AI Engineer", location: "上海", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true }, retrievedAt: now, availability: "open", createdAt: now });
    const queryId = crypto.randomUUID(); const leadId = crypto.randomUUID();
    await database.insert(jobDiscoveryLeads).values({ id: leadId, userId, runId: started.run.runId, targetId, provider: "anysearch", queryId, queryKind: "general", queryFingerprint: sourceHash, normalizedUrl: "https://fixture.invalid/metadata", stableFingerprint: "e".repeat(64), expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), state: "verified", sourcePostingVersionId, verifiedFinalUrl: "https://fixture.invalid/metadata", rejectionCode: null, createdAt: now, updatedAt: now });
    await database.insert(jobDiscoveryAttributions).values({ id: crypto.randomUUID(), userId, runId: started.run.runId, leadId, queryId, provider: "anysearch", sourcePostingVersionId, createdAt: now });
    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: (input) => ({ run: async () => ({ branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, diagnostics: [], sourcePostingVersionIds: [sourcePostingVersionId], trustedSourcePostingVersionIds: [sourcePostingVersionId], discoveryFacts: plannedLayeredDiscoveryFacts(input.executionSpec) }) }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId, runId: started.run.runId, finalAttempt: true });

    const [rootTerminal] = await database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode }).from(agentRuns).where(eq(agentRuns.id, started.run.runId));
    expect({ outcome, rootTerminal }).toEqual({ outcome: "completed", rootTerminal: { status: "completed", failureCode: null } });
    const [triage] = await database.select({ opportunityId: jobTriageVersions.opportunityId, overallVerdict: jobTriageVersions.overallVerdict, overallScore: jobTriageVersions.overallScore }).from(jobTriageVersions).where(eq(jobTriageVersions.sourcePostingVersionId, sourcePostingVersionId));
    expect(triage).toMatchObject({ overallVerdict: "unknown", overallScore: null });
    await expect(database.select({ parentRunId: agentRuns.parentRunId, runPurpose: agentRuns.runPurpose, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.parentRunId, started.run.runId)))
      .resolves.toEqual([expect.objectContaining({ parentRunId: started.run.runId, runPurpose: "recommendation", sourceScope: expect.objectContaining({ initialized: true, selectionExclusions: [{ opportunityId: triage!.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }] }) })]);
  });

  it("layered recommendation 根以完整冻结资格生成并原子发布非空 child candidate", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    const { userId, targetId, profileId, sourcePostingVersionId, plannedQuery, rootRunId, rootBeforeCompletion, rootAfterCompletion, outcome, triage, child } = fixture;
    expect(outcome).toBe("completed");
    expect(triage).toMatchObject({ userId, sourcePostingVersionId, profileId, profileVersion: 1, targetId, targetVersion: 1, overallVerdict: "pass", overallScore: expect.any(Number) });
    expect(rootAfterCompletion).toEqual(rootBeforeCompletion);
    expect((child!.sourceScope as any).frozenRecommendationEvidence).toMatchObject({ frozenTriageVersionIds: [triage!.id], discoveryFacts: { publicQueries: expect.arrayContaining([expect.objectContaining({ queryId: plannedQuery.queryId, checked: true, outcome: "credible_results", losses: [] })]) } });
    await expect(database.select({ candidateSnapshot: deepMatchRunCandidates.candidateSnapshot }).from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, child!.id))).resolves.toEqual([{ candidateSnapshot: expect.objectContaining({ triageVersionId: triage!.id, opportunityId: triage!.opportunityId, sourcePostingVersionId, profileId, profileVersion: 1, targetVersion: 1 }) }]);
    const childOutcome = await createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId, runId: child!.id, finalAttempt: true });
    expect(childOutcome).toBe("completed");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, claimToken: agentRuns.claimToken, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, child!.id)),
      database.select({ id: recommendationResults.id, kind: recommendationResults.kind, rootRunId: recommendationResults.rootRunId, producerRunId: recommendationResults.producerRunId, recommendationListId: recommendationResults.recommendationListId, itemCount: recommendationResults.itemCount }).from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id)),
      database.select({ kind: agentInboxItems.kind, recommendationListId: agentInboxItems.recommendationListId }).from(agentInboxItems).where(eq(agentInboxItems.userId, userId)),
      database.select({ resultKind: firstRecommendationJourneyCompletions.resultKind }).from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, userId)),
    ])).resolves.toEqual([
      [{ status: "completed", claimToken: null, resultCount: 1 }],
      [expect.objectContaining({ id: expect.any(String), kind: "recommendation_list", rootRunId, producerRunId: child.id, recommendationListId: expect.any(String), itemCount: 1 })],
      expect.arrayContaining([expect.objectContaining({ kind: "recommendation_list", recommendationListId: expect.any(String) })]),
      [{ resultKind: "recommendation_list" }],
    ]);
    const [publishedResult] = await database.select({ id: recommendationResults.id, recommendationListId: recommendationResults.recommendationListId }).from(recommendationResults).where(eq(recommendationResults.producerRunId, child!.id));
    const [publishedInbox] = await database.select({ recommendationListId: agentInboxItems.recommendationListId }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), eq(agentInboxItems.kind, "recommendation_list")));
    expect({ resultId: publishedResult!.id, resultListId: publishedResult!.recommendationListId, inboxListId: publishedInbox!.recommendationListId }).toEqual({ resultId: publishedResult!.id, resultListId: publishedResult!.id, inboxListId: publishedResult!.id });
  });

  it.each([
    ["缺失 adapter usage", async (fixture: Awaited<ReturnType<typeof stageFullyQualifiedLayeredRecommendationFixture>>) => {
      await database.update(deepMatchRunCandidates).set({ adapterUsage: null }).where(eq(deepMatchRunCandidates.runId, fixture.child.id));
    }],
    ["不合法 adapter usage", async (fixture: Awaited<ReturnType<typeof stageFullyQualifiedLayeredRecommendationFixture>>) => {
      await database.update(deepMatchRunCandidates).set({ adapterUsage: { inputTokens: "bad" } as any }).where(eq(deepMatchRunCandidates.runId, fixture.child.id));
    }],
    ["破坏 assessment evidence closure", async (fixture: Awaited<ReturnType<typeof stageFullyQualifiedLayeredRecommendationFixture>>) => {
      const [staged] = await database.select({ assessment: deepMatchRunCandidates.assessment }).from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, fixture.child.id));
      const malformed = structuredClone(staged!.assessment as any);
      malformed.evidenceSnapshot.jobEvidence = [];
      await database.update(deepMatchRunCandidates).set({ assessment: malformed }).where(eq(deepMatchRunCandidates.runId, fixture.child.id));
    }],
  ])("推荐 publisher 在首写前拒绝完全 staging 的 %s", async (_name, mutate) => {
    const fixture = await stageFullyQualifiedLayeredRecommendationFixture();
    await mutate(fixture);
    await expect(fixture.commands.publishStagedRun(fixture.input)).rejects.toThrow("DEEP_MATCH_RECOMMENDATION_FACTS_INVALID");
    await expectPublicationStillUnwritten({ userId: fixture.userId, childId: fixture.child.id });
  });

  it("publisher 在首写前以 active_duration 预算拒绝真实 staged recommendation child", async () => {
    const fixture = await stageFullyQualifiedLayeredRecommendationFixture();
    const [run] = await database.select({ workflowVersion: agentRuns.workflowVersion, budgetSnapshot: agentRuns.budgetSnapshot }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id));
    await database.update(agentRuns).set({ activeDurationMs: effectiveAgentRunBudget(run!.workflowVersion, run!.budgetSnapshot as any).maxActiveDurationMs }).where(eq(agentRuns.id, fixture.child.id));
    const onPublished = vi.fn(async () => undefined);
    await expect(fixture.commands.publishStagedRun({ ...fixture.input, onPublished })).rejects.toMatchObject({ message: "DEEP_MATCH_PUBLICATION_BUDGET_EXCEEDED", budgetDimension: "active_duration" });
    expect(onPublished).not.toHaveBeenCalled();
    await expectPublicationStillUnwritten({ userId: fixture.userId, childId: fixture.child.id });
  });

  it("recommendation child 在最后 checkpoint 后等待账户锁时以 fresh active_duration 预算终止发布", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture({ deepMatchMaxActiveDurationMs: 10_000 });
    const lockDatabase = createDatabase(container.getConnectionUri());
    const finalCheckpointEntered = deferred(); const releaseFinalCheckpoint = deferred(); const lockHeld = deferred(); const releaseLock = deferred();
    let clockNow = now;
    let finalCheckpointReturned = false;
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      if (input.runId === fixture.child.id && input.checkpointKey.endsWith(":step_create_recommendations_complete:1")) {
        expect(outcome.kind).toBe("continue");
        finalCheckpointEntered.resolve();
        await releaseFinalCheckpoint.promise;
        finalCheckpointReturned = true;
      }
      return outcome;
    } };
    const processor = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: controlled,
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => clockNow }), id: () => crypto.randomUUID(), clock: () => clockNow,
    });
    const processing = processor.process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true });
    let lock: Promise<unknown> | undefined;
    try {
      await waitForBarrier({ barrier: finalCheckpointEntered.promise, operation: processing, name: "recommendation child final publication checkpoint" });
      lock = lockDatabase.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${fixture.userId}, 0))`);
        lockHeld.resolve();
        await releaseLock.promise;
      });
      await lockHeld.promise;
      releaseFinalCheckpoint.resolve();
      await vi.waitFor(() => expect(finalCheckpointReturned).toBe(true), { timeout: 2_000 });
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(database);
      clockNow = new Date(now.getTime() + 10_001);
      releaseLock.resolve();
      await lock;
      await expect(processing).resolves.toBe("budget_exhausted");
      await expect(Promise.all([
        database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
        database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
        database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
        database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
        database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
        database.select({ kind: agentInboxItems.kind, runId: agentInboxItems.runId, budgetDimension: agentInboxItems.budgetDimension }).from(agentInboxItems).where(eq(agentInboxItems.userId, fixture.userId)),
        database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
        database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(and(eq(agentRunEvents.runId, fixture.child.id), eq(agentRunEvents.eventType, "run.completed"))),
        database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode, terminationKind: agentRuns.terminationKind, terminationBudgetDimension: agentRuns.terminationBudgetDimension }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id)),
      ])).resolves.toEqual([[], [], [], [], [], [{ kind: "budget_exhausted", runId: fixture.child.id, budgetDimension: "active_duration" }], [], [], [{ status: "failed", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", terminationKind: "budget_exhausted", terminationBudgetDimension: "active_duration" }]]);
    } finally {
      releaseFinalCheckpoint.resolve();
      releaseLock.resolve();
      await lock?.catch(() => undefined);
      await processing.catch(() => undefined);
      await lockDatabase.$client.end();
    }
  }, 60_000);

  it("recommendation child 在首个领域写入后超时，callback 预算检查回滚发布", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture({ deepMatchMaxActiveDurationMs: 10_000 });
    let clockNow = now;
    let finalCheckpointReturned = false;
    let publicationIds = 0;
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      if (input.runId === fixture.child.id && input.checkpointKey.endsWith(":step_create_recommendations_complete:1")) finalCheckpointReturned = true;
      return outcome;
    } };
    const processor = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: controlled,
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => clockNow }),
      id: () => {
        if (finalCheckpointReturned && ++publicationIds === 2) clockNow = new Date(now.getTime() + 10_001);
        return crypto.randomUUID();
      },
      clock: () => clockNow,
    });

    await expect(processor.process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("budget_exhausted");
    expect(publicationIds).toBeGreaterThanOrEqual(2);
    await expect(Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
      database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
      database.select({ kind: agentInboxItems.kind, runId: agentInboxItems.runId, budgetDimension: agentInboxItems.budgetDimension }).from(agentInboxItems).where(eq(agentInboxItems.userId, fixture.userId)),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(and(eq(agentRunEvents.runId, fixture.child.id), eq(agentRunEvents.eventType, "run.completed"))),
      database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode, terminationKind: agentRuns.terminationKind, terminationBudgetDimension: agentRuns.terminationBudgetDimension }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id)),
    ])).resolves.toEqual([[], [], [], [], [], [{ kind: "budget_exhausted", runId: fixture.child.id, budgetDimension: "active_duration" }], [], [], [{ status: "failed", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", terminationKind: "budget_exhausted", terminationBudgetDimension: "active_duration" }]]);
  }, 60_000);

  it("recommendation child 在最后 checkpoint 后仅 maxResults 收紧时拒绝完整冻结候选", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture({ withQualityCandidate: true, deepMatchMaxResults: 2, deepMatchMaxModelCalls: 3 });
    let narrowBudget = false;
    const originalEffectiveBudget = effectiveAgentRunBudgetModule.effectiveAgentRunBudget;
    const effectiveBudgetSpy = vi.spyOn(effectiveAgentRunBudgetModule, "effectiveAgentRunBudget").mockImplementation((workflowVersion, snapshot) => {
      const budget = originalEffectiveBudget(workflowVersion, snapshot);
      return narrowBudget && workflowVersion === "deep-match-v1" ? { ...budget, maxResults: 1 } : budget;
    });
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      if (input.runId === fixture.child.id && input.checkpointKey.endsWith(":step_create_recommendations_complete:1")) {
        expect(outcome.kind).toBe("continue");
        narrowBudget = true;
      }
      return outcome;
    } };
    const processor = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: controlled,
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    try {
      await expect(processor.process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("failed");
      await expect(Promise.all([
        database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode, terminationKind: agentRuns.terminationKind, modelCallCount: agentRuns.modelCallCount }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id)),
        database.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, fixture.child.id)),
        database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
        database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
        database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
        database.select({ kind: agentInboxItems.kind }).from(agentInboxItems).where(eq(agentInboxItems.userId, fixture.userId)),
        database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      ])).resolves.toEqual([[{ status: "failed", failureCode: "AGENT_RUN_PERSIST_FAILED", terminationKind: "persistence_failed", modelCallCount: 2 }], [expect.objectContaining({ assessment: expect.any(Object), adapterUsage: expect.any(Object) }), expect.objectContaining({ assessment: expect.any(Object), adapterUsage: expect.any(Object) })], [], [], [], [expect.objectContaining({ kind: "run_failed" })], []]);
    } finally {
      effectiveBudgetSpy.mockRestore();
    }
  }, 60_000);

  it("recommendation child 在最后 checkpoint 后真实 model_calls 超限时保留 model_calls 预算终态", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture({ withQualityCandidate: true, deepMatchMaxResults: 2, deepMatchMaxModelCalls: 3 });
    const hardBudget = DEEP_MATCH_AGENT_RUN_BUDGET as { maxModelCalls: number };
    const originalMaxModelCalls = hardBudget.maxModelCalls;
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      if (input.runId === fixture.child.id && input.checkpointKey.endsWith(":step_create_recommendations_complete:1")) {
        expect(outcome.kind).toBe("continue");
        hardBudget.maxModelCalls = 1;
      }
      return outcome;
    } };
    const processor = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: controlled,
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    try {
      await expect(processor.process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("budget_exhausted");
      await expect(Promise.all([
        database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode, terminationKind: agentRuns.terminationKind, terminationBudgetDimension: agentRuns.terminationBudgetDimension, modelCallCount: agentRuns.modelCallCount }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id)),
        database.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, fixture.child.id)),
        database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
        database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
        database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
        database.select({ kind: agentInboxItems.kind, budgetDimension: agentInboxItems.budgetDimension }).from(agentInboxItems).where(eq(agentInboxItems.userId, fixture.userId)),
        database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      ])).resolves.toEqual([[{ status: "failed", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", terminationKind: "budget_exhausted", terminationBudgetDimension: "model_calls", modelCallCount: 2 }], [expect.objectContaining({ assessment: expect.any(Object), adapterUsage: expect.any(Object) }), expect.objectContaining({ assessment: expect.any(Object), adapterUsage: expect.any(Object) })], [], [], [], [{ kind: "budget_exhausted", budgetDimension: "model_calls" }], []]);
    } finally {
      hardBudget.maxModelCalls = originalMaxModelCalls;
    }
  }, 60_000);

  it.each([
    ["profileVersion", async (_fixture: Awaited<ReturnType<typeof stageFullyQualifiedLayeredRecommendationFixture>>, triageId: string) => {
      await database.update(jobTriageVersions).set({ profileVersion: 2 }).where(eq(jobTriageVersions.id, triageId));
    }],
    ["targetId", async (fixture: Awaited<ReturnType<typeof stageFullyQualifiedLayeredRecommendationFixture>>, triageId: string) => {
      const targetId = crypto.randomUUID();
      await database.insert(jobTargets).values({ id: targetId, userId: fixture.userId, version: 1, priority: "secondary", state: "active", activeSlot: 2, createdAt: now, updatedAt: now });
      await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId: fixture.userId, targetId, version: 1, priority: "secondary", state: "active", constraints, createdAt: now });
      await database.update(jobTriageVersions).set({ targetId }).where(eq(jobTriageVersions.id, triageId));
    }],
    ["targetVersion", async (fixture: Awaited<ReturnType<typeof stageFullyQualifiedLayeredRecommendationFixture>>, triageId: string) => {
      await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId: fixture.userId, targetId: fixture.targetId, version: 2, priority: "primary", state: "active", constraints, createdAt: now });
      await database.update(jobTriageVersions).set({ targetVersion: 2 }).where(eq(jobTriageVersions.id, triageId));
    }],
    ["sourcePostingVersion", async (fixture: Awaited<ReturnType<typeof stageFullyQualifiedLayeredRecommendationFixture>>, triageId: string) => {
      const [source] = await database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.id, fixture.excludedSourcePostingVersionId!));
      const sourcePostingVersionId = crypto.randomUUID();
      await database.insert(jobSourcePostingVersions).values({ ...source!, id: sourcePostingVersionId, version: 2, contentSha256: "9".repeat(64), rawContentSha256: "8".repeat(64), createdAt: now });
      await database.update(jobTriageVersions).set({ sourcePostingVersionId }).where(eq(jobTriageVersions.id, triageId));
    }],
  ])("publisher 拒绝前段排除机会的冻结 triage %s 漂移", async (_field, mutate) => {
    const fixture = await stageFullyQualifiedLayeredRecommendationFixture({ withFrontExclusion: true });
    const [excludedTriage] = await database.select({ id: jobTriageVersions.id, opportunityId: jobTriageVersions.opportunityId }).from(jobTriageVersions)
      .where(and(eq(jobTriageVersions.userId, fixture.userId), eq(jobTriageVersions.sourcePostingVersionId, fixture.excludedSourcePostingVersionId!)));
    await mutate(fixture, excludedTriage!.id);
    await expect(fixture.commands.publishStagedRun(fixture.input)).rejects.toThrow("DEEP_MATCH_RECOMMENDATION_FACTS_INVALID");
    await expectPublicationStillUnwritten({ userId: fixture.userId, childId: fixture.child.id });
  });

  it("真实推荐非空发布保留前段排除并闭合冻结 evidence", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture({ withFrontExclusion: true });
    expect(fixture.outcome).toBe("completed");
    const triages = await database.select({ id: jobTriageVersions.id, opportunityId: jobTriageVersions.opportunityId, sourcePostingVersionId: jobTriageVersions.sourcePostingVersionId, overallVerdict: jobTriageVersions.overallVerdict }).from(jobTriageVersions).where(eq(jobTriageVersions.userId, fixture.userId));
    const excludedTriage = triages.find((triage) => triage.sourcePostingVersionId === fixture.excludedSourcePostingVersionId)!;
    expect(excludedTriage).toMatchObject({ overallVerdict: "unknown" });
    expect(fixture.child.sourceScope).toEqual(expect.objectContaining({ selectionExclusions: [{ opportunityId: excludedTriage.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }], frozenRecommendationEvidence: expect.objectContaining({ frozenTriageVersionIds: expect.arrayContaining([fixture.triage.id, excludedTriage.id]) }) }));
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    const [result] = await database.select({ itemCount: recommendationResults.itemCount, evidence: recommendationResults.evidence, recommendationListId: recommendationResults.recommendationListId }).from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id));
    const [child] = await database.select({ resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id));
    const exclusions = await database.select({ opportunityId: recommendationExclusions.opportunityId, reasonCode: recommendationExclusions.reasonCode }).from(recommendationExclusions).where(eq(recommendationExclusions.recommendationListId, result!.recommendationListId!));
    const items = await database.select().from(recommendationListItems).where(eq(recommendationListItems.recommendationListId, result!.recommendationListId!));
    expect({ itemCount: result!.itemCount, childResultCount: child!.resultCount, items }).toMatchObject({ itemCount: 1, childResultCount: 1, items: [expect.any(Object)] });
    expect(exclusions).toEqual([{ opportunityId: excludedTriage.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }]);
    expect(result!.evidence).toMatchObject({ qualification: { evaluatedCount: 2, insufficientInformationCount: 1 }, coarseRanking: { eligibleCount: 1, deepMatchCandidateCount: 1 }, deepMatching: { evaluatedCount: 1, qualityInsufficientCount: 0, finalRecommendationCount: 1 } });
  });

  it("真实推荐非空清单同时持久化前段与质量排除", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture({ withFrontExclusion: true, withQualityCandidate: true });
    const triages = await database.select({ opportunityId: jobTriageVersions.opportunityId, sourcePostingVersionId: jobTriageVersions.sourcePostingVersionId }).from(jobTriageVersions).where(eq(jobTriageVersions.userId, fixture.userId));
    const frontExcluded = triages.find((triage) => triage.sourcePostingVersionId === fixture.excludedSourcePostingVersionId)!;
    const qualityRejected = triages.find((triage) => triage.sourcePostingVersionId === fixture.qualitySourcePostingVersionId)!;
    const fake = new FakeDeepMatchAdapter();
    const adapter = { ...fake, assess: async (input: any, call: any) => fake.assess(input, { ...call, fixture: { qualityInsufficientOpportunityIds: input.candidates.filter((candidate: any) => candidate.sourcePostingVersionId === fixture.qualitySourcePostingVersionId).map((candidate: any) => candidate.opportunityId) } }) };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    const [result] = await database.select({ itemCount: recommendationResults.itemCount, recommendationListId: recommendationResults.recommendationListId, evidence: recommendationResults.evidence }).from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id));
    const [child] = await database.select({ resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id));
    const [items, exclusions, matches] = await Promise.all([
      database.select().from(recommendationListItems).where(eq(recommendationListItems.recommendationListId, result!.recommendationListId!)),
      database.select({ opportunityId: recommendationExclusions.opportunityId, reasonCode: recommendationExclusions.reasonCode }).from(recommendationExclusions).where(eq(recommendationExclusions.recommendationListId, result!.recommendationListId!)),
      database.select({ opportunityId: jobMatchVersions.opportunityId }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
    ]);
    expect({ itemCount: result!.itemCount, childResultCount: child!.resultCount, items, matches }).toMatchObject({ itemCount: 1, childResultCount: 1, items: [expect.any(Object)], matches: expect.arrayContaining([{ opportunityId: qualityRejected.opportunityId }]) });
    expect(exclusions).toEqual(expect.arrayContaining([{ opportunityId: frontExcluded.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }, { opportunityId: qualityRejected.opportunityId, reasonCode: "MATCH_QUALITY_INSUFFICIENT" }]));
    expect(result!.evidence).toMatchObject({ qualification: { evaluatedCount: 3, insufficientInformationCount: 1 }, coarseRanking: { eligibleCount: 2, deepMatchCandidateCount: 2 }, deepMatching: { evaluatedCount: 2, qualityInsufficientCount: 1, finalRecommendationCount: 1 } });
  });

  it("真实全部模型质量拒绝发布可信 no_recommendations", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    const fake = new FakeDeepMatchAdapter();
    const qualityRejectingAdapter = { ...fake, assess: async (input: any, call: any) => fake.assess(input, { ...call, fixture: { qualityInsufficientOpportunityIds: input.candidates.map((candidate: any) => candidate.opportunityId) } }) };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: qualityRejectingAdapter, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    const [result] = await database.select({ id: recommendationResults.id, kind: recommendationResults.kind, itemCount: recommendationResults.itemCount, recommendationListId: recommendationResults.recommendationListId, evidence: recommendationResults.evidence }).from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id));
    const [inbox] = await database.select({ recommendationResultId: agentInboxItems.recommendationResultId }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, fixture.userId), eq(agentInboxItems.kind, "recommendation_result")));
    await expect(Promise.all([
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
      database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
      database.select({ resultKind: firstRecommendationJourneyCompletions.resultKind, resultId: firstRecommendationJourneyCompletions.resultId }).from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      database.select({ opportunityId: jobMatchVersions.opportunityId, assessment: jobMatchVersions.assessment }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
      database.select({ status: agentRuns.status, currentStep: agentRuns.currentStep, resultCount: agentRuns.resultCount, claimToken: agentRuns.claimToken, usageComplete: agentRuns.usageComplete }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id)),
    ])).resolves.toEqual([[], [], [], [{ resultKind: "no_recommendations", resultId: result!.id }], [{ opportunityId: fixture.triage.opportunityId, assessment: expect.objectContaining({ opportunityId: fixture.triage.opportunityId, overallScore: 30 }) }], [{ status: "completed", currentStep: "completed", resultCount: 0, claimToken: null, usageComplete: true }]]);
    expect({ kind: result!.kind, itemCount: result!.itemCount, recommendationListId: result!.recommendationListId, inboxResultId: inbox!.recommendationResultId }).toEqual({ kind: "no_recommendations", itemCount: 0, recommendationListId: null, inboxResultId: result!.id });
    expect(result!.evidence).toMatchObject({ deepMatching: { evaluatedCount: 1, qualityInsufficientCount: 1, finalRecommendationCount: 0 } });
  });

  it.each([
    ["recommendation_list", "stop-first"],
    ["no_recommendations", "stop-first"],
    ["recommendation_list", "publish-first"],
    ["no_recommendations", "publish-first"],
  ] as const)("真实 recommendation child 的 %s 发布与账户停止按 %s 账户锁串行", async (kind, order) => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    const fake = new FakeDeepMatchAdapter();
    const adapter = kind === "no_recommendations"
      ? { ...fake, assess: async (input: any, call: any) => fake.assess(input, { ...call, fixture: { qualityInsufficientOpportunityIds: input.candidates.map((candidate: any) => candidate.opportunityId) } }) }
      : fake;
    const finalCheckpointEntered = deferred(); const releaseFinalCheckpoint = deferred();
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      if (input.runId === fixture.child.id && input.checkpointKey.endsWith(":step_create_recommendations_complete:1")) {
        expect(outcome.kind).toBe("continue");
        finalCheckpointEntered.resolve();
        await releaseFinalCheckpoint.promise;
      }
      return outcome;
    } };
    const stopDatabase = createDatabase(container.getConnectionUri());
    const observerDatabase = createDatabase(container.getConnectionUri());
    const releaseStop = deferred(); const stopEntered = deferred();
    const stopAuditBase = createAuditTrail({ db: stopDatabase, clock: () => now });
    const heldStopAudit = {
      append: (event: any) => stopAuditBase.append(event),
      bind(transaction: any) {
        const bound = stopAuditBase.bind(transaction);
        return { ...bound, append: async (event: any) => {
          await bound.append(event);
          if (event.eventType === "account.run_stopped") { stopEntered.resolve(); await releaseStop.promise; }
        } };
      },
      query: (input: any) => stopAuditBase.query(input),
    };
    const publicationEntered = deferred(); const releasePublication = deferred();
    const publicationAuditBase = createAuditTrail({ db: database, clock: () => now });
    const heldPublicationAudit = {
      append: (event: any) => publicationAuditBase.append(event),
      bind(transaction: any) {
        const bound = publicationAuditBase.bind(transaction);
        return { ...bound, append: async (event: any) => {
          await bound.append(event);
          if (event.eventType === "agent.run_completed") { publicationEntered.resolve(); await releasePublication.promise; }
        } };
      },
      query: (input: any) => publicationAuditBase.query(input),
    };
    const controls = createAccountRunControl({ db: stopDatabase, auditTrail: order === "stop-first" ? heldStopAudit as any : createAuditTrail({ db: stopDatabase, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const processor = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: controlled,
      contentStore: new Store(), auditTrail: order === "stop-first" ? createAuditTrail({ db: database, clock: () => now }) : heldPublicationAudit as any,
      id: () => crypto.randomUUID(), clock: () => now,
    });
    const processing = processor.process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true });
    let stop: Promise<unknown> | undefined;
    try {
      await waitForBarrier({ barrier: finalCheckpointEntered.promise, operation: processing, name: `${kind} ${order} final child checkpoint` });
      if (order === "stop-first") {
        stop = controls.control({ userId: fixture.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
        await waitForBarrier({ barrier: stopEntered.promise, operation: stop, name: `${kind} stop transaction` });
        releaseFinalCheckpoint.resolve();
        await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);
        releaseStop.resolve();
        await expect(stop).resolves.toMatchObject({ applied: true, state: { stoppedAt: expect.any(String) } });
        await expect(processing).resolves.toMatch(/^(paused|stale)$/u);
        await expect(Promise.all([
          database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
          database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
          database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
          database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
          database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
          database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, fixture.userId), eq(agentInboxItems.kind, "recommendation_result"))),
          database.select({ resultKind: firstRecommendationJourneyCompletions.resultKind }).from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
          database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, fixture.child.id), eq(agentRunEvents.eventType, "run.completed"))),
          database.select({ status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id)),
        ])).resolves.toEqual([[], [], [], [], [], [], [], [], [{ status: "paused", controlState: "none" }]]);
      } else {
        releaseFinalCheckpoint.resolve();
        await waitForBarrier({ barrier: publicationEntered.promise, operation: processing, name: `${kind} publication transaction` });
        stop = controls.control({ userId: fixture.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
        await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);
        releasePublication.resolve();
        await expect(processing).resolves.toBe("completed");
        await expect(stop).resolves.toMatchObject({ applied: true, state: { stoppedAt: expect.any(String) } });
        const [result] = await database.select({ id: recommendationResults.id, kind: recommendationResults.kind, recommendationListId: recommendationResults.recommendationListId, itemCount: recommendationResults.itemCount }).from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id));
        expect(result).toMatchObject(kind === "recommendation_list" ? { kind, recommendationListId: expect.any(String), itemCount: 1 } : { kind, recommendationListId: null, itemCount: 0 });
        await expect(createRecommendationRunQueries({ db: database }).get({ userId: fixture.userId, runId: fixture.rootRunId })).resolves.toMatchObject({
          runId: fixture.rootRunId,
          status: "completed",
          result: kind === "recommendation_list"
            ? { kind, resultId: result!.id, recommendationListId: result!.recommendationListId, itemCount: 1 }
            : { kind, resultId: result!.id },
        });
        await expect(Promise.all([
          database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
          database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
          database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
          database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, fixture.userId), eq(agentInboxItems.kind, kind === "recommendation_list" ? "recommendation_list" : "recommendation_result"))),
          database.select({ resultKind: firstRecommendationJourneyCompletions.resultKind }).from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
          database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(and(eq(agentRunEvents.runId, fixture.child.id), eq(agentRunEvents.eventType, "run.completed"))),
          database.select({ status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id)),
        ])).resolves.toEqual(kind === "recommendation_list"
          ? [[expect.any(Object)], [expect.any(Object)], [], [expect.any(Object)], [{ resultKind: kind }], [{ eventType: "run.completed" }], [{ status: "completed", controlState: "none" }]]
          : [[], [], [], [expect.any(Object)], [{ resultKind: kind }], [{ eventType: "run.completed" }], [{ status: "completed", controlState: "none" }]]);
      }
    } finally {
      releaseFinalCheckpoint.resolve();
      releasePublication.resolve();
      releaseStop.resolve();
      await Promise.allSettled([processing, ...(stop ? [stop] : [])]);
      await stopDatabase.$client.end();
      await observerDatabase.$client.end();
    }
  }, 60_000);

  it("实际 recommendation Inbox INSERT 失败时回滚全部发布事实", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    await database.execute(sql`
      create function task6_c3_fail_recommendation_inbox_insert() returns trigger language plpgsql as $$
      begin
        if new.kind in ('recommendation_list', 'recommendation_result') then
          raise exception 'TASK6_C3_RECOMMENDATION_INBOX_INSERT_FAILED';
        end if;
        return new;
      end;
      $$
    `);
    await database.execute(sql`
      create trigger task6_c3_fail_recommendation_inbox_insert
      before insert on agent_inbox_items
      for each row execute function task6_c3_fail_recommendation_inbox_insert()
    `);
    try {
      await expect(createAgentRunProcessor({
        db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(),
        contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
      }).process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("failed");
      await expect(Promise.all([
        database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
        database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
        database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
        database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
        database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
        database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, fixture.userId), eq(agentInboxItems.kind, "recommendation_list"))),
        database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
        database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, fixture.child.id), eq(agentRunEvents.eventType, "run.completed"))),
        database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, fixture.child.id)),
      ])).resolves.toEqual([[], [], [], [], [], [], [], [], [{ status: "failed", failureCode: "AGENT_RUN_PERSIST_FAILED", terminationKind: "persistence_failed" }]]);
    } finally {
      await database.execute(sql`drop trigger if exists task6_c3_fail_recommendation_inbox_insert on agent_inbox_items`);
      await database.execute(sql`drop function if exists task6_c3_fail_recommendation_inbox_insert()`);
    }
  }, 60_000);

  it("recommendation child 模型重试后只发布一次完整结果事实", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    const ownerBoundSideFacts = () => Promise.all([
      database.select({ id: jobProfiles.id, version: jobProfiles.version, createdAt: jobProfiles.createdAt, updatedAt: jobProfiles.updatedAt }).from(jobProfiles).where(and(eq(jobProfiles.userId, fixture.userId), eq(jobProfiles.id, fixture.profileId))),
      database.select({ id: profileFacts.id, profileId: profileFacts.profileId, factType: profileFacts.factType, createdAt: profileFacts.createdAt }).from(profileFacts).where(eq(profileFacts.userId, fixture.userId)),
      database.select({ id: profileFactRevisions.id, profileFactId: profileFactRevisions.profileFactId, revisionNumber: profileFactRevisions.revisionNumber, profileVersion: profileFactRevisions.profileVersion, state: profileFactRevisions.state, factValue: profileFactRevisions.factValue }).from(profileFactRevisions).where(eq(profileFactRevisions.userId, fixture.userId)),
      database.select({ id: jobTargets.id, version: jobTargets.version, state: jobTargets.state, priority: jobTargets.priority, updatedAt: jobTargets.updatedAt }).from(jobTargets).where(and(eq(jobTargets.userId, fixture.userId), eq(jobTargets.id, fixture.targetId))),
      database.select({ id: jobTargetRevisions.id, targetId: jobTargetRevisions.targetId, version: jobTargetRevisions.version, state: jobTargetRevisions.state, priority: jobTargetRevisions.priority, constraints: jobTargetRevisions.constraints }).from(jobTargetRevisions).where(and(eq(jobTargetRevisions.userId, fixture.userId), eq(jobTargetRevisions.targetId, fixture.targetId))),
    ]);
    const sideFactsBefore = await ownerBoundSideFacts();
    expect(sideFactsBefore.map((facts) => facts.length)).toEqual([1, 4, 4, 1, 1]);
    const fake = new FakeDeepMatchAdapter();
    let modelCalls = 0;
    const processor = () => createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, checkpoint: checkpoint(), contentStore: new Store(),
      deepMatchAdapter: { ...fake, assess: async (...args: Parameters<FakeDeepMatchAdapter["assess"]>) => {
        modelCalls += 1;
        if (modelCalls === 1) throw new DeepMatchAdapterError("retryable");
        return fake.assess(...args);
      } },
      auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor().process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: false })).resolves.toBe("retry");
    await expect(processor().process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    expect(modelCalls).toBe(2);
    await expect(ownerBoundSideFacts()).resolves.toEqual(sideFactsBefore);
    await expect(Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
      database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
      database.select().from(agentInboxItems).where(and(eq(agentInboxItems.userId, fixture.userId), eq(agentInboxItems.kind, "recommendation_list"))),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, fixture.child.id), eq(agentRunEvents.eventType, "run.completed"))),
      database.select().from(auditEvents).where(and(eq(auditEvents.resourceId, fixture.child.id), eq(auditEvents.eventType, "agent.run_completed"))),
    ])).resolves.toEqual([[expect.any(Object)], [expect.any(Object)], [expect.any(Object)], [], [expect.any(Object)], [expect.any(Object)], [expect.any(Object)], [expect.any(Object)], [expect.any(Object)]]);
  }, 60_000);

  it.each(["recommendation_list", "no_recommendations"] as const)("已完成 recommendation child 的 %s direct replay 只读取原结果", async (kind) => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    const fake = new FakeDeepMatchAdapter();
    const initialAdapter = kind === "no_recommendations"
      ? { ...fake, assess: async (input: any, call: any) => fake.assess(input, { ...call, fixture: { qualityInsufficientOpportunityIds: input.candidates.map((candidate: any) => candidate.opportunityId) } }) }
      : fake;
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: initialAdapter, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    const [stored] = await database.select({ id: recommendationResults.id, kind: recommendationResults.kind, recommendationListId: recommendationResults.recommendationListId, itemCount: recommendationResults.itemCount, evidence: recommendationResults.evidence }).from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id));
    const before = await Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
      database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.userId, fixture.userId)),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, fixture.child.id)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, fixture.child.id)),
    ]);
    const replayCommands = createDeepMatchCommands({ db: database, id: () => crypto.randomUUID(), clock: () => now, adapter: { ...fake, assess: async () => { throw new Error("REPLAY_MUST_NOT_CALL_MODEL"); } } });
    const replayed = await replayCommands.publishStagedRun({
      userId: fixture.userId, targetId: fixture.targetId, runId: fixture.child.id, fence: { claimToken: crypto.randomUUID() }, selectionExclusions: [], ruleConfig: { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
      recommendation: { rootRunId: fixture.rootRunId }, onPublished: async () => { throw new Error("REPLAY_MUST_NOT_CALLBACK"); },
    });
    expect(replayed).toMatchObject(kind === "recommendation_list"
      ? { kind, resultId: stored!.id, recommendationListId: stored!.recommendationListId, evidence: stored!.evidence }
      : { kind, resultId: stored!.id, evidence: stored!.evidence });
    await expect(Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId)),
      database.select().from(recommendationExclusions).where(eq(recommendationExclusions.userId, fixture.userId)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.userId, fixture.userId)),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, fixture.child.id)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, fixture.child.id)),
    ])).resolves.toEqual(before);
  }, 60_000);

  it.each(["root", "target", "producer"] as const)("recommendation direct replay 的不同 %s 绑定明确冲突", async (conflict) => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    const replayCommands = createDeepMatchCommands({ db: database, id: () => crypto.randomUUID(), clock: () => now, adapter: { ...new FakeDeepMatchAdapter(), assess: async () => { throw new Error("CONFLICT_REPLAY_MUST_NOT_CALL_MODEL"); } } });
    const resultCountBefore = await database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id));
    await expect(replayCommands.publishStagedRun({
      userId: fixture.userId,
      targetId: conflict === "target" ? crypto.randomUUID() : fixture.targetId,
      runId: conflict === "producer" ? crypto.randomUUID() : fixture.child.id,
      fence: { claimToken: crypto.randomUUID() }, selectionExclusions: [], ruleConfig: { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
      recommendation: { rootRunId: conflict === "root" ? crypto.randomUUID() : fixture.rootRunId }, onPublished: async () => { throw new Error("CONFLICT_REPLAY_MUST_NOT_CALLBACK"); },
    })).rejects.toThrow("DEEP_MATCH_RECOMMENDATION_FACTS_INVALID");
    await expect(database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id))).resolves.toEqual(resultCountBefore);
  }, 60_000);

  it("已完成 recommendation worker 重投不重新 claim、调用模型或写发布事实", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    let modelCalls = 0;
    const fake = new FakeDeepMatchAdapter();
    const adapter = { ...fake, assess: async (...args: Parameters<FakeDeepMatchAdapter["assess"]>) => { modelCalls += 1; return fake.assess(...args); } };
    const processor = () => createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor().process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    const before = await Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.userId, fixture.userId)),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, fixture.child.id)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, fixture.child.id)),
    ]);
    await expect(processor().process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("stale");
    expect(modelCalls).toBe(1);
    await expect(Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, fixture.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, fixture.userId)),
      database.select().from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.userId, fixture.userId)),
      database.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, fixture.userId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, fixture.child.id)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, fixture.child.id)),
    ])).resolves.toEqual(before);
  }, 60_000);

  it("账户停止后 recommendation direct replay 仍返回已提交的原结果", async () => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    const [stored] = await database.select({ id: recommendationResults.id, kind: recommendationResults.kind }).from(recommendationResults).where(eq(recommendationResults.producerRunId, fixture.child.id));
    await createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .control({ userId: fixture.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    const hardBudget = DEEP_MATCH_AGENT_RUN_BUDGET as { maxResults: number };
    const originalMaxResults = hardBudget.maxResults;
    hardBudget.maxResults = 0;
    try {
      const replayed = await createDeepMatchCommands({ db: database, id: () => crypto.randomUUID(), clock: () => now, adapter: { ...new FakeDeepMatchAdapter(), assess: async () => { throw new Error("STOP_REPLAY_MUST_NOT_CALL_MODEL"); } } }).publishStagedRun({
        userId: fixture.userId, targetId: fixture.targetId, runId: fixture.child.id, fence: { claimToken: "" }, selectionExclusions: [], ruleConfig: { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
        recommendation: { rootRunId: fixture.rootRunId }, onPublished: async () => { throw new Error("STOP_REPLAY_MUST_NOT_CALLBACK"); },
      });
      expect(replayed).toMatchObject({ kind: stored!.kind, resultId: stored!.id });
    } finally {
      hardBudget.maxResults = originalMaxResults;
    }
  }, 60_000);

  it("同 owner 的第二个合法 recommendation result 不覆盖首次 journey completion", async () => {
    const first = await createFullyQualifiedLayeredRecommendationFixture();
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: first.userId, runId: first.child.id, finalAttempt: true })).resolves.toBe("completed");
    const [firstJourney] = await database.select({ resultId: firstRecommendationJourneyCompletions.resultId }).from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, first.userId));
    await database.update(jobTargets).set({ state: "inactive", updatedAt: now }).where(eq(jobTargets.id, first.targetId));
    const second = await createFullyQualifiedLayeredRecommendationFixture({ ownerUserId: first.userId });
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: second.userId, runId: second.child.id, finalAttempt: true })).resolves.toBe("completed");
    const [secondResult] = await database.select({ id: recommendationResults.id }).from(recommendationResults).where(eq(recommendationResults.producerRunId, second.child.id));
    expect(secondResult!.id).not.toBe(firstJourney!.resultId);
    await expect(database.select({ resultId: firstRecommendationJourneyCompletions.resultId }).from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, first.userId))).resolves.toEqual([firstJourney]);
  }, 60_000);

  it.each(["staging assessment", "bound match projection"] as const)("recommendation direct replay 拒绝漂移的 %s", async (drift) => {
    const fixture = await createFullyQualifiedLayeredRecommendationFixture();
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: new FakeDeepMatchAdapter(), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: fixture.userId, runId: fixture.child.id, finalAttempt: true })).resolves.toBe("completed");
    if (drift === "staging assessment") {
      const [staged] = await database.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, fixture.child.id));
      const assessment = structuredClone(staged!.assessment as { overallScore: number });
      assessment.overallScore = assessment.overallScore === 99 ? 98 : 99;
      await database.update(deepMatchRunCandidates).set({ assessment }).where(eq(deepMatchRunCandidates.id, staged!.id));
    } else {
      const [item] = await database.select({ matchVersionId: recommendationListItems.matchVersionId }).from(recommendationListItems).where(eq(recommendationListItems.userId, fixture.userId));
      await database.update(jobMatchVersions).set({ overallScore: 0, displayBand: "consider_carefully" }).where(eq(jobMatchVersions.id, item!.matchVersionId));
    }
    await expect(createDeepMatchCommands({ db: database, id: () => crypto.randomUUID(), clock: () => now }).publishStagedRun({
      userId: fixture.userId, targetId: fixture.targetId, runId: fixture.child.id, fence: { claimToken: "" }, selectionExclusions: [], ruleConfig: { minimumOverallScore: 0, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
      recommendation: { rootRunId: fixture.rootRunId }, onPublished: async () => { throw new Error("DRIFT_REPLAY_MUST_NOT_CALLBACK"); },
    })).rejects.toThrow("DEEP_MATCH_RECOMMENDATION_FACTS_INVALID");
  }, 60_000);

  it.each(["fake", "greenhouse"] as const)("%s recommendation 根以真实非空 discovery metadata 创建保守 child", async (executionMode) => {
    const userId = crypto.randomUUID(); const targetId = crypto.randomUUID(); const profileId = crypto.randomUUID(); const factId = crypto.randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: crypto.randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    await createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).addItem({ userId, targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, canonicalCompanyName: "Metadata Co", careersUrl: "https://boards.greenhouse.io/metadata", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    const fingerprint = crypto.randomUUID();
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    const preflight = createRunPreflightEvaluator({ capabilityAdapter: { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring"] }) }, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: executionMode, id: () => crypto.randomUUID(), clock: () => now });
    const service = createRecommendationRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), runPreflight: preflight, executionMode, id: () => crypto.randomUUID(), clock: () => now });
    const preparation = await preflight.evaluate(database, { userId, workflow: "recommendation", trigger: "manual" });
    const started = await service.start({ userId, requestId: crypto.randomUUID(), command: { idempotencyKey: crypto.randomUUID(), warningFingerprint: preparation.report.warningFingerprint } });
    const sourceId = executionMode === "fake" ? "fake:aurora-careers" : "greenhouse:metadata";
    const detail = { sourceId, detailId: "1", company: "Metadata Co", title: "AI Engineer", location: "上海", postedAt: now.toISOString(), deadline: null, sourceType: "company_careers" as const, isOfficial: true as const, rawPayload: {} };
    const summary = { sourceId: detail.sourceId, detailId: detail.detailId, company: detail.company, title: detail.title, location: detail.location, postedAt: detail.postedAt, deadline: detail.deadline };
    const calls: string[] = [];
    const adapter: JobDiscoveryAdapter = { adapter: executionMode, adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: executionMode, adapterVersion: "test", contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }), search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }), searchBatch: async (input: any) => { calls.push("searchBatch"); return { ok: true, data: executionMode === "fake" ? { items: [summary], sourceReceipts: input.sourceScope.sources.map((receiptSourceId: string) => ({ sourceId: receiptSourceId, checked: true as const, candidateCount: receiptSourceId === sourceId ? 1 : 0 })) } : [summary] }; }, getDetail: async () => { calls.push("getDetail"); return { ok: true, data: detail }; } };
    const sourceHealthAdapter: SourceHealthDiscoveryAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async ({ source }: { source: { sourceId: string } }) => { calls.push("listSource"); return { ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: [detail.detailId], candidates: [{ sourceId: source.sourceId, detailId: detail.detailId, company: null, title: detail.title, location: detail.location }] } }; },
      getSourceDetail: async ({ source }: { source: { sourceId: string; boardToken: string } }) => { calls.push("getSourceDetail"); return { ok: true as const, attemptCount: 1, data: { ...detail, sourceId: source.sourceId, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/${detail.detailId}` } }; },
    };
    const [rootBeforeCompletion] = await database.select({ sourceScope: agentRuns.sourceScope, recommendationContext: agentRuns.recommendationContext }).from(agentRuns).where(eq(agentRuns.id, started.run.runId));
    const childClock = () => new Date(now.getTime() + 1);
    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), ...(executionMode === "greenhouse" ? { sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter } } : {}), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: childClock }), id: () => crypto.randomUUID(), clock: childClock }).process({ version: 1, userId, runId: started.run.runId, finalAttempt: true });
    const [rootTerminal] = await database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode }).from(agentRuns).where(eq(agentRuns.id, started.run.runId));
    expect({ outcome, rootTerminal, calls }).toEqual({ outcome: "completed", rootTerminal: { status: "completed", failureCode: null }, calls: executionMode === "fake" ? ["searchBatch", "getDetail"] : ["listSource", "getSourceDetail"] });
    const [triage] = await database.select({ id: jobTriageVersions.id, opportunityId: jobTriageVersions.opportunityId, sourcePostingVersionId: jobTriageVersions.sourcePostingVersionId, userId: jobTriageVersions.userId, profileId: jobTriageVersions.profileId, profileVersion: jobTriageVersions.profileVersion, targetId: jobTriageVersions.targetId, targetVersion: jobTriageVersions.targetVersion, overallVerdict: jobTriageVersions.overallVerdict }).from(jobTriageVersions).where(eq(jobTriageVersions.userId, userId));
    expect(triage).toMatchObject({ userId, profileId, profileVersion: 1, targetId, targetVersion: 1, overallVerdict: "unknown" });
    const [rootAfterCompletion] = await database.select({ sourceScope: agentRuns.sourceScope, recommendationContext: agentRuns.recommendationContext }).from(agentRuns).where(eq(agentRuns.id, started.run.runId));
    const [child] = await database.select({ id: agentRuns.id, parentRunId: agentRuns.parentRunId, sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.parentRunId, started.run.runId));
    expect(rootAfterCompletion).toEqual(rootBeforeCompletion);
    const evidence = (child!.sourceScope as any).frozenRecommendationEvidence;
    expect({ parentRunId: child!.parentRunId, evidence }).toMatchObject({ parentRunId: started.run.runId, evidence: { frozenTriageVersionIds: [triage!.id], discoveryFacts: { trusted: expect.arrayContaining([expect.objectContaining({ sourceId, checked: true, outcome: "credible_results", losses: [] })]) } } });
    const queries = createAgentRunQueries({ db: database });
    const detailProjection = await queries.get({ userId, runId: child!.id });
    const latestProjection = await queries.latest({ userId });
    expect(AgentRunDetailSchema.safeParse(detailProjection).success).toBe(true);
    expect(AgentRunDetailSchema.safeParse(latestProjection.run).success).toBe(true);
    expect(latestProjection.run?.runId).toBe(child!.id);
    expect(JSON.stringify({ detailProjection, latestProjection })).not.toContain("frozenRecommendationEvidence");
    const controlProjection = await createAgentRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) }).control({ userId, requestId: crypto.randomUUID(), runId: child!.id, command: { commandId: crypto.randomUUID(), action: "pause" } });
    expect(ControlAgentRunResponseSchema.safeParse(controlProjection).success).toBe(true);
    expect(JSON.stringify(controlProjection)).not.toContain("frozenRecommendationEvidence");
    const afterControlProjection = await queries.get({ userId, runId: child!.id });
    expect(AgentRunDetailSchema.safeParse(afterControlProjection).success).toBe(true);
    expect(JSON.stringify(afterControlProjection)).not.toContain("frozenRecommendationEvidence");
    await expect(database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, child!.id))).resolves.toEqual([{ sourceScope: child!.sourceScope }]);
  });

  it("历史运行缺少账户策略引用时，detail 与 latest 保持 null 而不伪造新修订", async () => {
    const job = await run();
    await database.update(agentRuns).set({ accountPolicyRevisionNumber: null, accountPolicySnapshot: null }).where(eq(agentRuns.id, job.runId));
    const queries = createAgentRunQueries({ db: database });
    await expect(queries.get(job)).resolves.toMatchObject({ accountPolicyRevisionNumber: null });
    await expect(queries.latest({ userId: job.userId })).resolves.toMatchObject({ run: { runId: job.runId, accountPolicyRevisionNumber: null } });
  });

  it("数据库拒绝半个策略引用和跨修订引用，同时允许历史双空引用", async () => {
    const job = await run();
    const [stored] = await database.select({ snapshot: agentRuns.accountPolicySnapshot }).from(agentRuns).where(eq(agentRuns.id, job.runId));
    await expect(database.update(agentRuns).set({ accountPolicySnapshot: null }).where(eq(agentRuns.id, job.runId))).rejects.toMatchObject({ cause: { constraint_name: "agent_runs_policy_columns_paired" } });
    await expect(database.update(agentRuns).set({ accountPolicyRevisionNumber: 999, accountPolicySnapshot: stored!.snapshot }).where(eq(agentRuns.id, job.runId))).rejects.toMatchObject({ cause: { constraint_name: "agent_runs_policy_owner_revision_fk" } });
    await expect(database.update(agentRuns).set({ accountPolicyRevisionNumber: null, accountPolicySnapshot: null }).where(eq(agentRuns.id, job.runId))).resolves.toBeDefined();
  });

  it("deep-match child 安全解析 RULE_EXCLUDED 冻结事实且不调用模型", async () => {
    const job = await deepMatchRun();
    const [run] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, job.runId));
    await database.delete(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, job.runId));
    await database.update(agentRuns).set({ sourceScope: { ...(run!.sourceScope as object), selectionExclusions: [{ opportunityId: job.opportunityIds[0]!, reasonCode: "RULE_EXCLUDED" }] } }).where(eq(agentRuns.id, job.runId));
    let modelCalls = 0;
    const fake = new FakeDeepMatchAdapter();
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: { ...fake, assess: async (...args) => { modelCalls += 1; return fake.assess(...args); } }, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(modelCalls).toBe(0);
  });

  it("maxAttempts 为一时，首次可重试失败后不会再次调用来源", async () => {
    const job = await run({ maxAttempts: 1 });
    let searches = 0;
    const adapter: JobDiscoveryAdapter = {
      adapter: "fake", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "fake", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => { searches += 1; return { ok: false, error: { code: "TEMPORARY", retryable: true } }; },
      getDetail: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
    };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    expect(searches).toBe(1);
  });

  it("恢复运行只使用剩余 active-duration，阻塞来源调用在累计额度耗尽时终止", async () => {
    const job = await run();
    await database.update(agentRuns).set({ activeDurationMs: 59_000 }).where(eq(agentRuns.id, job.runId));
    let searches = 0;
    const adapter: JobDiscoveryAdapter = {
      adapter: "fake", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "fake", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => { searches += 1; await new Promise((resolve) => setTimeout(resolve, 1_500)); return { ok: true as const, data: [] }; },
      getDetail: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
    };
    const clock = () => new Date();
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), checkpoint: createAgentRunCheckpoint({ db: database, auditTrail: createAuditTrail({ db: database, clock }), id: () => crypto.randomUUID(), clock }), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock }), id: () => crypto.randomUUID(), clock });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    expect(searches).toBe(1);
    await expect(database.select({ status: agentRuns.status, terminationBudgetDimension: agentRuns.terminationBudgetDimension }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: "failed", terminationBudgetDimension: "active_duration" }]);
  });

  it("matching recovery reuses staged frozen candidates and settles actual usage exactly once per candidate", async () => {
    const job = await deepMatchRun();
    const calls = new Map<string, number>();
    const fake = new FakeDeepMatchAdapter();
    const adapter = {
      ...fake,
      reservedUsage: { inputTokens: 999, outputTokens: 999 },
      async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
        const opportunityId = input.candidates[0]!.opportunityId;
        calls.set(opportunityId, (calls.get(opportunityId) ?? 0) + 1);
        if (opportunityId === job.opportunityIds[1] && calls.get(opportunityId) === 1) throw new DeepMatchAdapterError("retryable");
        const result = await fake.assess(input, call);
        return { ...result, usage: { inputTokens: opportunityId === job.opportunityIds[0] ? 7 : 13, outputTokens: opportunityId === job.opportunityIds[0] ? 11 : 17, latencyMs: opportunityId === job.opportunityIds[0] ? 19 : 23 } };
      },
    };
    const processor = () => createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("deep-match must not resolve discovery adapter"); } }, deepMatchAdapter: adapter,
      checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    await expect(processor().process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("retry");
    await expect(database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId))).resolves.toHaveLength(0);
    await expect(processor().process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");

    expect(calls).toEqual(new Map([[job.opportunityIds[0]!, 1], [job.opportunityIds[1]!, 2]]));
    await expect(Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, job.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, job.userId)),
      database.select({ category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount, usageKey: agentRunUsageEntries.usageKey }).from(agentRunUsageEntries).where(eq(agentRunUsageEntries.runId, job.runId)),
      database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(eq(agentRunEvents.runId, job.runId)),
      database.select({ eventType: auditEvents.eventType }).from(auditEvents).where(eq(auditEvents.resourceId, job.runId)),
    ])).resolves.toEqual([
      [expect.any(Object), expect.any(Object)], [expect.any(Object)], [expect.any(Object), expect.any(Object)],
      expect.arrayContaining([
        { category: "model_call", amount: 1, usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:1` },
        { category: "input_tokens", amount: 7, usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:1` },
        { category: "output_tokens", amount: 11, usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:1` },
        { category: "model_call", amount: 1, usageKey: `deep_match_model:${job.opportunityIds[1]}:attempt:2` },
        { category: "input_tokens", amount: 13, usageKey: `deep_match_model:${job.opportunityIds[1]}:attempt:2` },
        { category: "output_tokens", amount: 17, usageKey: `deep_match_model:${job.opportunityIds[1]}:attempt:2` },
      ]),
      expect.arrayContaining([{ eventType: "run.completed" }]), expect.arrayContaining([{ eventType: "agent.run_completed" }]),
    ]);
    await expect(database.select({ modelCalls: agentRuns.modelCallCount, inputTokens: agentRuns.inputTokenCount, outputTokens: agentRuns.outputTokenCount, totalTokens: agentRuns.totalTokenCount }).from(agentRuns).where(eq(agentRuns.id, job.runId)))
      .resolves.toEqual([{ modelCalls: 2, inputTokens: 20, outputTokens: 28, totalTokens: 48 }]);
    await expect(database.select({ adapterUsage: deepMatchRunCandidates.adapterUsage }).from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, job.runId)).orderBy(deepMatchRunCandidates.ordinal))
      .resolves.toEqual([{ adapterUsage: { inputTokens: 7, outputTokens: 11, latencyMs: 19 } }, { adapterUsage: { inputTokens: 13, outputTokens: 17, latencyMs: 23 } }]);
  });

  it("自动深度匹配冻结低策略候选并只发布允许数量的模型结果", async () => {
    const job = await deepMatchRun({ maxCandidates: 1 });
    let calls = 0;
    const fake = new FakeDeepMatchAdapter();
    const adapter = { ...fake, async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) { calls += 1; return fake.assess(input, call); } };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(calls).toBe(1);
    await expect(database.select({ revision: agentRuns.accountPolicyRevisionNumber, resultCount: agentRuns.resultCount, modelCalls: agentRuns.modelCallCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ revision: 1, resultCount: 1, modelCalls: 1 }]);
    await expect(database.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, job.runId))).resolves.toHaveLength(1);
  });

  it("收紧既有深度匹配预算后只发布允许候选，并记录其余 CANDIDATE_LIMIT", async () => {
    const job = await deepMatchRun();
    await database.update(agentRuns).set({ budgetSnapshot: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 0, maxResults: 1, maxModelCalls: 1, maxTokens: 20_000 } }).where(eq(agentRuns.id, job.runId));
    let calls = 0;
    const fake = new FakeDeepMatchAdapter();
    const adapter = { ...fake, async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) { calls += 1; return fake.assess(input, call); } };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(calls).toBe(1);
    await expect(database.select({ resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ resultCount: 1 }]);
    await expect(createDeepMatchQueries({ db: database }).getLatestList({ userId: job.userId, targetId: job.targetId })).resolves.toMatchObject({ exclusions: expect.arrayContaining([expect.objectContaining({ opportunityId: job.opportunityIds[1], reasonCode: "CANDIDATE_LIMIT" })]) });
  });

  it("handoff after a successful usage checkpoint leaves the old output unstaged and lets the replacement publish", async () => {
    const job = await deepMatchRun();
    let instant = now;
    const oldFake = new FakeDeepMatchAdapter();
    const oldAdapter = {
      ...oldFake,
      async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
        const result = await oldFake.assess(input, { ...call, fixture: { overallScoresByOpportunityId: { [job.opportunityIds[0]!]: 41 } } });
        return { ...result, usage: { inputTokens: 5, outputTokens: 7, latencyMs: 11 } };
      },
    };
    const replacementFake = new FakeDeepMatchAdapter();
    const replacementAdapter = {
      ...replacementFake,
      async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
        const opportunityId = input.candidates[0]!.opportunityId;
        const result = await replacementFake.assess(input, { ...call, fixture: { overallScoresByOpportunityId: { [opportunityId]: opportunityId === job.opportunityIds[0] ? 81 : 82 } } });
        return { ...result, usage: { inputTokens: 13, outputTokens: 17, latencyMs: 23 } };
      },
    };
    const makeProcessor = (deepMatchAdapter: typeof oldAdapter) => createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter,
      checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant,
    });

    const durable = checkpoint();
    let handedOff = false;
    const handoffAfterUsageCheckpoint: AgentRunCheckpoint = { check: async (input) => {
      const result = await durable.check(input);
      if (!handedOff && input.checkpointKey === `deep_match_model:${job.opportunityIds[0]}:attempt:1` && result.kind === "continue") {
        handedOff = true;
        await database.update(agentRuns).set({ claimToken: crypto.randomUUID(), claimExpiresAt: new Date(instant.getTime() + 30_000) }).where(eq(agentRuns.id, job.runId));
      }
      return result;
    } };
    const old = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: oldAdapter,
      checkpoint: handoffAfterUsageCheckpoint, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant,
    }).process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    await expect(old).resolves.toBe("stale");
    expect(handedOff).toBe(true);
    await expect(database.select({ assessment: deepMatchRunCandidates.assessment }).from(deepMatchRunCandidates)
      .where(and(eq(deepMatchRunCandidates.runId, job.runId), eq(deepMatchRunCandidates.opportunityId, job.opportunityIds[0]!))))
      .resolves.toEqual([{ assessment: null }]);

    instant = new Date(now.getTime() + 30_001);
    await expect(makeProcessor(replacementAdapter).process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");

    const [beforeLateResult] = await database.select({ status: agentRuns.status, attemptCount: agentRuns.attemptCount, modelCallCount: agentRuns.modelCallCount, inputTokenCount: agentRuns.inputTokenCount, outputTokenCount: agentRuns.outputTokenCount, totalTokenCount: agentRuns.totalTokenCount })
      .from(agentRuns).where(eq(agentRuns.id, job.runId));
    const eventsBeforeLateResult = await database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(eq(agentRunEvents.runId, job.runId));
    const auditsBeforeLateResult = await database.select({ eventType: auditEvents.eventType }).from(auditEvents).where(eq(auditEvents.resourceId, job.runId));

    const [runAfterLateResult, candidatesAfterLateResult, matchesAfterLateResult, listsAfterLateResult, listItemsAfterLateResult, usageAfterLateResult, eventsAfterLateResult, auditsAfterLateResult] = await Promise.all([
      database.select({ status: agentRuns.status, attemptCount: agentRuns.attemptCount, modelCallCount: agentRuns.modelCallCount, inputTokenCount: agentRuns.inputTokenCount, outputTokenCount: agentRuns.outputTokenCount, totalTokenCount: agentRuns.totalTokenCount }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
      database.select({ opportunityId: deepMatchRunCandidates.opportunityId, assessment: deepMatchRunCandidates.assessment, adapterUsage: deepMatchRunCandidates.adapterUsage }).from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, job.runId)).orderBy(deepMatchRunCandidates.ordinal),
      database.select({ assessment: jobMatchVersions.assessment }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, job.userId)).orderBy(jobMatchVersions.createdAt),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId)),
      database.select().from(recommendationListItems).where(eq(recommendationListItems.userId, job.userId)),
      database.select({ usageKey: agentRunUsageEntries.usageKey, category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount, attemptCount: agentRunUsageEntries.attemptCount }).from(agentRunUsageEntries).where(eq(agentRunUsageEntries.runId, job.runId)).orderBy(agentRunUsageEntries.usageKey, agentRunUsageEntries.category),
      database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(eq(agentRunEvents.runId, job.runId)),
      database.select({ eventType: auditEvents.eventType }).from(auditEvents).where(eq(auditEvents.resourceId, job.runId)),
    ]);
    expect(runAfterLateResult).toEqual([beforeLateResult]);
    expect(candidatesAfterLateResult).toEqual([
      { opportunityId: job.opportunityIds[0], assessment: expect.objectContaining({ overallScore: 81 }), adapterUsage: { inputTokens: 13, outputTokens: 17, latencyMs: 23 } },
      { opportunityId: job.opportunityIds[1], assessment: expect.objectContaining({ overallScore: 82 }), adapterUsage: { inputTokens: 13, outputTokens: 17, latencyMs: 23 } },
    ]);
    expect(matchesAfterLateResult.map(({ assessment }) => (assessment as { overallScore: number }).overallScore).sort()).toEqual([81, 82]);
    expect(listsAfterLateResult).toHaveLength(1);
    expect(listItemsAfterLateResult).toHaveLength(2);
    const modelUsageAfterLateResult = usageAfterLateResult.filter(({ category }) => category !== "active_duration");
    expect(modelUsageAfterLateResult).toHaveLength(9);
    expect(modelUsageAfterLateResult).toEqual(expect.arrayContaining([
        { usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:1`, category: "input_tokens", amount: 5, attemptCount: 1 },
        { usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:1`, category: "model_call", amount: 1, attemptCount: 1 },
        { usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:1`, category: "output_tokens", amount: 7, attemptCount: 1 },
        { usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:2`, category: "input_tokens", amount: 13, attemptCount: 2 },
        { usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:2`, category: "model_call", amount: 1, attemptCount: 2 },
        { usageKey: `deep_match_model:${job.opportunityIds[0]}:attempt:2`, category: "output_tokens", amount: 17, attemptCount: 2 },
        { usageKey: `deep_match_model:${job.opportunityIds[1]}:attempt:2`, category: "input_tokens", amount: 13, attemptCount: 2 },
        { usageKey: `deep_match_model:${job.opportunityIds[1]}:attempt:2`, category: "model_call", amount: 1, attemptCount: 2 },
        { usageKey: `deep_match_model:${job.opportunityIds[1]}:attempt:2`, category: "output_tokens", amount: 17, attemptCount: 2 },
    ]));
    expect(eventsAfterLateResult).toEqual(eventsBeforeLateResult);
    expect(auditsAfterLateResult).toEqual(auditsBeforeLateResult);
    expect(beforeLateResult).toEqual({ status: "completed", attemptCount: 2, modelCallCount: 3, inputTokenCount: 31, outputTokenCount: 41, totalTokenCount: 72 });
    expect(eventsBeforeLateResult.filter(({ eventType }) => eventType === "run.completed")).toHaveLength(1);
    expect(auditsBeforeLateResult.filter(({ eventType }) => eventType === "agent.run_completed")).toHaveLength(1);
  });

  it("publishes fully staged candidates at the token ceiling without another adapter call, while an unstaged run exhausts before calling", async () => {
    const stagedJob = await deepMatchRun();
    const seed = new FakeDeepMatchAdapter();
    const commands = createDeepMatchCommands({ db: database, id: () => crypto.randomUUID(), clock: () => now, adapter: seed });
    const stageClaimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "assess_matches", startedAt: now, activeSliceStartedAt: now, attemptCount: 1, claimToken: stageClaimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" })
      .where(eq(agentRuns.id, stagedJob.runId));
    for (const candidate of await createDeepMatchQueries({ db: database }).getFrozenCandidates({ userId: stagedJob.userId, runId: stagedJob.runId })) {
      const value = await commands.invokeAndValidate({ userId: stagedJob.userId, runId: stagedJob.runId, candidate, modelCall: { signal: new AbortController().signal, usageKey: crypto.randomUUID(), budget: { maxTokens: 20_000, reservedInputTokens: 32, reservedOutputTokens: 48 } } });
      await commands.stageValidatedAssessment({ userId: stagedJob.userId, runId: stagedJob.runId, claimToken: stageClaimToken, candidate, assessment: value.assessment, usage: value.usage });
    }
    await database.update(agentRuns).set({ totalTokenCount: 19_999, inputTokenCount: 19_999, claimExpiresAt: new Date(now.getTime() - 1) }).where(eq(agentRuns.id, stagedJob.runId));
    let stagedCalls = 0;
    const noCall = { ...seed, assess: async () => { stagedCalls += 1; throw new Error("ADAPTER_MUST_NOT_RUN"); } };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: noCall, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, userId: stagedJob.userId, runId: stagedJob.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(stagedCalls).toBe(0);

    const unstagedJob = await deepMatchRun(); let unstagedCalls = 0;
    await database.update(agentRuns).set({ totalTokenCount: 19_999, inputTokenCount: 19_999 }).where(eq(agentRuns.id, unstagedJob.runId));
    const counting = { ...seed, assess: async () => { unstagedCalls += 1; return seed.assess as never; } };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: counting, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, userId: unstagedJob.userId, runId: unstagedJob.runId, finalAttempt: true })).resolves.toBe("budget_exhausted");
    expect(unstagedCalls).toBe(0);
  });

  it.each([
    ["pause", "paused"], ["cancel", "cancelled"], ["budget", "budget_exhausted"], ["claim loss", "stale"],
  ] as const)("matching stops before the second frozen candidate on %s", async (mode, expected) => {
    const job = await deepMatchRun(); const calls: string[] = []; const fake = new FakeDeepMatchAdapter();
    const adapter = {
      ...fake,
      async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
        const opportunityId = input.candidates[0]!.opportunityId; calls.push(opportunityId);
        return fake.assess(input, call);
      },
    };
    const durable = checkpoint(); let interrupted = false;
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const result = await durable.check(input);
      if (!interrupted && input.checkpointKey.startsWith(`deep_match_model:${job.opportunityIds[0]}:`) && result.kind === "continue") {
        interrupted = true;
        if (mode === "pause") await database.update(agentRuns).set({ controlState: "pause_requested" }).where(eq(agentRuns.id, job.runId));
        if (mode === "cancel") await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(eq(agentRuns.id, job.runId));
        if (mode === "budget") await database.update(agentRuns).set({ totalTokenCount: 19_950, inputTokenCount: 19_902 }).where(eq(agentRuns.id, job.runId));
        if (mode === "claim loss") await database.update(agentRuns).set({ claimToken: crypto.randomUUID(), claimExpiresAt: new Date(now.getTime() + 30_000) }).where(eq(agentRuns.id, job.runId));
      }
      return result;
    } };
    const outcome = await createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter,
      checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    }).process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });

    expect(outcome).toBe(expected);
    expect(calls).toEqual([job.opportunityIds[0]]);
    await expect(Promise.all([
      database.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, job.userId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId)),
    ])).resolves.toEqual([[], []]);
  });

  it.each([["pause", "paused"], ["cancel", "cancelled"], ["deadline", "budget_exhausted"], ["claim", "stale"]] as const)("hard-bounds a non-cooperative adapter on %s", async (mode, expected) => {
    const job = await deepMatchRun(); let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; }); let instant = now;
    const fake = new FakeDeepMatchAdapter();
    const adapter = { ...fake, async assess() { entered(); return new Promise<never>(() => undefined); } };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant, heartbeatIntervalMs: 1, heartbeatRenew: async () => {
      await started;
      if (mode === "pause") { await database.update(agentRuns).set({ controlState: "pause_requested" }).where(eq(agentRuns.id, job.runId)); return "paused"; }
      if (mode === "cancel") { await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(eq(agentRuns.id, job.runId)); return "cancelled"; }
      if (mode === "claim") { await database.update(agentRuns).set({ claimToken: crypto.randomUUID() }).where(eq(agentRuns.id, job.runId)); return false; }
      await database.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() + 360_000) }).where(eq(agentRuns.id, job.runId)); instant = new Date(now.getTime() + 180_001); return true;
    } });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe(expected);
    await expect(database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId))).resolves.toEqual([]);
  });

  it.each([
    ["释放账户停止", "paused", false],
    ["取消优先", "cancelled", false],
    ["旧 claim 被替换", "paused", true],
  ] as const)("账户停止后 deferred 模型调用在%s再迟到返回时，只结算旧 invocation usage", async (_scenario, expectedStatus, replaceClaim) => {
    const job = await deepMatchRun(); const fake = new FakeDeepMatchAdapter(); let entered!: () => void; let release!: () => void; let calls = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const returned = new Promise<void>((resolve) => { release = resolve; });
    const adapter = { ...fake, async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
      calls += 1; entered(); await returned;
      const result = await fake.assess(input, { ...call, signal: new AbortController().signal });
      return { ...result, usage: { inputTokens: 7, outputTokens: 11, latencyMs: 1 } };
    } };
    const auditTrail = createAuditTrail({ db: database, clock: () => now });
    const durable = checkpoint();
    const control = createAccountRunControl({ db: database, auditTrail, id: () => crypto.randomUUID(), clock: () => now });
    const runCommands = createAgentRunCommands({ db: database, queue: new Queue(), auditTrail, id: () => crypto.randomUUID(), clock: () => now, runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) });
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: durable, contentStore: new Store(), auditTrail, id: () => crypto.randomUUID(), clock: () => now, heartbeatIntervalMs: 1, heartbeatRenew: async (input) => {
      await started;
      await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
      if (expectedStatus === "cancelled") await runCommands.control({ userId: job.userId, requestId: crypto.randomUUID(), runId: job.runId, command: { commandId: crypto.randomUUID(), action: "cancel" } });
      const decision = await durable.check({ userId: input.userId, runId: input.runId, claimToken: input.claimToken, checkpointKey: `${input.claimToken}:test_account_stop:1` });
      return decision.kind === "paused" || decision.kind === "cancelled" ? decision.kind : false;
    } });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe(expectedStatus);
    await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 1, action: "release" } });
    if (replaceClaim) await database.update(agentRuns).set({ status: "running", currentStep: "assess_matches", controlState: "none", claimToken: crypto.randomUUID(), claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, attemptCount: 2, modelCallCount: 3, inputTokenCount: 17, outputTokenCount: 19, totalTokenCount: 36 }).where(eq(agentRuns.id, job.runId));
    release();
    const usageKey = `deep_match_model:${job.opportunityIds[0]}:attempt:1`;
    await vi.waitFor(async () => expect(await database.select({ category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount }).from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.runId, job.runId), eq(agentRunUsageEntries.usageKey, usageKey))).orderBy(agentRunUsageEntries.category)).toEqual([{ category: "input_tokens", amount: 7 }, { category: "model_call", amount: 1 }, { category: "output_tokens", amount: 11 }]));
    expect(calls).toBe(1);
    await expect(Promise.all([database.select({ assessment: deepMatchRunCandidates.assessment }).from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, job.runId)), database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId)), database.select({ status: agentRuns.status, attemptCount: agentRuns.attemptCount, modelCallCount: agentRuns.modelCallCount, inputTokenCount: agentRuns.inputTokenCount, outputTokenCount: agentRuns.outputTokenCount, totalTokenCount: agentRuns.totalTokenCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))])).resolves.toEqual([[{ assessment: null }, { assessment: null }], [], replaceClaim ? [{ status: "running", attemptCount: 2, modelCallCount: 3, inputTokenCount: 17, outputTokenCount: 19, totalTokenCount: 36 }] : [expect.objectContaining({ status: expectedStatus })]]);
  });

  it("同一轮 abort 和 adapter resolve 时仍只结算一次 usage 且不暂存或发布", async () => {
    const job = await deepMatchRun(); const fake = new FakeDeepMatchAdapter(); let entered!: () => void; let calls = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const adapter = { ...fake, async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
      calls += 1; entered();
      await new Promise<void>((resolve) => call.signal.addEventListener("abort", () => resolve(), { once: true }));
      const result = await fake.assess(input, { ...call, signal: new AbortController().signal });
      return { ...result, usage: { inputTokens: 7, outputTokens: 11, latencyMs: 1 } };
    } };
    const auditTrail = createAuditTrail({ db: database, clock: () => now }); const durable = checkpoint();
    const control = createAccountRunControl({ db: database, auditTrail, id: () => crypto.randomUUID(), clock: () => now });
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: durable, contentStore: new Store(), auditTrail, id: () => crypto.randomUUID(), clock: () => now, heartbeatIntervalMs: 1, heartbeatRenew: async (input) => {
      await started;
      await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
      const decision = await durable.check({ userId: input.userId, runId: input.runId, claimToken: input.claimToken, checkpointKey: `${input.claimToken}:test_account_stop:1` });
      return decision.kind === "paused" ? "paused" : false;
    } });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("paused");
    const usageKey = `deep_match_model:${job.opportunityIds[0]}:attempt:1`;
    await vi.waitFor(async () => expect(await database.select({ category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount }).from(agentRunUsageEntries).where(and(eq(agentRunUsageEntries.runId, job.runId), eq(agentRunUsageEntries.usageKey, usageKey))).orderBy(agentRunUsageEntries.category)).toEqual([{ category: "input_tokens", amount: 7 }, { category: "model_call", amount: 1 }, { category: "output_tokens", amount: 11 }]));
    expect(calls).toBe(1);
    await expect(Promise.all([database.select({ assessment: deepMatchRunCandidates.assessment }).from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, job.runId)), database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId)), database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, job.runId))])).resolves.toEqual([[{ assessment: null }, { assessment: null }], [], [{ status: "paused" }]]);
  });

  it("迟到模型 usage 的 checkpoint 失败只记录固定错误码，不把正常 abort 误报为结算失败", async () => {
    const job = await deepMatchRun(); const fake = new FakeDeepMatchAdapter(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const returned = new Promise<void>((resolve) => { release = resolve; });
    const adapter = { ...fake, async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
      entered(); await returned;
      const result = await fake.assess(input, { ...call, signal: new AbortController().signal });
      return { ...result, usage: { inputTokens: 7, outputTokens: 11, latencyMs: 1 } };
    } };
    const auditTrail = createAuditTrail({ db: database, clock: () => now }); const durable = checkpoint();
    const control = createAccountRunControl({ db: database, auditTrail, id: () => crypto.randomUUID(), clock: () => now });
    const injected: AgentRunCheckpoint = { check: async (input) => {
      if (input.checkpointKey.startsWith("deep_match_model:")) throw new Error("INJECTED_LATE_CHECKPOINT_FAILURE");
      return durable.check(input);
    } };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: injected, contentStore: new Store(), auditTrail, id: () => crypto.randomUUID(), clock: () => now, heartbeatIntervalMs: 1, heartbeatRenew: async (input) => {
        await started;
        await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
        const decision = await durable.check({ userId: input.userId, runId: input.runId, claimToken: input.claimToken, checkpointKey: `${input.claimToken}:test_account_stop:1` });
        return decision.kind === "paused" ? "paused" : false;
      } });
      await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("paused");
      release();
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith("AGENT_RUN_LATE_USAGE_SETTLEMENT_FAILED"));
      expect(error).toHaveBeenCalledTimes(1);
    } finally { error.mockRestore(); }
  });

  it("被 abort 拒绝的模型调用不标记迟到 usage 结算失败", async () => {
    const job = await deepMatchRun(); const fake = new FakeDeepMatchAdapter(); let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const adapter = { ...fake, async assess(_input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
      entered();
      await new Promise<void>((resolve) => call.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new DeepMatchAdapterError("retryable");
    } };
    const auditTrail = createAuditTrail({ db: database, clock: () => now }); const durable = checkpoint();
    const control = createAccountRunControl({ db: database, auditTrail, id: () => crypto.randomUUID(), clock: () => now });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: durable, contentStore: new Store(), auditTrail, id: () => crypto.randomUUID(), clock: () => now, heartbeatIntervalMs: 1, heartbeatRenew: async (input) => {
        await started;
        await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
        const decision = await durable.check({ userId: input.userId, runId: input.runId, claimToken: input.claimToken, checkpointKey: `${input.claimToken}:test_account_stop:1` });
        return decision.kind === "paused" ? "paused" : false;
      } });
      await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("paused");
      expect(error).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it.each([["pause_requested", "paused"], ["cancel_requested", "cancelled"]] as const)("settles one actual model usage before post-call %s transition", async (controlState, expected) => {
    const job = await deepMatchRun(); const fake = new FakeDeepMatchAdapter(); let injected = false;
    const adapter = { ...fake, async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
      const result = await fake.assess(input, call);
      return { ...result, usage: { inputTokens: 7, outputTokens: 11, latencyMs: 1 } };
    } };
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      if (!injected && input.checkpointKey.startsWith("deep_match_model:")) { injected = true; await database.update(agentRuns).set({ controlState }).where(eq(agentRuns.id, job.runId)); }
      return durable.check(input);
    } };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe(expected);
    await expect(Promise.all([
      database.select({ category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount }).from(agentRunUsageEntries).where(eq(agentRunUsageEntries.runId, job.runId)),
      database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId)),
    ])).resolves.toEqual([expect.arrayContaining([{ category: "model_call", amount: 1 }, { category: "input_tokens", amount: 7 }, { category: "output_tokens", amount: 11 }]), [{ status: expected }], []]);
  });

  it.each([
    ["pause_requested", "paused"],
    ["cancel_requested", "cancelled"],
    ["claim replacement", "stale"],
  ] as const)("settles a returned model result without staging when %s lands before staging", async (interruption, expected) => {
    const job = await deepMatchRun(); const fake = new FakeDeepMatchAdapter(); let calls = 0;
    const adapter = { ...fake, async assess(input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
      const result = await fake.assess(input, call); calls += 1;
      if (calls === 1) {
        if (interruption === "claim replacement") await database.update(agentRuns).set({ claimToken: crypto.randomUUID(), claimExpiresAt: new Date(now.getTime() + 30_000), attemptCount: 2, activeSliceStartedAt: new Date(now.getTime() + 5_000) }).where(eq(agentRuns.id, job.runId));
        else await database.update(agentRuns).set({ controlState: interruption }).where(eq(agentRuns.id, job.runId));
      }
      return { ...result, usage: { inputTokens: 7, outputTokens: 11, latencyMs: 1 } };
    } };
    const processor = () => createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

    await expect(processor().process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe(expected);
    await expect(Promise.all([
      database.select({ category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount }).from(agentRunUsageEntries).where(eq(agentRunUsageEntries.runId, job.runId)),
      database.select({ assessment: deepMatchRunCandidates.assessment }).from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.runId, job.runId), eq(deepMatchRunCandidates.opportunityId, job.opportunityIds[0]!))),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId)),
    ])).resolves.toEqual([expect.arrayContaining([{ category: "model_call", amount: 1 }, { category: "input_tokens", amount: 7 }, { category: "output_tokens", amount: 11 }]), [expect.objectContaining({ assessment: null })], []]);
    if (interruption === "claim replacement") await expect(database.select({ attemptCount: agentRuns.attemptCount, activeSliceStartedAt: agentRuns.activeSliceStartedAt, modelCallCount: agentRuns.modelCallCount }).from(agentRuns).where(eq(agentRuns.id, job.runId)))
      .resolves.toEqual([{ attemptCount: 2, activeSliceStartedAt: new Date(now.getTime() + 5_000), modelCallCount: 0 }]);
  });

  it.each([
    ["pause", "paused", "run.paused", "agent.run_paused"],
    ["cancel", "cancelled", "run.cancelled", "agent.run_cancelled"],
    ["deadline", "budget_exhausted", "run.failed", "agent.run_budget_exhausted"],
    ["claim-loss", "stale", null, null],
  ] as const)("maps a blocking matching adapter %s interruption through the authoritative lifecycle", async (mode, expected, eventType, auditType) => {
    const job = await deepMatchRun();
    let instant = now; let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const fake = new FakeDeepMatchAdapter();
    const adapter = { ...fake, async assess(_input: Parameters<FakeDeepMatchAdapter["assess"]>[0], call: Parameters<FakeDeepMatchAdapter["assess"]>[1]) {
      releaseStarted();
      await new Promise<void>((resolve) => {
        if (call.signal.aborted) return resolve();
        call.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DeepMatchAdapterError("retryable");
    } };
    const processor = createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, deepMatchAdapter: adapter,
      checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant,
      heartbeatIntervalMs: 1,
      heartbeatRenew: async () => {
        await started;
        if (mode === "pause") { await database.update(agentRuns).set({ controlState: "pause_requested" }).where(eq(agentRuns.id, job.runId)); return "paused"; }
        if (mode === "cancel") { await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(eq(agentRuns.id, job.runId)); return "cancelled"; }
        if (mode === "claim-loss") { await database.update(agentRuns).set({ claimToken: crypto.randomUUID() }).where(eq(agentRuns.id, job.runId)); return false; }
        await database.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() + 360_000) }).where(eq(agentRuns.id, job.runId));
        instant = new Date(now.getTime() + 180_001);
        return true;
      },
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe(expected);
    await expect(Promise.all([
      database.select({ status: agentRuns.status, failureCode: agentRuns.failureCode, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
      database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(eq(agentRunEvents.runId, job.runId)),
      database.select({ eventType: auditEvents.eventType }).from(auditEvents).where(eq(auditEvents.resourceId, job.runId)),
      database.select().from(recommendationLists).where(eq(recommendationLists.userId, job.userId)),
    ])).resolves.toEqual([
      [expect.objectContaining({ status: expected === "stale" ? "running" : expected === "budget_exhausted" ? "failed" : expected })],
      eventType ? expect.arrayContaining([expect.objectContaining({ eventType })]) : expect.not.arrayContaining([expect.objectContaining({ eventType: "run.failed" })]),
      auditType ? expect.arrayContaining([expect.objectContaining({ eventType: auditType })]) : expect.not.arrayContaining([expect.objectContaining({ eventType: "agent.run_failed" })]),
      [],
    ]);
  });

  it("v4 processor 严格恢复完整 spec、调度物理操作并独立持久化运行问题", async () => {
    const job = await layeredRun(); let observedSpec: unknown;
    const outcome = await createAgentRunProcessor({
      db: database, adapterResolver: { resolve: () => { throw new Error("v1-v3 adapter must not receive v4"); } },
      layeredPublicWorkflowResolver: { resolve: ({ executionSpec }) => ({ run: async ({ beforePhysicalOperation }) => {
        observedSpec = executionSpec;
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        return { branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [{ scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 1 }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 }, { provider: "greenhouse", code: "SOURCE_CAPABILITY_UNSUPPORTED", affectedCount: 1 }] };
      } }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    }).process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    expect(outcome).toBe("completed");
    expect(observedSpec).toMatchObject({ workflowVersion: LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, profileSnapshot: { targetId: job.targetId }, watchlistSnapshot: { targetId: job.targetId }, sourceScope: { publicDiscovery: { queries: [expect.objectContaining({ ordinal: 1, allowedSiteDomains: [] })] } } });
    await expect(database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId))).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED" }), expect.objectContaining({ provider: "greenhouse", code: "SOURCE_CAPABILITY_UNSUPPORTED" })]));
    await expect(database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toEqual([]);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "completed", termination: { kind: "completed_with_source_issues" }, results: [{ sourcePostingVersionId: job.sourcePostingVersionId }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED" }, { provider: "greenhouse", code: "SOURCE_CAPABILITY_UNSUPPORTED", impact: { scope: "entire_source", affectedCount: null }, retryable: false, suggestedActions: ["review_source_capabilities"] }], usage: { toolCalls: 1, sourceRequests: 1 } });
  });

  it("v4 已验证 AnySearch Lead 只通过来源版本映射 Opportunity 与 RunResult", async () => {
    const job = await layeredRun();
    const leadId = crypto.randomUUID();
    await database.insert(jobDiscoveryLeads).values({ id: leadId, userId: job.userId, runId: job.runId, targetId: job.targetId, provider: "anysearch", queryId: job.queryId, queryKind: "general", queryFingerprint: "a".repeat(64), normalizedUrl: "https://fixture.invalid/opaque", stableFingerprint: "b".repeat(64), expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), state: "verified", sourcePostingVersionId: job.sourcePostingVersionId, verifiedFinalUrl: "https://fixture.invalid/opaque", rejectionCode: null, createdAt: now, updatedAt: now });
    await database.insert(jobDiscoveryAttributions).values({ id: crypto.randomUUID(), userId: job.userId, runId: job.runId, leadId, queryId: job.queryId, provider: "anysearch", sourcePostingVersionId: job.sourcePostingVersionId, createdAt: now });
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ branchOutcome: { trusted: "succeeded", publicDiscovery: "verified" }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [], diagnostics: [] }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    await expect(Promise.all([
      database.select({ opportunityId: jobOpportunities.id, sourcePostingVersionId: jobOpportunities.sourcePostingVersionId }).from(jobOpportunities).where(eq(jobOpportunities.userId, job.userId)),
      database.select({ sourcePostingVersionId: jobOpportunitySources.sourcePostingVersionId }).from(jobOpportunitySources).where(eq(jobOpportunitySources.userId, job.userId)),
      database.select({ sourcePostingVersionId: jobDiscoveryRunResults.sourcePostingVersionId }).from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.userId, job.userId)),
      database.select({ sourceId: jobSourcePostings.sourceId }).from(jobSourcePostings).where(eq(jobSourcePostings.userId, job.userId)),
    ])).resolves.toEqual([
      [expect.objectContaining({ sourcePostingVersionId: job.sourcePostingVersionId })],
      [{ sourcePostingVersionId: job.sourcePostingVersionId }],
      [{ sourcePostingVersionId: job.sourcePostingVersionId }],
      [{ sourceId: "greenhouse:example" }],
    ]);
  });

  it("v4 trusted bridge 只在有效 claim 下持久化冻结 Greenhouse 来源，且重放不写运行副作用", async () => {
    const job = await layeredRun();
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), activeSliceStartedAt: now, attemptCount: 1 }).where(eq(agentRuns.id, job.runId));
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }) }) as unknown as {
      persistTrustedLayeredDiscovery(input: unknown): Promise<{ sourcePostingVersionIds: string[]; cleanupObjectKeys: string[] }>;
    };
    const input = {
      userId: job.userId, runId: job.runId, claimToken, sourceId: "greenhouse:example", now,
      details: [{ sourceId: "greenhouse:example", detailId: "opening-2", company: "Example", title: "AI 应用工程师", location: "上海", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { id: "opening-2" } }],
      storedObjects: [{ sourceId: "greenhouse:example", detailId: "opening-2", objectKey: "accounts/trusted/opening-2.json", rawContentSha256: "c".repeat(64) }],
    };

    const first = await persistence.persistTrustedLayeredDiscovery(input);
    const replay = await persistence.persistTrustedLayeredDiscovery(input);

    expect(first.sourcePostingVersionIds).toHaveLength(1);
    expect(replay.sourcePostingVersionIds).toEqual(first.sourcePostingVersionIds);
    await expect(database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, job.userId))).resolves.toHaveLength(1);
    await expect(Promise.all([
      database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId)),
      database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId)),
      database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)),
      database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)),
    ])).resolves.toEqual([[], [], [], [], [], []]);
    await expect(database.select({ status: agentRuns.status, currentStep: agentRuns.currentStep, claimToken: agentRuns.claimToken }).from(agentRuns).where(eq(agentRuns.id, job.runId)))
      .resolves.toEqual([{ status: "running", currentStep: "batch_search", claimToken }]);
  });

  it("账户停止且 run pause 标记丢失后 trusted bridge 不写 Opportunity", async () => {
    const job = await layeredRun(); const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), activeSliceStartedAt: now, attemptCount: 1, controlState: "none" }).where(eq(agentRuns.id, job.runId));
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await database.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, job.runId));
    const persistence = createJobDiscoveryPersistence({ db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }) });
    await expect(persistence.persistTrustedLayeredDiscovery({ userId: job.userId, runId: job.runId, claimToken, sourceId: "greenhouse:example", now, details: [{ sourceId: "greenhouse:example", detailId: "stopped", company: "Example", title: "AI", location: null, postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} }], storedObjects: [{ sourceId: "greenhouse:example", detailId: "stopped", objectKey: "stopped.json", rawContentSha256: "d".repeat(64) }] })).rejects.toMatchObject({ code: "JOB_DISCOVERY_CLAIM_STALE" });
    await expect(database.select().from(jobOpportunities).where(eq(jobOpportunities.userId, job.userId))).resolves.toEqual([]);
  });

  it("v4 runtime 逐次 checkpoint 同一 signal 地包装冻结 Greenhouse，并只经 claim bridge 写入", async () => {
    const job = await layeredRun();
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), activeSliceStartedAt: now, attemptCount: 1 }).where(eq(agentRuns.id, job.runId));
    const [claimed] = await database.select().from(agentRuns).where(eq(agentRuns.id, job.runId));
    if (!claimed) throw new Error("missing claimed run");
    const executionSpec = {
      targetSnapshot: claimed.targetSnapshot, profileSnapshot: claimed.profileSnapshot, watchlistSnapshot: claimed.watchlistSnapshot,
      sourceScope: claimed.sourceScope, workflowVersion: claimed.workflowVersion, ruleVersion: claimed.ruleVersion,
      adapter: claimed.adapter, adapterVersion: claimed.adapterVersion, outputSchemaVersion: claimed.outputSchemaVersion,
      toolAllowlist: claimed.toolAllowlist, model: claimed.modelSnapshot, budget: claimed.budgetSnapshot,
    };
    const store = new Store();
    const controller = new AbortController();
    const requests: string[] = [];
    const adapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async (input: any) => {
        expect(input.signal).toBe(controller.signal);
        requests.push(`list:${input.source.sourceId}`);
        return { ok: true as const, data: { sourceId: input.source.sourceId, observedDetailIds: ["opening-2"], candidates: [{ sourceId: input.source.sourceId, detailId: "opening-2" }] } };
      },
      getSourceDetail: async (input: any) => {
        expect(input.signal).toBe(controller.signal);
        requests.push(`detail:${input.source.sourceId}:${input.detailId}`);
        return { ok: true as const, data: { sourceId: input.source.sourceId, detailId: input.detailId, company: "Example", title: "AI 应用工程师", location: "上海", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { z: 1, a: "canonical" } } };
      },
    };
    const runtime = createLayeredPublicJobDiscoveryRuntime({
      db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }),
      contentStore: store, evidenceStore: store as never, trustedSourceAdapter: adapter,
      anySearch: { search: async () => ({ candidates: [] }), extract: async () => { throw new Error("UNUSED"); } },
      preflight: async () => null, fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
    } as any);
    const first = await runtime.run({ userId: job.userId, runId: job.runId, claimToken, now, executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async ({ kind }) => { requests.push(`checkpoint:${kind}`); }, onDiagnostics: () => undefined, signal: controller.signal });
    const replay = await runtime.run({ userId: job.userId, runId: job.runId, claimToken, now, executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async ({ kind }) => { requests.push(`checkpoint:${kind}`); }, onDiagnostics: () => undefined, signal: controller.signal });

    expect(requests).toEqual([
      "checkpoint:search", "list:greenhouse:example", "checkpoint:search", "detail:greenhouse:example:opening-2",
      "checkpoint:search", "list:greenhouse:example", "checkpoint:search", "detail:greenhouse:example:opening-2",
    ]);
    expect(first).toMatchObject({ branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, trustedSourcePostingVersionIds: [expect.any(String)], sourceIssues: [] });
    expect(replay.trustedSourcePostingVersionIds).toEqual(first.trustedSourcePostingVersionIds);
    expect(store.puts[0]).toMatch(new RegExp(`^accounts/${job.userId}/agent-runs/${job.runId}/trusted/`));
    expect(new TextDecoder().decode(store.payloads.get(store.puts[0]!)!)).toBe('{"a":"canonical","z":1}');
    expect(store.deletes).toEqual([store.puts[1]]);
    await expect(Promise.all([
      database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId)),
      database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId)),
      database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)),
      database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)),
    ])).resolves.toEqual([[], [], [], [], [], []]);
    await expect(database.select({ status: agentRuns.status, currentStep: agentRuns.currentStep, claimToken: agentRuns.claimToken }).from(agentRuns).where(eq(agentRuns.id, job.runId)))
      .resolves.toEqual([{ status: "running", currentStep: "batch_search", claimToken }]);
  });

  it("v4 runtime 将 detail timeout 的部分损失冻结在可信成功事实中", async () => {
    const job = await layeredRun();
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), activeSliceStartedAt: now, attemptCount: 1 }).where(eq(agentRuns.id, job.runId));
    const [claimed] = await database.select().from(agentRuns).where(eq(agentRuns.id, job.runId));
    const spec = { targetSnapshot: claimed!.targetSnapshot, profileSnapshot: claimed!.profileSnapshot, watchlistSnapshot: claimed!.watchlistSnapshot, sourceScope: claimed!.sourceScope, workflowVersion: claimed!.workflowVersion, ruleVersion: claimed!.ruleVersion, adapter: claimed!.adapter, adapterVersion: claimed!.adapterVersion, outputSchemaVersion: claimed!.outputSchemaVersion, toolAllowlist: claimed!.toolAllowlist, model: claimed!.modelSnapshot, budget: claimed!.budgetSnapshot };
    const runtime = createLayeredPublicJobDiscoveryRuntime({
      db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }), contentStore: new Store(), evidenceStore: new Store() as never,
      trustedSourceAdapter: {
        adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
        declareCapabilities: ({ sourceId }: any) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
        listSource: async ({ source }: any) => ({ ok: true as const, data: { sourceId: source.sourceId, observedDetailIds: ["timeout", "good"], candidates: [{ sourceId: source.sourceId, detailId: "timeout" }, { sourceId: source.sourceId, detailId: "good" }] } }),
        getSourceDetail: async ({ source, detailId }: any) => detailId === "timeout"
          ? { ok: false as const, error: { code: "GREENHOUSE_TIMEOUT" } }
          : { ok: true as const, data: { sourceId: source.sourceId, detailId, company: "Example", title: "AI 应用工程师", location: "上海", postedAt: null, deadline: null, sourceType: "company_careers" as const, isOfficial: true as const, rawPayload: { id: detailId } } },
      },
      anySearch: { isConfigured: () => false, search: async () => ({ candidates: [] }), extract: async () => { throw new Error("UNUSED"); } }, preflight: async () => null, fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
    });
    const outcome = await runtime.run({ userId: job.userId, runId: job.runId, claimToken, now, executionSpec: spec as never, attemptCount: 1, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ branchOutcome: { trusted: "succeeded", publicDiscovery: "failed" }, trustedSourcePostingVersionIds: [expect.any(String)], discoveryFacts: { trusted: [{ sourceId: "greenhouse:example", checked: true, outcome: "credible_results", losses: [{ code: "VERIFICATION_FAILED", retryable: true }] }] } });
  });

  it("v4 runtime 将候选 capability 展平为 owner/run/query-bound Lead 事实并保留 queryKind", async () => {
    const job = await layeredRun();
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), activeSliceStartedAt: now, attemptCount: 1 }).where(eq(agentRuns.id, job.runId));
    const [claimed] = await database.select().from(agentRuns).where(eq(agentRuns.id, job.runId));
    if (!claimed) throw new Error("missing claimed run");
    const executionSpec = {
      targetSnapshot: claimed.targetSnapshot, profileSnapshot: claimed.profileSnapshot, watchlistSnapshot: claimed.watchlistSnapshot,
      sourceScope: claimed.sourceScope, workflowVersion: claimed.workflowVersion, ruleVersion: claimed.ruleVersion,
      adapter: claimed.adapter, adapterVersion: claimed.adapterVersion, outputSchemaVersion: claimed.outputSchemaVersion,
      toolAllowlist: claimed.toolAllowlist, model: claimed.modelSnapshot, budget: claimed.budgetSnapshot,
    };
    const candidateUrl = "https://boards.greenhouse.io/example/jobs/9001";
    const candidate = { normalizedUrl: candidateUrl, stableFingerprint: createHash("sha256").update(candidateUrl).digest("hex") };
    const evidenceStore = { put: async () => ({ created: true }), delete: async () => undefined };
    const runtime = createLayeredPublicJobDiscoveryRuntime({
      db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }),
      contentStore: new Store(), evidenceStore,
      trustedSourceAdapter: {
        adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
        declareCapabilities: ({ sourceId }: any) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
        listSource: async () => ({ ok: false as const, error: { code: "GREENHOUSE_UNAVAILABLE" } }),
        getSourceDetail: async () => { throw new Error("UNUSED"); },
      },
      anySearch: {
        isConfigured: () => true,
        search: async ({ beforeRequest }) => { await beforeRequest(); return { candidates: [candidate] }; },
        extract: async ({ candidate: recovered, beforeRequest }) => { await beforeRequest(); return { normalizedUrl: recovered.normalizedUrl }; },
      },
      preflight: async ({ candidate: issued }) => ({ normalizedUrl: issued.normalizedUrl }),
      fetcher: {
        fetch: async ({ candidate: recovered }) => ({
          requestedUrl: recovered.normalizedUrl, finalUrl: recovered.normalizedUrl, canonicalUrl: recovered.normalizedUrl,
          rawHtml: "<main><h1>AI 应用工程师</h1><p>职责：构建产品</p><p>要求：TypeScript</p></main>",
          visibleText: "AI 应用工程师\n职责：构建产品\n要求：TypeScript", pageClassification: "job" as const, sourceKind: "official" as const,
        }),
      },
    });

    const outcome = await runtime.run({ userId: job.userId, runId: job.runId, claimToken, now, executionSpec: executionSpec as never, attemptCount: 1, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined, signal: new AbortController().signal });

    expect(outcome).toMatchObject({ branchOutcome: { trusted: "failed", publicDiscovery: "verified" }, sourcePostingVersionIds: [expect.any(String)] });
    const [lead] = await database.select().from(jobDiscoveryLeads).where(and(eq(jobDiscoveryLeads.userId, job.userId), eq(jobDiscoveryLeads.runId, job.runId)));
    expect(lead).toMatchObject({ targetId: job.targetId, queryId: job.queryId, queryKind: "general", queryFingerprint: "a".repeat(64), normalizedUrl: candidate.normalizedUrl, stableFingerprint: candidate.stableFingerprint, state: "verified" });
    await expect(database.select().from(jobDiscoveryAttributions).where(and(eq(jobDiscoveryAttributions.userId, job.userId), eq(jobDiscoveryAttributions.runId, job.runId), eq(jobDiscoveryAttributions.queryId, job.queryId), eq(jobDiscoveryAttributions.leadId, lead!.id)))).resolves.toHaveLength(1);
  });

  it("v4 trusted wrapper 聚合局部来源失败并拒绝跨来源详情身份", async () => {
    const job = await layeredRun();
    const claimToken = crypto.randomUUID();
    const [row] = await database.select().from(agentRuns).where(eq(agentRuns.id, job.runId));
    const sourceScope = structuredClone(row!.sourceScope) as any;
    sourceScope.trustedSources.push({ kind: "greenhouse_trusted_source", source: { sourceId: "greenhouse:unavailable", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Unavailable", careersUrl: "https://boards.greenhouse.io/unavailable", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "unavailable" } });
    await database.update(agentRuns).set({ sourceScope, status: "running", currentStep: "batch_search", startedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), activeSliceStartedAt: now, attemptCount: 1 }).where(eq(agentRuns.id, job.runId));
    const [claimed] = await database.select().from(agentRuns).where(eq(agentRuns.id, job.runId));
    const spec = { targetSnapshot: claimed!.targetSnapshot, profileSnapshot: claimed!.profileSnapshot, watchlistSnapshot: claimed!.watchlistSnapshot, sourceScope: claimed!.sourceScope, workflowVersion: claimed!.workflowVersion, ruleVersion: claimed!.ruleVersion, adapter: claimed!.adapter, adapterVersion: claimed!.adapterVersion, outputSchemaVersion: claimed!.outputSchemaVersion, toolAllowlist: claimed!.toolAllowlist, model: claimed!.modelSnapshot, budget: claimed!.budgetSnapshot };
    const runtime = createLayeredPublicJobDiscoveryRuntime({
      db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }), contentStore: new Store(), evidenceStore: new Store() as never,
      trustedSourceAdapter: {
        adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
        declareCapabilities: ({ sourceId }: any) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
        listSource: async ({ source, signal }: any) => source.sourceId === "greenhouse:unavailable"
          ? { ok: false as const, error: { code: "GREENHOUSE_TIMEOUT" } }
          : { ok: true as const, data: { sourceId: source.sourceId, observedDetailIds: ["opening-2"], candidates: [{ sourceId: source.sourceId, detailId: "opening-2" }] }, signal },
        getSourceDetail: async ({ source, detailId, signal }: any) => ({ ok: true as const, data: { sourceId: "greenhouse:other", detailId, company: "Example", title: "AI 应用工程师", location: "上海", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: {} }, signal }),
      },
      anySearch: { search: async () => ({ candidates: [] }), extract: async () => { throw new Error("UNUSED"); } }, preflight: async () => null, fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
    } as any);
    const outcome = await runtime.run({ userId: job.userId, runId: job.runId, claimToken, now, executionSpec: spec as never, attemptCount: 1, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined, signal: new AbortController().signal });

    expect(outcome).toMatchObject({ branchOutcome: { trusted: "failed", publicDiscovery: "clean_zero" }, trustedSourcePostingVersionIds: [], sourceIssues: [
      { provider: "greenhouse", code: "GREENHOUSE_DETAIL_IDENTITY_INVALID", affectedCount: 1 },
      { provider: "greenhouse", code: "GREENHOUSE_TIMEOUT", affectedCount: 1 },
    ] });
    await expect(database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, job.userId))).resolves.toHaveLength(1);
  });

  it("v4 trusted wrapper 在详情返回后 claim 被暂停时不留下来源写入或对象", async () => {
    const job = await layeredRun();
    const claimToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", startedAt: now, claimToken, claimExpiresAt: new Date(Date.now() + 30_000), activeSliceStartedAt: now, attemptCount: 1 }).where(eq(agentRuns.id, job.runId));
    const [claimed] = await database.select().from(agentRuns).where(eq(agentRuns.id, job.runId));
    const spec = { targetSnapshot: claimed!.targetSnapshot, profileSnapshot: claimed!.profileSnapshot, watchlistSnapshot: claimed!.watchlistSnapshot, sourceScope: claimed!.sourceScope, workflowVersion: claimed!.workflowVersion, ruleVersion: claimed!.ruleVersion, adapter: claimed!.adapter, adapterVersion: claimed!.adapterVersion, outputSchemaVersion: claimed!.outputSchemaVersion, toolAllowlist: claimed!.toolAllowlist, model: claimed!.modelSnapshot, budget: claimed!.budgetSnapshot };
    const store = new Store();
    const runtime = createLayeredPublicJobDiscoveryRuntime({
      db: database, id: () => crypto.randomUUID(), auditTrail: createAuditTrail({ db: database, clock: () => now }), contentStore: store, evidenceStore: store as never,
      trustedSourceAdapter: {
        adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
        declareCapabilities: ({ sourceId }: any) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
        listSource: async ({ source }: any) => ({ ok: true as const, data: { sourceId: source.sourceId, observedDetailIds: ["opening-2"], candidates: [{ sourceId: source.sourceId, detailId: "opening-2" }] } }),
        getSourceDetail: async ({ source, detailId }: any) => {
          await database.update(agentRuns).set({ controlState: "pause_requested" }).where(eq(agentRuns.id, job.runId));
          return { ok: true as const, data: { sourceId: source.sourceId, detailId, company: "Example", title: "AI 应用工程师", location: "上海", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { id: detailId } } };
        },
      },
      anySearch: { search: async () => ({ candidates: [] }), extract: async () => { throw new Error("UNUSED"); } }, preflight: async () => null, fetcher: { fetch: async () => { throw new Error("UNUSED"); } },
    });
    const outcome = await runtime.run({ userId: job.userId, runId: job.runId, claimToken, now, executionSpec: spec as never, attemptCount: 1, beforePhysicalOperation: async () => undefined, onDiagnostics: () => undefined, signal: new AbortController().signal });

    expect(outcome.interruption).toBe("stale");
    expect(store.deletes).toEqual(store.puts);
    await expect(database.select().from(jobSourcePostings).where(eq(jobSourcePostings.userId, job.userId))).resolves.toHaveLength(1);
    await expect(database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, job.userId))).resolves.toHaveLength(1);
  });

  it("v4 detail、latest 与 eventsAfter 只投影同 owner 的有序脱敏事实，并保持 resultCount", async () => {
    const job = await layeredRun();
    const firstExtraVersionId = await extraTrustedVersion(job, 1);
    const secondExtraVersionId = await extraTrustedVersion(job, 2);
    const secretUrl = "https://untrusted.example.com/jobs/secret-123";
    const secretTitle = "不应泄漏的外部岗位标题";
    await database.update(jobSourcePostings).set({ sourceIdentifier: secretUrl }).where(eq(jobSourcePostings.id, (await database.select({ sourcePostingId: jobSourcePostingVersions.sourcePostingId }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.id, job.sourcePostingVersionId)))[0]!.sourcePostingId));
    await database.update(jobSourcePostingVersions).set({ normalizedData: { title: secretTitle, applicationUrl: secretUrl } }).where(eq(jobSourcePostingVersions.userId, job.userId));
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({
        branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" },
        sourcePostingVersionIds: [secondExtraVersionId, job.sourcePostingVersionId, firstExtraVersionId],
        trustedSourcePostingVersionIds: [secondExtraVersionId, job.sourcePostingVersionId, firstExtraVersionId],
        sourceIssues: [
          { provider: "greenhouse", code: "GREENHOUSE_DEGRADED", affectedCount: 1 },
          { provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 },
        ],
        diagnostics: [],
      }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    await database.insert(jobDiscoveryDiagnostics).values([
      { id: "11111111-aaaa-4111-8111-111111111111", userId: job.userId, runId: job.runId, scope: "provider", provider: "anysearch", queryId: null, queryKind: null, queryFingerprint: null, leadId: null, code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 1, createdAt: new Date(now.getTime() + 2_000) },
      { id: "22222222-bbbb-4222-8222-222222222222", userId: job.userId, runId: job.runId, scope: "query", provider: "anysearch", queryId: job.queryId, queryKind: "general", queryFingerprint: "a".repeat(64), leadId: null, code: "ANYSEARCH_POLICY_REJECTED", retryable: false, affectedCount: 1, createdAt: new Date(now.getTime() + 1_000) },
    ]);
    const [run] = await database.select().from(agentRuns).where(eq(agentRuns.id, job.runId));
    await database.insert(agentRuns).values({
      ...run!, id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), status: "queued", currentStep: "queued", attemptCount: 0,
      claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, completedAt: null, failedAt: null, cancelledAt: null,
      terminationKind: null, terminationBudgetDimension: null, failureCode: null, resultCount: 0, usageComplete: false,
      queuedAt: new Date(now.getTime() - 1_000), createdAt: new Date(now.getTime() - 1_000), updatedAt: new Date(now.getTime() - 1_000),
    });
    await database.update(agentRuns).set({ queuedAt: new Date(now.getTime() + 1_000) }).where(eq(agentRuns.id, job.runId));

    const queries = createAgentRunQueries({ db: database });
    const detail = await queries.get(job);
    if (!detail || detail.workflowVersion !== LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION) throw new Error("expected v4 detail");
    expect(detail).toMatchObject({
      runId: job.runId,
      usage: { results: 3, complete: true },
      results: [
        { sourcePostingVersionId: secondExtraVersionId },
        { sourcePostingVersionId: job.sourcePostingVersionId },
        { sourcePostingVersionId: firstExtraVersionId },
      ],
      sourceIssues: [
        { provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED" },
        { provider: "greenhouse", code: "GREENHOUSE_DEGRADED" },
      ],
    });
    expect(detail.discoveryDiagnostics.map(({ code }) => code)).toEqual(["ANYSEARCH_POLICY_REJECTED", "ANYSEARCH_NOT_CONFIGURED"]);
    expect(JSON.stringify(detail)).not.toContain(secretUrl);
    expect(JSON.stringify(detail)).not.toContain(secretTitle);
    expect(JSON.stringify(detail)).not.toContain("provider response body");
    await expect(queries.latest({ userId: job.userId })).resolves.toMatchObject({ run: { runId: job.runId, usage: { results: 3 } } });
    await expect(queries.eventsAfter({ userId: job.userId, runId: job.runId, afterSequence: detail.events[1]!.sequence })).resolves.toEqual(detail.events.slice(2));

    const other = await layeredRun();
    await expect(queries.get({ userId: other.userId, runId: job.runId })).resolves.toBeNull();
    await expect(queries.eventsAfter({ userId: other.userId, runId: job.runId, afterSequence: 0 })).resolves.toBeNull();
    await expect(queries.latest({ userId: other.userId })).resolves.toMatchObject({ run: { runId: other.runId } });
  });

  it("拒绝 plan 外 diagnostic 的恶意 resolver，事务不写 discovery facts", async () => {
    const job = await layeredRun();
    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [{ scope: "query", queryId: crypto.randomUUID(), kind: "general", stableFingerprint: "f".repeat(64), code: "ANYSEARCH_POLICY_REJECTED", retryable: false, affectedCount: 1 }] }) }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    expect(outcome).toBe("failed");
    await expect(Promise.all([database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)), database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId)), database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId))])).resolves.toEqual([[], [], []]);
  });

  it("v4 budget terminal 与预算 inbox 并存 discovery attention，重放不重复", async () => {
    const job = await layeredRun();
    await database.update(agentRuns).set({ attemptCount: 2 }).where(eq(agentRuns.id, job.runId));
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ branchOutcome: { trusted: "failed", publicDiscovery: "failed" }, diagnostics: [{ scope: "provider", code: "ANYSEARCH_QUOTA_EXHAUSTED", retryable: true, affectedCount: 1 }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_QUOTA_EXHAUSTED", affectedCount: 1 }] }) }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("budget_exhausted");
    const [issues, inbox, attentionAudit] = await Promise.all([
      database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)),
      database.select().from(auditEvents).where(and(eq(auditEvents.requestId, job.runId), eq(auditEvents.reasonCode, "DISCOVERY_ATTENTION"))),
    ]);
    expect(issues).toEqual([expect.objectContaining({ code: "ANYSEARCH_QUOTA_EXHAUSTED", affectedCount: 1 })]);
    expect(inbox.filter((item) => item.kind === "budget_exhausted")).toHaveLength(1);
    expect(inbox.filter((item) => item.kind === "discovery_attention")).toHaveLength(1);
    expect(attentionAudit).toHaveLength(1);
  });

  it("v4 实际不可重试终态不受 finalAttempt 影响，并且重放不重复 attention", async () => {
    const job = await layeredRun();
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({
        branchOutcome: { trusted: "failed", publicDiscovery: "failed" },
        diagnostics: [{ scope: "provider", code: "ANYSEARCH_NOT_CONFIGURED", retryable: false, affectedCount: 1 }],
        sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 }],
      }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("failed");
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("failed");
    const [issues, attention, attentionAudit] = await Promise.all([
      database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)),
      database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention"))),
      database.select().from(auditEvents).where(and(eq(auditEvents.requestId, job.runId), eq(auditEvents.reasonCode, "DISCOVERY_ATTENTION"))),
    ]);
    expect(issues).toEqual([expect.objectContaining({ code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 })]);
    expect(attention).toHaveLength(1);
    expect(attentionAudit).toHaveLength(1);
  });

  it("v4 result 复原既有 ordinal，稳定截断为五条并保持 detail/resultCount 一致", async () => {
    const job = await layeredRun();
    await database.update(agentRuns).set({ budgetSnapshot: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 60, maxResults: 1, maxModelCalls: 0, maxTokens: 0 } }).where(eq(agentRuns.id, job.runId));
    const extra = await Promise.all([1, 2, 3, 4, 5].map((index) => extraTrustedVersion(job, index)));
    await database.insert(jobDiscoveryRunResults).values({ id: crypto.randomUUID(), userId: job.userId, runId: job.runId, sourcePostingVersionId: job.sourcePostingVersionId, ordinal: 1, createdAt: now });
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [...extra, job.sourcePostingVersionId], trustedSourcePostingVersionIds: [...extra, job.sourcePostingVersionId], diagnostics: [] }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ resultCount: 1 }]);
    await expect(database.select({ metadata: auditEvents.metadata }).from(auditEvents).where(and(eq(auditEvents.resourceId, job.runId), eq(auditEvents.eventType, "agent.run_completed")))).resolves.toEqual([{ metadata: expect.objectContaining({ resultCount: 1 }) }]);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ results: [
      { sourcePostingVersionId: job.sourcePostingVersionId },
    ] });
  });

  it("v4 trusted result 必须属于获批可信来源且仍为官方 company careers", async () => {
    const job = await layeredRun();
    const untrustedVersion = await extraTrustedVersion(job, 9, { sourceType: "public_web", isOfficial: false });
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [untrustedVersion], trustedSourcePostingVersionIds: [untrustedVersion], diagnostics: [] }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("failed");
    await expect(database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId))).resolves.toEqual([]);
  });

  it("v4 completed duplicate delivery 返回 stale，且不重放 workflow、结果或 usage", async () => {
    const job = await layeredRun();
    let calls = 0;
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ beforePhysicalOperation }) => {
        calls += 1;
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        return { branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [] };
      } }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("stale");
    expect(calls).toBe(1);
    await expect(Promise.all([
      database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId)),
      database.select({ toolCalls: agentRuns.toolCallCount, sourceRequests: agentRuns.sourceRequestCount, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
    ])).resolves.toEqual([[expect.objectContaining({ sourcePostingVersionId: job.sourcePostingVersionId })], [{ toolCalls: 1, sourceRequests: 1, resultCount: 1 }]]);
  });

  it.each(["search", "extract", "fetch"] as const)("v4 checkpoint 在 %s 前停止后续物理调用", async (stopAt) => {
    const job = await layeredRun();
    const hooks: string[] = [];
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => input.checkpointKey.includes(`:layered_${stopAt}_`)
      ? { kind: "paused" }
      : durable.check(input) };
    const processor = createAgentRunProcessor({
      db: database, checkpoint: controlled,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ beforePhysicalOperation }) => {
        for (const kind of ["search", "extract", "fetch"] as const) { hooks.push(kind); await beforePhysicalOperation({ kind, identity: kind === "search" ? job.queryId : crypto.randomUUID() }); }
        return { branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [] };
      } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("paused");
    expect(hooks).toEqual(["search", "extract", "fetch"].slice(0, ["search", "extract", "fetch"].indexOf(stopAt) + 1));
  });

  it.each(["cancelled", "budget_exhausted", "stale"] as const)("v4 checkpoint 返回 %s 时不调用 workflow 后续物理操作", async (outcome) => {
    const job = await layeredRun(); let hooks = 0;
    const durable = checkpoint();
    const stop = outcome === "budget_exhausted" ? { kind: "budget_exhausted" as const, budgetDimension: "tool_calls" as const } : outcome === "cancelled" ? { kind: "cancelled" as const } : { kind: "stale" as const };
    const controlled: AgentRunCheckpoint = { check: async (input) => input.checkpointKey.includes(":layered_search_") ? stop : durable.check(input) };
    const processor = createAgentRunProcessor({ db: database, checkpoint: controlled, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ beforePhysicalOperation }) => { hooks += 1; await beforePhysicalOperation({ kind: "search", identity: job.queryId }); hooks += 1; return { branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, diagnostics: [] }; } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe(outcome);
    expect(hooks).toBe(1);
  });

  it("v4 heartbeat renew=false 立即中止同一 signal，并在旧 claim 返回后阻止无保留写入围栏", async () => {
    const job = await layeredRun();
    let resolveHeartbeat!: (value: boolean) => void;
    const heartbeat = new Promise<boolean>((resolve) => { resolveHeartbeat = resolve; });
    let releaseOldFetch!: () => void;
    const oldFetch = new Promise<void>((resolve) => { releaseOldFetch = resolve; });
    let reachedFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { reachedFetch = resolve; });
    let signal: AbortSignal | undefined;
    const hooks: string[] = [];
    const oldProcessor = createAgentRunProcessor({
      db: database,
      heartbeatRenew: async () => heartbeat,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ signal: receivedSignal, beforePhysicalOperation }) => {
        signal = receivedSignal;
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        hooks.push("fetch"); reachedFetch();
        await oldFetch; // 模拟 provider 忽略 AbortSignal 后才返回。
        hooks.push("record_pending");
        await beforePhysicalOperation({ kind: "record_pending", identity: job.queryId });
        throw new Error("must not write after lost lease");
      } }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    const processing = oldProcessor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    await fetchStarted;
    expect(signal?.aborted).toBe(false);
    await database.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() - 1) }).where(eq(agentRuns.id, job.runId));
    const takeover = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ beforePhysicalOperation }) => {
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        return { branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [] };
      } }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(takeover.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    resolveHeartbeat(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(signal?.aborted).toBe(true);
    releaseOldFetch();
    await expect(processing).resolves.toBe("stale");
    expect(hooks).toEqual(["fetch", "record_pending"]);
    await expect(Promise.all([
      database.select().from(jobDiscoveryLeads).where(eq(jobDiscoveryLeads.runId, job.runId)),
      database.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, job.userId)),
      database.select().from(jobDiscoveryAttributions).where(eq(jobDiscoveryAttributions.runId, job.runId)),
    ])).resolves.toEqual([[], [expect.objectContaining({ id: job.sourcePostingVersionId })], []]);
    await expect(database.select({ attempts: agentRuns.attemptCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ attempts: 2 }]);
  });

  it.each([
    ["pause_requested", "paused"],
    ["cancel_requested", "cancelled"],
  ] as const)("v4 heartbeat 在 %s 后立即中止在途物理调用并保留 %s 终态", async (controlState, expectedOutcome) => {
    const job = await layeredRun();
    let reachedPhysicalCall!: () => void;
    const physicalCallStarted = new Promise<void>((resolve) => { reachedPhysicalCall = resolve; });
    let signal: AbortSignal | undefined;
    let physicalCalls = 0;
    const processor = createAgentRunProcessor({
      db: database,
      heartbeatIntervalMs: 1,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ signal: receivedSignal, beforePhysicalOperation }) => {
        signal = receivedSignal;
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        physicalCalls += 1;
        reachedPhysicalCall();
        await new Promise<void>((resolve) => receivedSignal.addEventListener("abort", () => resolve(), { once: true }));
        return { branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const }, diagnostics: [] };
      } }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    const processing = processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    await physicalCallStarted;
    await database.update(agentRuns).set({ controlState }).where(eq(agentRuns.id, job.runId));
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));

    await expect(processing).resolves.toBe(expectedOutcome);
    expect(physicalCalls).toBe(1);
    await expect(database.select({ status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: expectedOutcome, controlState: "none" }]);
  });

  it.each([
    ["pause_requested", "paused", "cancelled_outcome"],
    ["cancel_requested", "cancelled", "stale_interruption"],
  ] as const)("v4 heartbeat 的 %s 在不利 adapter 返回后仍保留 %s", async (controlState, expectedOutcome, adapterReturn) => {
    const job = await layeredRun();
    let reachedPhysicalCall!: () => void;
    const physicalCallStarted = new Promise<void>((resolve) => { reachedPhysicalCall = resolve; });
    let signal: AbortSignal | undefined;
    let physicalCalls = 0;
    const processor = createAgentRunProcessor({
      db: database, heartbeatIntervalMs: 1,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ signal: receivedSignal, beforePhysicalOperation }) => {
        signal = receivedSignal;
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        physicalCalls += 1;
        reachedPhysicalCall();
        await new Promise<void>((resolve) => receivedSignal.addEventListener("abort", () => resolve(), { once: true }));
        if (adapterReturn === "stale_interruption") throw new LayeredPublicWorkflowInterruption("stale");
        return { branchOutcome: { trusted: "failed" as const, publicDiscovery: "failed" as const }, diagnostics: [{ scope: "provider" as const, code: "ANYSEARCH_CANCELLED", retryable: false, affectedCount: 1 }] };
      } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });

    const processing = processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    await physicalCallStarted;
    await database.update(agentRuns).set({ controlState }).where(eq(agentRuns.id, job.runId));
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));

    await expect(processing).resolves.toBe(expectedOutcome);
    expect(physicalCalls).toBe(1);
    await expect(database.select({ status: agentRuns.status, controlState: agentRuns.controlState, claimToken: agentRuns.claimToken }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: expectedOutcome, controlState: "none", claimToken: null }]);
  });

  it("v4 resolver 伪造 interruption 不能改变 run，仅按普通失败持久化脱敏 diagnostic", async () => {
    const job = await layeredRun();
    const rawProviderBody = "authorization: secret provider response body";
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({
        branchOutcome: { trusted: "failed" as const, publicDiscovery: "failed" as const },
        diagnostics: [{ scope: "provider" as const, code: "ANYSEARCH_UNAVAILABLE", retryable: true, affectedCount: 1 }],
        sourceIssues: [{ provider: "anysearch" as const, code: "ANYSEARCH_UNAVAILABLE", affectedCount: 1 }],
        interruption: "paused" as const,
        rawProviderBody,
      }) }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("retry");
    const detail = await createAgentRunQueries({ db: database }).get(job);
    expect(detail).toMatchObject({ discoveryDiagnostics: [{ scope: "provider", code: "ANYSEARCH_UNAVAILABLE", retryable: true, affectedCount: 1 }], sourceIssues: [] });
    expect(JSON.stringify(detail)).not.toContain(rawProviderBody);
    await expect(Promise.all([
      database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)),
      database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)),
      database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention"))),
    ])).resolves.toEqual([[expect.objectContaining({ code: "ANYSEARCH_UNAVAILABLE", affectedCount: 1 })], [], []]);
  });

  it("真实 pause checkpoint 在第二个 query 前保留第一项脱敏 diagnostic，且不创建 discovery attention", async () => {
    const job = await layeredRun(); const secondQueryId = crypto.randomUUID();
    const [stored] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, job.runId));
    const sourceScope = stored!.sourceScope as any;
    sourceScope.publicDiscovery.queries.push({ ...sourceScope.publicDiscovery.queries[0], ordinal: 2, queryId: secondQueryId, stableFingerprint: "b".repeat(64) });
    await database.update(agentRuns).set({ sourceScope }).where(eq(agentRuns.id, job.runId));
    let searches = 0;
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: { search: async ({ beforeRequest }) => { await beforeRequest(); searches += 1; if (searches === 1) { await database.update(agentRuns).set({ controlState: "pause_requested" }).where(eq(agentRuns.id, job.runId)); return { error: { code: "ANYSEARCH_UNAVAILABLE", retryable: true, httpStatus: 503 } }; } return { candidates: [] }; }, extract: async () => { throw new Error("UNUSED"); } },
      preflight: async () => null, leads: { recordPendingForClaim: async () => { throw new Error("UNUSED"); } }, fetcher: { fetch: async () => { throw new Error("UNUSED"); } }, gate: { verifyForClaim: async () => { throw new Error("UNUSED"); }, rejectForClaim: async () => undefined },
    });
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => workflow }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("paused");
    await expect(Promise.all([database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)), database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention"))), database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, job.runId))])).resolves.toEqual([[expect.objectContaining({ code: "ANYSEARCH_UNAVAILABLE" })], [], [{ status: "paused" }]]);
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("paused");
    await expect(database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId))).resolves.toHaveLength(1);
  });

  it("v4 active-duration deadline 在第二次操作前终止时保留 partial diagnostic 且重放不重复", async () => {
    const job = await layeredRun(); const secondQueryId = crypto.randomUUID(); let instant = now;
    const [stored] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, job.runId));
    const sourceScope = stored!.sourceScope as any;
    sourceScope.publicDiscovery.queries.push({ ...sourceScope.publicDiscovery.queries[0], ordinal: 2, queryId: secondQueryId, stableFingerprint: "d".repeat(64) });
    await database.update(agentRuns).set({ sourceScope }).where(eq(agentRuns.id, job.runId));
    let searches = 0;
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: { search: async ({ beforeRequest }) => { await beforeRequest(); searches += 1; if (searches === 1) { instant = new Date(now.getTime() + 180_000); await database.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() + 210_000) }).where(eq(agentRuns.id, job.runId)); return { error: { code: "ANYSEARCH_UNAVAILABLE", retryable: true, httpStatus: 503 } }; } return { candidates: [] }; }, extract: async () => { throw new Error("UNUSED"); } },
      preflight: async () => null, leads: { recordPendingForClaim: async () => { throw new Error("UNUSED"); } }, fetcher: { fetch: async () => { throw new Error("UNUSED"); } }, gate: { verifyForClaim: async () => { throw new Error("UNUSED"); }, rejectForClaim: async () => undefined },
    });
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => workflow }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => instant });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("budget_exhausted");
    await expect(Promise.all([database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)), database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention")))] )).resolves.toEqual([[expect.objectContaining({ code: "ANYSEARCH_UNAVAILABLE" })], []]);
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("budget_exhausted");
    await expect(database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId))).resolves.toHaveLength(1);
  });

  it("v4 workflow 忽略 abort 时仍在 active-duration deadline 内终结并保留最新 diagnostic", async () => {
    const job = await layeredRun();
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const instant = new Date();
    let nearDeadline = false;
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async (input) => {
        resolveEntered();
        nearDeadline = true;
        const onDiagnostics = (input as unknown as { onDiagnostics?: (snapshot: Array<{ scope: "provider"; code: "ANYSEARCH_UNAVAILABLE"; retryable: true; affectedCount: 1 }>) => void }).onDiagnostics;
        onDiagnostics?.([{ scope: "provider", code: "ANYSEARCH_UNAVAILABLE", retryable: true, affectedCount: 1 }]);
        return new Promise<never>(() => undefined);
      } }) },
      contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => instant }), id: () => crypto.randomUUID(), clock: () => nearDeadline ? new Date(instant.getTime() + PUBLIC_JOB_DISCOVERY_BUDGET.maxActiveDurationMs - 200) : instant, heartbeatIntervalMs: 60_000,
    });

    const processing = processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    await entered;
    await expect(processing).resolves.toBe("budget_exhausted");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
      database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)),
      database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention"))),
    ])).resolves.toEqual([
      [{ status: "failed", terminationKind: "budget_exhausted" }],
      [expect.objectContaining({ scope: "provider", code: "ANYSEARCH_UNAVAILABLE", retryable: true, affectedCount: 1 })],
      [],
    ]);
  }, 5_000);

  it.each([
    ["cancel", "cancel_requested", "cancelled", "cancelled"],
    ["budget", "budget", "budget_exhausted", "failed"],
    ["stale", "stale", "stale", "running"],
  ] as const)("真实 %s checkpoint 保留既有 diagnostic", async (_name, mode, expected, status) => {
    const job = await layeredRun(); const secondQueryId = crypto.randomUUID();
    const [stored] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, job.runId));
    const sourceScope = stored!.sourceScope as any;
    sourceScope.publicDiscovery.queries.push({ ...sourceScope.publicDiscovery.queries[0], ordinal: 2, queryId: secondQueryId, stableFingerprint: "c".repeat(64) });
    await database.update(agentRuns).set({ sourceScope }).where(eq(agentRuns.id, job.runId));
    let searches = 0;
    const workflow = createLayeredPublicJobDiscoveryWorkflow({
      trustedSources: { discover: async () => ({ succeeded: false, verifiedSourcePostingVersionIds: [] }) },
      anySearch: { search: async ({ beforeRequest }) => { await beforeRequest(); searches += 1; if (searches === 1) { if (mode === "budget") await database.update(agentRuns).set({ toolCallCount: 60 }).where(eq(agentRuns.id, job.runId)); else if (mode === "stale") await database.update(agentRuns).set({ claimToken: crypto.randomUUID(), claimExpiresAt: new Date(now.getTime() + 30_000) }).where(eq(agentRuns.id, job.runId)); else await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(eq(agentRuns.id, job.runId)); return { error: { code: "ANYSEARCH_UNAVAILABLE", retryable: true, httpStatus: 503 } }; } return { candidates: [] }; }, extract: async () => { throw new Error("UNUSED"); } },
      preflight: async () => null, leads: { recordPendingForClaim: async () => { throw new Error("UNUSED"); } }, fetcher: { fetch: async () => { throw new Error("UNUSED"); } }, gate: { verifyForClaim: async () => { throw new Error("UNUSED"); }, rejectForClaim: async () => undefined },
    });
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => workflow }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe(expected);
    await expect(Promise.all([database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)), database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention"))), database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, job.runId))])).resolves.toEqual([[expect.objectContaining({ code: "ANYSEARCH_UNAVAILABLE" })], [], [{ status }]]);
  });

  it("resolver 直接抛出的 interruption 不能伪造 checkpoint stop", async () => {
    const job = await layeredRun();
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => { throw new LayeredPublicWorkflowInterruption("paused"); } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("failed");
    await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: "failed" }]);
  });

  it("v4 旧 claim 活跃时不执行，过期后新 attempt 独立计费", async () => {
    const job = await layeredRun(); let calls = 0;
    const oldToken = crypto.randomUUID();
    await database.update(agentRuns).set({ status: "running", startedAt: now, claimToken: oldToken, claimExpiresAt: new Date(now.getTime() + 30_000), activeSliceStartedAt: now, attemptCount: 1 }).where(eq(agentRuns.id, job.runId));
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ beforePhysicalOperation }) => { calls += 1; await beforePhysicalOperation({ kind: "search", identity: job.queryId }); return { branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [] }; } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("retry");
    expect(calls).toBe(0);
    await database.update(agentRuns).set({ claimExpiresAt: new Date(now.getTime() - 1) }).where(eq(agentRuns.id, job.runId));
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect(calls).toBe(1);
    await expect(database.select({ attempts: agentRuns.attemptCount, toolCalls: agentRuns.toolCallCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ attempts: 2, toolCalls: 1 }]);
  });

  it("v4 retry 只保留诊断；后续成功不遗留 source issue 或 attention", async () => {
    const job = await layeredRun(); let retry = true;
    const processor = createAgentRunProcessor({ db: database, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => retry
      ? { branchOutcome: { trusted: "failed", publicDiscovery: "failed" }, diagnostics: [{ scope: "provider", code: "ANYSEARCH_UNAVAILABLE", retryable: true, affectedCount: 1 }], sourceIssues: [{ provider: "anysearch", code: "ANYSEARCH_UNAVAILABLE", affectedCount: 1 }] }
      : { branchOutcome: { trusted: "succeeded", publicDiscovery: "clean_zero" }, sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId], diagnostics: [] } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("retry");
    await expect(Promise.all([database.select().from(jobDiscoveryDiagnostics).where(eq(jobDiscoveryDiagnostics.runId, job.runId)), database.select().from(jobDiscoverySourceIssues).where(eq(jobDiscoverySourceIssues.runId, job.runId)), database.select().from(agentInboxItems).where(and(eq(agentInboxItems.runId, job.runId), eq(agentInboxItems.kind, "discovery_attention")))] )).resolves.toEqual([[expect.objectContaining({ code: "ANYSEARCH_UNAVAILABLE" })], [], []]);
    retry = false;
    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: false })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "completed", termination: { kind: "completed" }, sourceIssues: [] });
  });

  it("来源调用后暂停会阻止后续外部调用", async () => {
    const job = await run();
    let details = 0;
    const adapter: JobDiscoveryAdapter = {
      adapter: "fake", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "fake", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async () => {
        await database.update(agentRuns).set({ controlState: "pause_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        return { ok: true, data: [{ sourceId: "fake:aurora-careers", detailId: "opening-1", company: "示例科技", title: "AI 工程师", location: "上海", postedAt: null, deadline: null }] };
      },
      getDetail: async () => { details += 1; return { ok: false, error: { code: "UNUSED", retryable: false } }; },
    };

    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true });

    expect(outcome).toBe("paused");
    expect(details).toBe(0);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "paused", controlState: "none" });
  });

  it("领取后到达暂停时不解析或调用来源 adapter", async () => {
    const job = await run();
    const calls = { search: 0, detail: 0 };
    const durable = checkpoint();
    let first = true;
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      if (first) {
        first = false;
        await database.update(agentRuns).set({ controlState: "pause_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
      }
      return durable.check(input);
    } };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("paused");
    expect(calls).toEqual({ search: 0, detail: 0 });
  });

  it("来源调用前取消时不产生来源外部调用", async () => {
    const job = await run();
    const calls = { search: 0, detail: 0 };
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      if (input.checkpointKey.includes(":source_search_batch:1")) {
        await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
      }
      return durable.check(input);
    } };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("cancelled");
    expect(calls).toEqual({ search: 0, detail: 0 });
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "cancelled", controlState: "none" });
  });

  it("对象写入后取消会清理本 claim 的对象", async () => {
    const job = await run();
    const store = new Store();
    store.put = async ({ objectKey }) => {
      store.puts.push(objectKey);
      await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("cancelled");
    expect(store.deletes).toEqual(store.puts);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(0);
  });

  it("提交前控制使迟到的领域结果成为 stale 并清理对象", async () => {
    const job = await run();
    const store = new Store();
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      if (input.checkpointKey.includes(":domain_commit_before:1")) {
        await database.update(agentRuns).set({ controlState: "cancel_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        return { kind: "continue" };
      }
      return durable.check(input);
    } };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), checkpoint: controlled, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("stale");
    expect(store.deletes).toEqual(store.puts);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(0);
  });

  it("完成后的重复任务不重放结果或预占计费", async () => {
    const job = await run();
    const store = new Store();
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await expect(processor.process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(processor.process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("stale");
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(1);
    await expect(database.select().from(agentRunUsageEntries).where(eq(agentRunUsageEntries.runId, job.runId))).resolves.toHaveLength(5);
    await expect(database.select({ usageKey: agentRunUsageEntries.usageKey, category: agentRunUsageEntries.category, amount: agentRunUsageEntries.amount, stepKey: agentRunUsageEntries.stepKey, attemptCount: agentRunUsageEntries.attemptCount }).from(agentRunUsageEntries)
      .where(and(eq(agentRunUsageEntries.runId, job.runId), eq(agentRunUsageEntries.category, "result"))))
      .resolves.toEqual([expect.objectContaining({ amount: 1, stepKey: "persist_results", attemptCount: 1 })]);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ usage: { toolCalls: 2, sourceRequests: 2, modelCalls: 0, results: 1 } });
    await expect(database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, job.runId), eq(agentRunEvents.eventType, "run.budget_updated")))).resolves.toHaveLength(4);
  });

  it("v3 提交后的 checkpoint 异常保留已引用对象，重放不重复持久化", async () => {
    const job = await run();
    const source = { sourceId: "greenhouse:post-commit", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Post Commit", careersUrl: "https://boards.greenhouse.io/post-commit", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "post-commit" };
    await database.update(agentRuns).set({ adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: [source] } }).where(eq(agentRuns.id, job.runId));
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async () => ({ ok: true, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: ["701"], candidates: [{ sourceId: source.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }] } }),
      getSourceDetail: async () => ({ ok: true, attemptCount: 1, data: { sourceId: source.sourceId, detailId: "701", company: "Post Commit", title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, absoluteUrl: "https://boards.greenhouse.io/post-commit/jobs/701", rawPayload: { id: 701 } } }),
    };
    const durable = checkpoint();
    const afterCommitBomb: AgentRunCheckpoint = { check: async (input) => {
      if (input.checkpointKey.includes(":domain_commit_after:1")) throw new Error("post-commit checkpoint failed");
      return durable.check(input);
    } };
    const store = new Store();
    const deps = { db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any;
    await expect(createAgentRunProcessor({ ...deps, checkpoint: afterCommitBomb }).process({ version: 1, ...job, finalAttempt: true })).rejects.toThrow("post-commit checkpoint failed");
    await expect(database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: "completed", terminationKind: "completed" }]);
    await expect(database.select({ rawObjectReference: jobSourcePostingVersions.rawObjectReference }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.userId, job.userId))).resolves.toEqual([{ rawObjectReference: { objectKey: store.puts[0] } }]);
    expect(store.deletes).toEqual([]);
    const beforeReplay = await Promise.all([
      database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, job.runId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, job.runId)),
    ]);
    await expect(createAgentRunProcessor({ ...deps }).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(Promise.all([
      database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId)),
      database.select().from(agentRunEvents).where(eq(agentRunEvents.runId, job.runId)),
      database.select().from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)),
      database.select().from(auditEvents).where(eq(auditEvents.resourceId, job.runId)),
    ])).resolves.toEqual(beforeReplay);
    expect(store.deletes).toEqual([]);
  });

  it("Public v2 每个 board 列表和每个已选详情各预占一次逻辑预算，并持久完整扫描事实", async () => {
    const job = await run();
    const sources = [
      { sourceId: "greenhouse:fictional-labs", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Fictional Labs", careersUrl: "https://boards.greenhouse.io/fictional-labs", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "fictional-labs" },
      { sourceId: "greenhouse:fictional-labs-secondary", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Fictional Labs Secondary", careersUrl: "https://boards.greenhouse.io/fictional-labs-secondary", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "fictional-labs-secondary" },
    ];
    await database.update(agentRuns).set({
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
      workflowVersion: GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_JOB_DISCOVERY_RULE_VERSION,
      outputSchemaVersion: GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET,
      sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, watchlistVersion: 1, sources },
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const adapter: JobDiscoveryAdapter = {
      adapter: "greenhouse", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async (input: any) => { await input.beforeList?.(sources[0]!.sourceId); await input.beforeList?.(sources[1]!.sourceId); return { ok: true, data: { items: [{ sourceId: sources[0]!.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }], scans: [{ sourceId: sources[0]!.sourceId, observedDetailIds: ["701"], complete: true }, { sourceId: sources[1]!.sourceId, observedDetailIds: [], complete: true }] } }; },
      getDetail: async () => ({ ok: true, data: { sourceId: sources[0]!.sourceId, detailId: "701", company: "Fictional Labs", title: "AI Engineer", location: "Shanghai", postedAt: null, deadline: null, sourceType: "company_careers", isOfficial: true, rawPayload: { job: 701 } } }),
    };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ adapter: "greenhouse", usage: { toolCalls: 3, sourceRequests: 3, results: 1 } });
  });

  it("v3 healthy + hard_failed 保留成功来源并以失败来源的 owner-bound health check 写入 Inbox", async () => {
    const job = await run();
    const healthy = { sourceId: "greenhouse:healthy", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Healthy", careersUrl: "https://boards.greenhouse.io/healthy", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "healthy" };
    const failed = { sourceId: "greenhouse:failed", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Failed", careersUrl: "https://boards.greenhouse.io/failed", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "failed" };
    await database.update(agentRuns).set({
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION,
      outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST,
      budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET,
      sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: [healthy, failed] },
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const historicalPostingId = crypto.randomUUID(); const historicalVersionId = crypto.randomUUID(); const historicalOpportunityId = crypto.randomUUID();
    await database.insert(jobSourcePostings).values({ id: historicalPostingId, userId: job.userId, sourceType: "company_careers", sourceIdentifier: "a".repeat(64), sourceId: failed.sourceId, sourceIdentity: { sourceId: failed.sourceId, detailId: "historical" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: historicalVersionId, userId: job.userId, sourcePostingId: historicalPostingId, version: 1, contentSha256: "b".repeat(64), rawContentSha256: "c".repeat(64), rawObjectReference: { objectKey: "historical.json" }, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: historicalOpportunityId, userId: job.userId, importId: null, sourcePostingVersionId: historicalVersionId, dedupKey: "d".repeat(64), company: "Failed", title: "Historical", location: null, postedAt: null, deadline: null, description: null, normalizedData: {}, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId: job.userId, opportunityId: historicalOpportunityId, sourcePostingVersionId: historicalVersionId, createdAt: now });
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async ({ source }: any) => source.sourceId === failed.sourceId
        ? { ok: false, failure: { category: "hard_failed", reasonCode: "SOURCE_SERVER_ERROR", retryable: true, attemptCount: 2 } }
        : { ok: true, attemptCount: 1, data: { sourceId: healthy.sourceId, observedDetailIds: ["701"], candidates: [{ sourceId: healthy.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }] } },
      getSourceDetail: async () => ({ ok: true, attemptCount: 1, data: { sourceId: healthy.sourceId, detailId: "701", company: "Healthy", title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, absoluteUrl: "https://boards.greenhouse.io/healthy/jobs/701", rawPayload: { id: 701 } } }),
    };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any)
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: "completed", terminationKind: "completed_with_source_issues", resultCount: 1 }]);
    await expect(database.select({ status: jobSourceHealthChecks.status }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toEqual(expect.arrayContaining([{ status: "healthy" }, { status: "hard_failed" }]));
    const [failedCheck] = await database.select({ id: jobSourceHealthChecks.id }).from(jobSourceHealthChecks).where(and(eq(jobSourceHealthChecks.runId, job.runId), eq(jobSourceHealthChecks.sourceId, failed.sourceId)));
    await expect(database.select({ kind: agentInboxItems.kind, reasonCode: agentInboxItems.reasonCode, watchlistItemId: agentInboxItems.watchlistItemId, sourceHealthCheckId: agentInboxItems.sourceHealthCheckId }).from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId))).resolves.toEqual([{ kind: "source_attention", reasonCode: "SOURCE_HEALTH_ATTENTION", watchlistItemId: failed.watchlistItemId, sourceHealthCheckId: failedCheck!.id }]);
    await expect(database.select({ availability: jobSourcePostings.availability }).from(jobSourcePostings).where(eq(jobSourcePostings.id, historicalPostingId))).resolves.toEqual([{ availability: "open" }]);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ sourceChecks: expect.arrayContaining([expect.objectContaining({ status: "healthy" }), expect.objectContaining({ status: "hard_failed" })]) });
  });

  it("v3 缺少持续监控能力时不触发该来源 I/O，保留其它来源结果及完整稳定拒绝", async () => {
    const job = await run();
    const denied = { sourceId: "greenhouse:denied", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Denied", careersUrl: "https://boards.greenhouse.io/denied", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "denied" };
    const healthy = { sourceId: "greenhouse:healthy-capability", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Healthy", careersUrl: "https://boards.greenhouse.io/healthy-capability", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "healthy-capability" };
    await database.update(agentRuns).set({ adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: [denied, healthy] } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const calls = new Map<string, { list: number; detail: number }>();
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: sourceId === denied.sourceId ? ["active_discovery", "read_details"] : ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async ({ source }: any) => { const value = calls.get(source.sourceId) ?? { list: 0, detail: 0 }; value.list += 1; calls.set(source.sourceId, value); return { ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: ["701"], candidates: [{ sourceId: source.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }] } }; },
      getSourceDetail: async ({ source }: any) => { const value = calls.get(source.sourceId) ?? { list: 0, detail: 0 }; value.detail += 1; calls.set(source.sourceId, value); return { ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, detailId: "701", company: source.canonicalCompanyName, title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers" as const, isOfficial: true as const, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/701`, rawPayload: { id: 701 } } }; },
    };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    expect(calls.get(denied.sourceId) ?? { list: 0, detail: 0 }).toEqual({ list: 0, detail: 0 });
    expect(calls.get(healthy.sourceId)).toEqual({ list: 1, detail: 1 });
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "completed", termination: { kind: "completed_with_source_issues" }, results: [expect.anything()], sourceIssues: [{ provider: "greenhouse", code: "SOURCE_CAPABILITY_UNSUPPORTED", affectedCount: 1, impact: { scope: "entire_source", affectedCount: null }, retryable: false, suggestedActions: ["review_source_capabilities"] }] });
    await expect(database.select({ sourceId: jobSourceHealthChecks.sourceId }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toEqual([{ sourceId: healthy.sourceId }]);
    await expect(database.select({ kind: agentInboxItems.kind, reasonCode: agentInboxItems.reasonCode }).from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId))).resolves.toEqual([{ kind: "discovery_attention", reasonCode: "DISCOVERY_ATTENTION" }]);
  });

  it("v3 详情阶段能力收窄时丢弃该来源已累积详情，保留其它来源结果", async () => {
    const job = await run();
    const narrowed = { sourceId: "greenhouse:narrowed", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Narrowed", careersUrl: "https://boards.greenhouse.io/narrowed", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "narrowed" };
    const healthy = { sourceId: "greenhouse:healthy-after-narrow", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Healthy", careersUrl: "https://boards.greenhouse.io/healthy-after-narrow", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "healthy-after-narrow" };
    await database.update(agentRuns).set({ adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: [narrowed, healthy] } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    let narrowedDeclarations = 0;
    const detailCalls: Array<{ sourceId: string; detailId: string }> = [];
    const adapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => {
        const capabilities = sourceId === narrowed.sourceId && ++narrowedDeclarations > 2
          ? ["active_discovery", "continuous_monitoring", "safe_open_original_page"] as const
          : ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] as const;
        return { sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities };
      },
      listSource: async ({ source }: any) => ({ ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: source.sourceId === narrowed.sourceId ? ["a-1", "a-2"] : ["b-1"], candidates: (source.sourceId === narrowed.sourceId ? ["a-1", "a-2"] : ["b-1"]).map((detailId) => ({ sourceId: source.sourceId, detailId, company: null, title: "AI Engineer", location: "Shanghai" })) } }),
      getSourceDetail: async ({ source, detailId }: any) => { detailCalls.push({ sourceId: source.sourceId, detailId }); return { ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, detailId, company: source.canonicalCompanyName, title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers" as const, isOfficial: true as const, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/${detailId}`, rawPayload: { detailId } } }; },
    };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => adapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "completed", termination: { kind: "completed_with_source_issues" }, results: [expect.objectContaining({ company: healthy.canonicalCompanyName })], sourceIssues: [expect.objectContaining({ code: "SOURCE_CAPABILITY_UNSUPPORTED", affectedCount: 1 })] });
    expect(detailCalls).toEqual([{ sourceId: narrowed.sourceId, detailId: "a-1" }, { sourceId: healthy.sourceId, detailId: "b-1" }]);
    await expect(database.select({ sourceId: jobSourceHealthChecks.sourceId }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toEqual([{ sourceId: healthy.sourceId }]);
  });

  it("v3 冻结身份优先于 adapter 自称身份：全来源拒绝终止且不触发 I/O", async () => {
    const job = await run();
    const sources = ["first", "second"].map((boardToken) => ({ sourceId: `greenhouse:${boardToken}`, watchlistItemId: crypto.randomUUID(), canonicalCompanyName: boardToken, careersUrl: `https://boards.greenhouse.io/${boardToken}`, allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken }));
    await database.update(agentRuns).set({ adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    let calls = 0;
    const sourceHealthAdapter = { adapter: "greenhouse", adapterVersion: "malicious-v9", declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "malicious-v9", contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }), listSource: async () => { calls += 1; throw new Error("UNREACHABLE"); }, getSourceDetail: async () => { calls += 1; throw new Error("UNREACHABLE"); } };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("failed");
    expect(calls).toBe(0);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ status: "failed", termination: { kind: "source_failed" }, sourceIssues: expect.arrayContaining([expect.objectContaining({ code: "SOURCE_CAPABILITY_DECLARATION_MISMATCH", affectedCount: 2, retryable: false })]) });
    await expect(database.select({ kind: agentInboxItems.kind }).from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId))).resolves.toEqual(expect.arrayContaining([{ kind: "discovery_attention" }, { kind: "run_failed" }]));
  });

  it("真实 watchlist 快照排除 disabled 来源：仅 zero 仍普通完成且不创建来源关注", async () => {
    const seed = await run();
    const watchlists = createCompanyWatchlistCommands({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await watchlists.addItem({ userId: seed.userId, targetId: seed.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 0, canonicalCompanyName: "Enabled", careersUrl: "https://boards.greenhouse.io/enabled", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    const withDisabled = await watchlists.addItem({ userId: seed.userId, targetId: seed.targetId, requestId: crypto.randomUUID(), command: { expectedVersion: 1, canonicalCompanyName: "Disabled", careersUrl: "https://boards.greenhouse.io/disabled", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
    await watchlists.setItemState({ userId: seed.userId, targetId: seed.targetId, requestId: crypto.randomUUID(), itemId: withDisabled.items[1]!.itemId, command: { expectedVersion: 2, state: "disabled" } });
    const started = await createAgentRunCommands({ db: database, queue: new Queue(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, executionMode: "greenhouse", runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }) }).start({ userId: seed.userId, requestId: crypto.randomUUID(), command: { targetId: seed.targetId, idempotencyKey: crypto.randomUUID() } });
    const [frozen] = await database.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, started.runId));
    const [enabled] = (frozen!.sourceScope as { sources: Array<{ sourceId: string; watchlistItemId: string; canonicalCompanyName: string }> }).sources;
    expect(frozen!.sourceScope).toMatchObject({ sources: [{ canonicalCompanyName: "Enabled" }] });
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async () => ({ ok: true, attemptCount: 1, data: { sourceId: enabled!.sourceId, observedDetailIds: [], candidates: [] } }),
      getSourceDetail: async () => { throw new Error("UNUSED"); },
    };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, userId: seed.userId, runId: started.runId, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind }).from(agentRuns).where(eq(agentRuns.id, started.runId))).resolves.toEqual([{ status: "completed", terminationKind: "completed" }]);
    await expect(database.select({ sourceId: jobSourceHealthChecks.sourceId, status: jobSourceHealthChecks.status, watchlistItemId: jobSourceHealthChecks.watchlistItemId }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, started.runId))).resolves.toEqual([{ sourceId: enabled!.sourceId, status: "zero_valid_results", watchlistItemId: enabled!.watchlistItemId }]);
    await expect(database.select({ kind: agentInboxItems.kind }).from(agentInboxItems).where(eq(agentInboxItems.runId, started.runId))).resolves.toEqual([]);
  });

  it.each([
    [["healthy", "rate_limited"], "completed_with_source_issues", 1],
    [["healthy", "parser_degraded"], "completed_with_source_issues", 1],
    [["zero_valid_results", "hard_failed"], "completed_with_source_issues", 0],
    [["zero_valid_results", "rate_limited"], "completed_with_source_issues", 0],
    [["zero_valid_results", "parser_degraded"], "completed_with_source_issues", 0],
    [["zero_valid_results", "list_parser_degraded"], "completed_with_source_issues", 0],
    [["zero_valid_results", "zero_valid_results"], "completed", 0],
    [["hard_failed", "rate_limited"], "source_failed", 0],
    [["parser_retained", "hard_failed"], "completed_with_source_issues", 1],
    [["rate_retained"], "completed_with_source_issues", 1],
    [["hard_retained"], "completed_with_source_issues", 1],
  ] as const)("v3 真值表 %j 终止为 %s", async (outcomes, terminationKind, resultCount) => {
    const job = await run();
    const sources = outcomes.map((outcome, index) => ({ sourceId: `greenhouse:truth-${index}`, watchlistItemId: crypto.randomUUID(), canonicalCompanyName: `Truth ${index}`, careersUrl: `https://boards.greenhouse.io/truth-${index}`, allowedDomains: ["boards-api.greenhouse.io"], boardToken: `truth-${index}`, outcome }));
    await database.update(agentRuns).set({ adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: sources.map(({ outcome: _outcome, ...source }) => source) } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const historicalPostingIds = new Map<string, string>();
    for (const [index, source] of sources.entries()) {
      const postingId = crypto.randomUUID();
      historicalPostingIds.set(source.sourceId, postingId);
      await database.insert(jobSourcePostings).values({ id: postingId, userId: job.userId, sourceType: "company_careers", sourceIdentifier: `${index}`.padStart(64, "0"), sourceId: source.sourceId, sourceIdentity: { sourceId: source.sourceId, detailId: "historical" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
      await database.insert(jobSourcePostingVersions).values({ id: crypto.randomUUID(), userId: job.userId, sourcePostingId: postingId, version: 1, contentSha256: `${index}`.padStart(64, "1"), rawContentSha256: `${index}`.padStart(64, "2"), rawObjectReference: { objectKey: `truth-${index}.json` }, retrievedAt: now, availability: "open", createdAt: now });
    }
    const adapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async ({ source }: any) => {
        const scenario = sources.find((item) => item.sourceId === source.sourceId)!.outcome;
        if (scenario === "rate_limited") return { ok: false, failure: { category: "rate_limited", reasonCode: "SOURCE_RATE_LIMITED", retryable: true, attemptCount: 2 } };
        if (scenario === "hard_failed") return { ok: false, failure: { category: "hard_failed", reasonCode: "SOURCE_SERVER_ERROR", retryable: true, attemptCount: 2 } };
        if (scenario === "list_parser_degraded") return { ok: false, failure: { category: "parser_degraded", reasonCode: "SOURCE_LIST_SCHEMA_INVALID", retryable: false, attemptCount: 1 } };
        if (scenario === "zero_valid_results") return { ok: true, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: [], candidates: [] } };
        const ids = ["parser_retained", "rate_retained", "hard_retained"].includes(scenario) ? ["701", "702"] : ["701"];
        return { ok: true, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: ids, candidates: ids.map((detailId) => ({ sourceId: source.sourceId, detailId, company: null, title: "AI Engineer", location: "Shanghai" })) } };
      },
      getSourceDetail: async ({ source, detailId }: any) => {
        const scenario = sources.find((item) => item.sourceId === source.sourceId)!.outcome;
        if (scenario === "parser_degraded" || (scenario === "parser_retained" && detailId === "702")) return { ok: false, failure: { category: "parser_degraded", reasonCode: "SOURCE_DETAIL_FIELDS_MISSING", retryable: false, attemptCount: 1 } };
        if (scenario === "rate_retained" && detailId === "702") return { ok: false, failure: { category: "rate_limited", reasonCode: "SOURCE_RATE_LIMITED", retryable: true, attemptCount: 2 } };
        if (scenario === "hard_retained" && detailId === "702") return { ok: false, failure: { category: "hard_failed", reasonCode: "SOURCE_SERVER_ERROR", retryable: true, attemptCount: 2 } };
        return { ok: true, attemptCount: 1, data: { sourceId: source.sourceId, detailId, company: source.canonicalCompanyName, title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/${detailId}`, rawPayload: { detailId } } };
      },
    };
    const outcome = await createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => adapter as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, ...job, finalAttempt: true });
    expect(outcome).toBe(terminationKind === "source_failed" ? "failed" : "completed");
    await expect(database.select({ terminationKind: agentRuns.terminationKind, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ terminationKind, resultCount }]);
    const healthFacts = {
      healthy: { status: "healthy", reasonCodes: [], impactScope: "none", impactAffectedCount: null, observedPostingCount: 1, selectedDetailCount: 1, validDetailCount: 1, requestAttemptCount: 2, availability: "closed" },
      zero_valid_results: { status: "zero_valid_results", reasonCodes: [], impactScope: "none", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, availability: "closed" },
      parser_degraded: { status: "parser_degraded", reasonCodes: ["SOURCE_DETAIL_FIELDS_MISSING"], impactScope: "job_details", impactAffectedCount: 1, observedPostingCount: 1, selectedDetailCount: 1, validDetailCount: 0, requestAttemptCount: 2, availability: "open" },
      list_parser_degraded: { status: "parser_degraded", reasonCodes: ["SOURCE_LIST_SCHEMA_INVALID"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, availability: "open" },
      parser_retained: { status: "parser_degraded", reasonCodes: ["SOURCE_DETAIL_FIELDS_MISSING"], impactScope: "job_details", impactAffectedCount: 1, observedPostingCount: 2, selectedDetailCount: 2, validDetailCount: 1, requestAttemptCount: 3, availability: "open" },
      rate_retained: { status: "rate_limited", reasonCodes: ["SOURCE_RATE_LIMITED"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 2, selectedDetailCount: 2, validDetailCount: 1, requestAttemptCount: 4, availability: "open" },
      hard_retained: { status: "hard_failed", reasonCodes: ["SOURCE_SERVER_ERROR"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 2, selectedDetailCount: 2, validDetailCount: 1, requestAttemptCount: 4, availability: "open" },
      rate_limited: { status: "rate_limited", reasonCodes: ["SOURCE_RATE_LIMITED"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 2, availability: "open" },
      hard_failed: { status: "hard_failed", reasonCodes: ["SOURCE_SERVER_ERROR"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 2, availability: "open" },
    } as const;
    await expect(database.select({ sourceId: jobSourceHealthChecks.sourceId, status: jobSourceHealthChecks.status, reasonCodes: jobSourceHealthChecks.reasonCodes, impactScope: jobSourceHealthChecks.impactScope, impactAffectedCount: jobSourceHealthChecks.impactAffectedCount, observedPostingCount: jobSourceHealthChecks.observedPostingCount, selectedDetailCount: jobSourceHealthChecks.selectedDetailCount, validDetailCount: jobSourceHealthChecks.validDetailCount, requestAttemptCount: jobSourceHealthChecks.requestAttemptCount }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)).orderBy(asc(jobSourceHealthChecks.sourceId))).resolves.toEqual(sources.map((source) => {
      const { availability: _availability, ...fact } = healthFacts[source.outcome];
      return { sourceId: source.sourceId, ...fact };
    }).sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
    const persistedAvailability = await Promise.all(sources.map(async (source) => ({ sourceId: source.sourceId, availability: (await database.select({ availability: jobSourcePostings.availability }).from(jobSourcePostings).where(eq(jobSourcePostings.id, historicalPostingIds.get(source.sourceId)!)))[0]!.availability })));
    expect(persistedAvailability.sort((left, right) => left.sourceId.localeCompare(right.sourceId))).toEqual(sources.map((source) => ({ sourceId: source.sourceId, availability: healthFacts[source.outcome].availability })).sort((left, right) => left.sourceId.localeCompare(right.sourceId)));
    const issueCount = outcomes.filter((sourceOutcome) => sourceOutcome !== "healthy" && sourceOutcome !== "zero_valid_results").length;
    await expect(database.select({ kind: agentInboxItems.kind }).from(agentInboxItems).where(eq(agentInboxItems.runId, job.runId)).orderBy(asc(agentInboxItems.kind))).resolves.toEqual([...(terminationKind === "source_failed" ? [{ kind: "run_failed" }] : []), ...Array.from({ length: issueCount }, () => ({ kind: "source_attention" }))]);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(resultCount);
    if (terminationKind === "source_failed") {
      const [failedEvent] = await database.select({ sequence: agentRunEvents.sequence, runVersion: agentRunEvents.runVersion, eventType: agentRunEvents.eventType, data: agentRunEvents.data, createdAt: agentRunEvents.createdAt }).from(agentRunEvents)
        .where(and(eq(agentRunEvents.runId, job.runId), eq(agentRunEvents.eventType, "run.failed")));
      expect(AgentRunEventSchema.parse({ ...failedEvent, createdAt: failedEvent!.createdAt.toISOString() })).toMatchObject({
        eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: 1, failureCode: "AGENT_RUN_ADAPTER_FAILED" },
      });
      await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({
        events: expect.arrayContaining([expect.objectContaining({ eventType: "run.failed", data: { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: 1, failureCode: "AGENT_RUN_ADAPTER_FAILED" } })]),
      });
    }
  });

  it("v3 将跨来源有效详情按冻结顺序截断到总 maxResults，同时保留每来源健康事实", async () => {
    const job = await run();
    const sources = Array.from({ length: 5 }, (_, index) => ({
      sourceId: `greenhouse:cap-${index}`, watchlistItemId: crypto.randomUUID(), canonicalCompanyName: `Cap ${index}`,
      careersUrl: `https://boards.greenhouse.io/cap-${index}`, allowedDomains: ["boards-api.greenhouse.io"], boardToken: `cap-${index}`,
    }));
    await database.update(agentRuns).set({
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION,
      outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST,
      budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET,
      sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources },
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async ({ source }: any) => ({ ok: true, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: ["701"], candidates: [{ sourceId: source.sourceId, detailId: "701", company: null, title: "AI Engineer", location: "Shanghai" }] } }),
      getSourceDetail: async ({ source, detailId }: any) => ({ ok: true, attemptCount: 1, data: { sourceId: source.sourceId, detailId, company: source.canonicalCompanyName, title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers", isOfficial: true, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/${detailId}`, rawPayload: { detailId } } }),
    };
    const store = new Store();
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, contentStore: store, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any)
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(database.select({ status: agentRuns.status, terminationKind: agentRuns.terminationKind, resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ status: "completed", terminationKind: "completed", resultCount: 5 }]);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(5);
    await expect(database.select({ sourceId: jobSourceHealthChecks.sourceId, status: jobSourceHealthChecks.status, validDetailCount: jobSourceHealthChecks.validDetailCount }).from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId)).orderBy(asc(jobSourceHealthChecks.sourceId))).resolves.toEqual(sources.map((source) => ({ sourceId: source.sourceId, status: "healthy", validDetailCount: 1 })));
    expect(store.puts).toHaveLength(5);
    const projection = await createAgentRunQueries({ db: database }).get(job);
    expect(projection).toMatchObject({ usage: { results: 5 } });
    expect(projection!.results).toHaveLength(5);
  });

  it("v3 低结果额度在详情读取前停止，并保留每个已检查来源的健康记录", async () => {
    const job = await run();
    const sources = ["one", "two"].map((boardToken) => ({ sourceId: `greenhouse:${boardToken}`, watchlistItemId: crypto.randomUUID(), canonicalCompanyName: boardToken, careersUrl: `https://boards.greenhouse.io/${boardToken}`, allowedDomains: ["boards-api.greenhouse.io"], boardToken }));
    await database.update(agentRuns).set({ adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: { maxActiveDurationMs: 180_000, maxAttempts: 3, maxToolCalls: 60, maxResults: 1, maxModelCalls: 0, maxTokens: 0 }, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources } }).where(eq(agentRuns.id, job.runId));
    let detailCalls = 0;
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async ({ source }: any) => ({ ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: ["1"], candidates: [{ sourceId: source.sourceId, detailId: "1", company: null, title: "AI Engineer", location: "Shanghai" }] } }),
      getSourceDetail: async ({ source }: any) => { detailCalls += 1; return { ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, detailId: "1", company: source.canonicalCompanyName, title: "AI Engineer", location: "Shanghai", postedAt: "2026-08-20T00:00:00.000Z", deadline: null, sourceType: "company_careers" as const, isOfficial: true as const, absoluteUrl: `https://boards.greenhouse.io/${source.boardToken}/jobs/1`, rawPayload: {} } }; },
    };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => sourceHealthAdapter as any }, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    expect(detailCalls).toBe(1);
    await expect(database.select({ resultCount: agentRuns.resultCount }).from(agentRuns).where(eq(agentRuns.id, job.runId))).resolves.toEqual([{ resultCount: 1 }]);
    await expect(database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toHaveLength(2);
  });

  it("旧 Greenhouse 来源范围在执行前按当前 trusted hard 上限收窄", async () => {
    const job = await run();
    const sources = Array.from({ length: 51 }, (_, index) => ({ sourceId: `greenhouse:legacy-${index}`, watchlistItemId: crypto.randomUUID(), canonicalCompanyName: `Legacy ${index}`, careersUrl: `https://boards.greenhouse.io/legacy-${index}`, allowedDomains: ["boards-api.greenhouse.io"], boardToken: `legacy-${index}` }));
    await database.update(agentRuns).set({ adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: { ...PUBLIC_JOB_DISCOVERY_BUDGET, maxResults: 0 }, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources } }).where(eq(agentRuns.id, job.runId));
    let resolvedSources = 0;
    let listed = 0;
    const sourceHealthAdapter = {
      adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION,
      declareCapabilities: ({ sourceId }: { sourceId: string }) => ({ sourceId, adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, contractVersion: "source-capabilities-v1" as const, capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      listSource: async ({ source }: any) => { listed += 1; return { ok: true as const, attemptCount: 1, data: { sourceId: source.sourceId, observedDetailIds: [], candidates: [] } }; },
      getSourceDetail: async () => { throw new Error("UNUSED"); },
    };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: (input) => { resolvedSources = ((input.executionSpec as { sourceScope: { sources: unknown[] } }).sourceScope).sources.length; return sourceHealthAdapter as any; } }, checkpoint: checkpoint(), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });

    await expect(processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("completed");
    expect({ resolvedSources, listed }).toEqual({ resolvedSources: 50, listed: 50 });
  });

  it("v3 runtime malformed adapter output 仍走既有全局失败而不伪造来源健康", async () => {
    const job = await run();
    const source = { sourceId: "greenhouse:malformed", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Malformed", careersUrl: "https://boards.greenhouse.io/malformed", allowedDomains: ["boards-api.greenhouse.io"], boardToken: "malformed" };
    await database.update(agentRuns).set({ adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, workflowVersion: GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_SOURCE_HEALTH_RULE_VERSION, outputSchemaVersion: GREENHOUSE_SOURCE_HEALTH_OUTPUT_SCHEMA_VERSION, toolAllowlist: GREENHOUSE_SOURCE_HEALTH_TOOL_ALLOWLIST, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, watchlistVersion: 1, sources: [source] } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const malformed = { adapter: "greenhouse", adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION, listSource: async () => ({ ok: true, attemptCount: 0, data: { sourceId: source.sourceId, observedDetailIds: [], candidates: [] } }), getSourceDetail: async () => { throw new Error("UNUSED"); } };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), sourceHealthAdapterResolver: { resolve: () => malformed as any }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now } as any).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("failed");
    await expect(database.select().from(jobSourceHealthChecks).where(eq(jobSourceHealthChecks.runId, job.runId))).resolves.toHaveLength(0);
    const detail = await createAgentRunQueries({ db: database }).get(job);
    expect(AgentRunDetailSchema.parse(detail)).toMatchObject({ status: "failed", sourceChecks: [] });
  });

  it("Public v2 detail failure 在 complete scan 后不进入 lifecycle persistence", async () => {
    const job = await run();
    const source = { sourceId: "greenhouse:detail-failure", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Failure", careersUrl: "https://boards.greenhouse.io/detail-failure", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "detail-failure" };
    const postingId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const opportunityId = crypto.randomUUID(); const evidenceId = crypto.randomUUID();
    await database.insert(jobSourcePostings).values({ id: postingId, userId: job.userId, sourceType: "company_careers", sourceIdentifier: "d".repeat(64), sourceId: source.sourceId, sourceIdentity: { sourceId: source.sourceId, detailId: "historical" }, applicationDeadline: null, isOfficial: true, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourcePostingVersions).values({ id: versionId, userId: job.userId, sourcePostingId: postingId, version: 1, contentSha256: "e".repeat(64), rawContentSha256: "f".repeat(64), rawObjectReference: { objectKey: "historical.json" }, retrievedAt: now, availability: "open", createdAt: now });
    await database.insert(jobOpportunities).values({ id: opportunityId, userId: job.userId, importId: null, sourcePostingVersionId: versionId, dedupKey: "a".repeat(64), company: "Failure", title: "Historical role", location: null, postedAt: null, deadline: null, description: null, normalizedData: { sourceId: source.sourceId, detailId: "historical" }, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobOpportunitySources).values({ id: evidenceId, userId: job.userId, opportunityId, sourcePostingVersionId: versionId, createdAt: now });
    await database.update(agentRuns).set({ adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, workflowVersion: GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_JOB_DISCOVERY_RULE_VERSION, outputSchemaVersion: GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION, budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET, sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, watchlistVersion: 1, sources: [source] } }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const adapter: JobDiscoveryAdapter = { adapter: "greenhouse", adapterVersion: "test", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }), search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }), searchBatch: async (input: any) => { await input.beforeList(source.sourceId); return { ok: true, data: { items: [{ sourceId: source.sourceId, detailId: "missing", company: null, title: "AI Engineer", location: null }], scans: [{ sourceId: source.sourceId, observedDetailIds: ["missing"], complete: true }] } }; }, getDetail: async () => ({ ok: false, error: { code: "DETAIL_FAILED", retryable: true } }) };
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now }).process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("retry");
    await expect(database.select({ id: jobSourcePostings.id, availability: jobSourcePostings.availability }).from(jobSourcePostings).where(eq(jobSourcePostings.id, postingId))).resolves.toEqual([{ id: postingId, availability: "open" }]);
    await expect(database.select({ id: jobOpportunities.id, availability: jobOpportunities.availability }).from(jobOpportunities).where(eq(jobOpportunities.id, opportunityId))).resolves.toEqual([{ id: opportunityId, availability: "open" }]);
    await expect(database.select({ id: jobSourcePostingVersions.id }).from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.sourcePostingId, postingId))).resolves.toEqual([{ id: versionId }]);
    await expect(database.select({ id: jobOpportunitySources.id, sourcePostingVersionId: jobOpportunitySources.sourcePostingVersionId }).from(jobOpportunitySources).where(eq(jobOpportunitySources.opportunityId, opportunityId))).resolves.toEqual([{ id: evidenceId, sourcePostingVersionId: versionId }]);
    await expect(database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, job.runId))).resolves.toHaveLength(0);
  });

  it.each([
    ["首板失败", "failure", "failed", 1, 1],
    ["首板后暂停", "pause", "paused", 1, 1],
    ["预算只够首板", "budget", "budget_exhausted", 1, 1],
  ] as const)("Public v2 %s 时，预算只在实际列表 GET 前扣除", async (_label, mode, expectedOutcome, expectedGets, expectedRequests) => {
    const job = await run();
    const sources = [
      { sourceId: "greenhouse:budget-first", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "First", careersUrl: "https://boards.greenhouse.io/budget-first", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "budget-first" },
      { sourceId: "greenhouse:budget-second", watchlistItemId: crypto.randomUUID(), canonicalCompanyName: "Second", careersUrl: "https://boards.greenhouse.io/budget-second", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], boardToken: "budget-second" },
    ];
    await database.update(agentRuns).set({
      adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION,
      workflowVersion: GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, ruleVersion: GREENHOUSE_JOB_DISCOVERY_RULE_VERSION,
      outputSchemaVersion: GREENHOUSE_JOB_DISCOVERY_OUTPUT_SCHEMA_VERSION,
      budgetSnapshot: PUBLIC_JOB_DISCOVERY_BUDGET,
      sourceScope: { kind: "company_watchlist", adapter: "greenhouse", adapterVersion: GREENHOUSE_JOB_DISCOVERY_ADAPTER_VERSION, watchlistVersion: 1, sources },
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    let gets = 0;
    const adapter: JobDiscoveryAdapter = {
      adapter: "greenhouse", adapterVersion: "test",
      declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "test", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] }),
      search: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
      searchBatch: async (input: any) => {
        await input.beforeList(sources[0].sourceId);
        gets += 1;
        if (mode === "failure") return { ok: false, error: { code: "FIRST_LIST_FAILED", retryable: false } };
        if (mode === "pause") await database.update(agentRuns).set({ controlState: "pause_requested" }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
        await input.beforeList(sources[1].sourceId);
        gets += 1;
        return { ok: true, data: { items: [], scans: sources.map((source) => ({ sourceId: source.sourceId, observedDetailIds: [], complete: true })) } };
      },
      getDetail: async () => ({ ok: false, error: { code: "UNUSED", retryable: false } }),
    };
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = mode === "budget" ? { check: async (input) => input.checkpointKey.endsWith(":source_search_batch:2")
      ? { kind: "budget_exhausted", budgetDimension: "tool_calls" }
      : durable.check(input) } : durable;

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(adapter), checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe(expectedOutcome);
    expect(gets).toBe(expectedGets);
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ usage: { sourceRequests: expectedRequests, toolCalls: expectedRequests } });
  });

  it("冻结 execution spec 的 model 为 null 时不产生模型调用计费", async () => {
    const job = await run();
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("completed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({ executionSpec: { model: null }, usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  });

  it("冻结 adapter 解析失败会按不可重试来源失败终止，而不遗留 running claim", async () => {
    const job = await run();
    const processor = createAgentRunProcessor({
      db: database,
      adapterResolver: { resolve: () => { throw new Error("AGENT_RUN_ADAPTER_UNSUPPORTED"); } },
      contentStore: new Store(),
      auditTrail: createAuditTrail({ db: database, clock: () => now }),
      id: () => crypto.randomUUID(),
      clock: () => now,
    });

    await expect(processor.process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("failed");
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({
      status: "failed", failureCode: "AGENT_RUN_ADAPTER_FAILED", currentStep: "failed",
    });
  });

  it("processor transaction afterCompleted warning 在 running 创建 child；trigger replay 在当前 blocker 前复用快照", async () => {
    const parent = await run(); const real = await realDeepMatchPreflight(parent.userId); const observer = createDatabase(container.getConnectionUri()); const trace: Array<{ workflow: string; trigger: string; status: string }> = []; let currentlyBlocked = false;
    const warning = { evaluate: async (tx: Database, input: any) => {
      const [seen] = await observer.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, parent.runId)); trace.push({ workflow: input.workflow, trigger: input.trigger, status: seen!.status }); const evaluation = await real.evaluate(tx, input);
      return currentlyBlocked ? { ...evaluation, report: { ...evaluation.report, status: "blocked" as const, warningFingerprint: null, items: [...evaluation.report.items, { code: "MODEL_DIAGNOSTIC_UNAVAILABLE", severity: "blocking" as const, summary: "blocked", impact: "blocked", retryable: false, suggestedActions: ["run_model_diagnostic"], evidence: { kind: "model_diagnostic", status: "unverified", checkedAt: null } }] } } : { ...evaluation, report: { ...evaluation.report, status: "ready_with_warnings" as const, warningFingerprint: "c".repeat(64), items: [...evaluation.report.items, { code: "SOURCE_HEALTH_UNCHECKED", severity: "warning" as const, summary: "warning", impact: "warning", retryable: true, suggestedActions: ["review_source_health"], evidence: { kind: "source_health", checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null } }] } };
    } };
    const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, runPreflight: warning as any });
    try { await expect(processor.process({ version: 1, ...parent, finalAttempt: true })).resolves.toBe("completed"); currentlyBlocked = true;
      await expect(triggerDeepMatchAfterDiscovery({ db: database, id: () => crypto.randomUUID(), clock: () => now, runPreflight: warning as any, queue: new Queue(), userId: parent.userId, targetId: parent.targetId, discoveryRunId: parent.runId })).resolves.toMatchObject({ kind: "created", reused: true });
    } finally { await observer.$client.end(); }
    expect(trace).toEqual([{ workflow: "deep_match", trigger: "automatic", status: "running" }]);
    const children = await database.select({ preflight: agentRuns.preflightSnapshot, policy: agentRuns.accountPolicySnapshot }).from(agentRuns).where(and(eq(agentRuns.userId, parent.userId), eq(agentRuns.workflowVersion, "deep-match-v1")));
    expect(children).toEqual([{ preflight: expect.objectContaining({ status: "ready_with_warnings", warningFingerprint: "c".repeat(64) }), policy: (await real.evaluate(database, { userId: parent.userId, targetId: parent.targetId, workflow: "deep_match", trigger: "automatic" })).policy.snapshot }]);
  });

  it("processor automatic evaluator 的未知错误走原持久化失败语义，不伪装为 blocker", async () => {
    const parent = await run(); const processor = createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter()), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, runPreflight: { evaluate: async () => { throw new Error("unexpected-preflight"); } } as any });
    await expect(processor.process({ version: 1, ...parent, finalAttempt: true })).resolves.toBe("retry");
    await expect(database.select({ status: agentRuns.status, failure: agentRuns.failureCode }).from(agentRuns).where(eq(agentRuns.id, parent.runId))).resolves.toEqual([{ status: "queued", failure: null }]);
    await expect(database.select().from(agentRuns).where(and(eq(agentRuns.userId, parent.userId), eq(agentRuns.workflowVersion, "deep-match-v1")))).resolves.toHaveLength(0);
  });

  it.each(["cancel_requested", "pause_requested"] as const)("过期 lease 的 %s 先于 attempts/active budget 被处理", async (controlState) => {
    const job = await run();
    const oldToken = crypto.randomUUID();
    await database.update(agentRuns).set({
      status: "running", currentStep: "batch_search", controlState, attemptCount: 3,
      startedAt: new Date(now.getTime() - 30_000), activeDurationMs: 60_000, claimToken: oldToken, claimExpiresAt: new Date(now.getTime() - 1), activeSliceStartedAt: new Date(now.getTime() - 30_000),
    }).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.id, job.runId)));
    const calls = { search: 0, detail: 0 };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe(controlState === "cancel_requested" ? "cancelled" : "paused");
    expect(calls).toEqual({ search: 0, detail: 0 });
    await expect(createAgentRunQueries({ db: database }).get(job)).resolves.toMatchObject({
      status: controlState === "cancel_requested" ? "cancelled" : "paused",
      controlState: "none",
      termination: controlState === "cancel_requested" ? { kind: "cancelled_by_user" } : null,
    });
  });

  it("账户停止时 processor 不领取 queued run、也不增加 attempt 或调用 adapter", async () => {
    const job = await run(); const calls = { search: 0, detail: 0 };
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(control.get({ userId: job.userId })).resolves.toMatchObject({ stoppedAt: expect.any(String) });
    // 独立模拟账户行已停止、但旧 worker 仍看见 queued 行的竞态。
    await database.update(agentRuns).set({ status: "queued", controlState: "none", claimToken: null, claimExpiresAt: null, attemptCount: 0 }).where(eq(agentRuns.id, job.runId));
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("paused");
    expect(calls).toEqual({ search: 0, detail: 0 });
    await expect(database.select({ status: agentRuns.status, attemptCount: agentRuns.attemptCount }).from(agentRuns).where(eq(agentRuns.id, job.runId)))
      .resolves.toEqual([{ status: "paused", attemptCount: 0 }]);
  });

  it.each(["pause_requested", "cancel_requested"] as const)("账户停止后过期 claim 以旧 token 收敛 %s 而不 takeover", async (controlState) => {
    const job = await run(); const oldToken = crypto.randomUUID(); const calls = { search: 0, detail: 0 };
    await database.update(agentRuns).set({ status: "running", currentStep: "batch_search", controlState: "none", attemptCount: 1, startedAt: new Date(now.getTime() - 30_000), claimToken: oldToken, claimExpiresAt: new Date(now.getTime() - 1), activeSliceStartedAt: new Date(now.getTime() - 30_000) }).where(eq(agentRuns.id, job.runId));
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await expect(control.get({ userId: job.userId })).resolves.toMatchObject({ stoppedAt: expect.any(String) });
    // 模拟 controller 写入与旧 worker recovery 之间的已丢失 run-level pause 标记。
    await database.update(agentRuns).set({ controlState: controlState === "pause_requested" ? "none" : controlState }).where(eq(agentRuns.id, job.runId));
    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe(controlState === "cancel_requested" ? "cancelled" : "paused");
    expect(calls).toEqual({ search: 0, detail: 0 });
    await expect(database.select({ status: agentRuns.status, attemptCount: agentRuns.attemptCount, claimToken: agentRuns.claimToken }).from(agentRuns).where(eq(agentRuns.id, job.runId)))
      .resolves.toEqual([{ status: controlState === "cancel_requested" ? "cancelled" : "paused", attemptCount: 1, claimToken: null }]);
  });

  it("账户停止且 run pause 标记丢失后 stepTransition 不再推进步骤", async () => {
    const job = await run(); const calls = { search: 0, detail: 0 }; let stopped = false;
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      if (!stopped && input.checkpointKey.endsWith(":claim:1")) {
        stopped = true;
        await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
        await database.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, job.runId));
      }
      return outcome;
    } };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(successAdapter(calls)), checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, heartbeatRenew: async () => true })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("paused");
    expect(calls).toEqual({ search: 0, detail: 0 });
    await expect(Promise.all([
      database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
      database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(and(eq(agentRunEvents.runId, job.runId), eq(agentRunEvents.eventType, "step.started"))),
    ])).resolves.toEqual([[{ status: "paused" }], []]);
  });

  it("账户停止且 run pause 标记丢失后 failOrRetry 不重新入队", async () => {
    const job = await run(); let stopped = false;
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      if (!stopped && input.checkpointKey.includes(":source_search_batch:1")) {
        stopped = true;
        await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
        await database.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, job.runId));
      }
      return outcome;
    } };
    const retryableFailure = { ...successAdapter(), searchBatch: async () => { throw new Error("TEMPORARY"); } };

    await expect(createAgentRunProcessor({ db: database, adapterResolver: resolver(retryableFailure), checkpoint: controlled, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, heartbeatRenew: async () => true })
      .process({ version: 1, ...job, finalAttempt: true })).resolves.toBe("paused");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, attemptCount: agentRuns.attemptCount }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
      database.select({ eventType: agentRunEvents.eventType }).from(agentRunEvents).where(and(eq(agentRunEvents.runId, job.runId), eq(agentRunEvents.eventType, "run.retry_scheduled"))),
    ])).resolves.toEqual([[{ status: "paused", attemptCount: 1 }], []]);
  });

  it("账户停止且 run pause 标记丢失时 renewClaim 中止在途物理调用", async () => {
    const job = await layeredRun(); let reachedPhysicalCall!: () => void; let signal: AbortSignal | undefined;
    const physicalCallStarted = new Promise<void>((resolve) => { reachedPhysicalCall = resolve; });
    const processor = createAgentRunProcessor({
      db: database, heartbeatIntervalMs: 50, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } },
      layeredPublicWorkflowResolver: { resolve: () => ({ run: async ({ signal: receivedSignal, beforePhysicalOperation }) => {
        signal = receivedSignal;
        await beforePhysicalOperation({ kind: "search", identity: job.queryId });
        reachedPhysicalCall();
        await Promise.race([new Promise<void>((resolve) => receivedSignal.addEventListener("abort", () => resolve(), { once: true })), new Promise<void>((resolve) => setTimeout(resolve, 200))]);
        return { branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const }, diagnostics: [] };
      } }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now,
    });
    const processing = processor.process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true });
    await physicalCallStarted;
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await database.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, job.runId));

    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 150 });
    await expect(processing).resolves.toBe("paused");
  });

  it("账户停止且 run pause 标记丢失后 layered outcome 不写结果或 child", async () => {
    const job = await layeredRun(); let stopped = false;
    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      if (!stopped && input.checkpointKey.includes(":step_persist_results_start:1")) {
        stopped = true;
        await control.control({ userId: job.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
        await database.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, job.runId));
      }
      return outcome;
    } };
    await expect(createAgentRunProcessor({ db: database, checkpoint: controlled, adapterResolver: { resolve: () => { throw new Error("UNUSED"); } }, layeredPublicWorkflowResolver: { resolve: () => ({ run: async () => ({ branchOutcome: { trusted: "succeeded" as const, publicDiscovery: "clean_zero" as const }, diagnostics: [], sourcePostingVersionIds: [job.sourcePostingVersionId], trustedSourcePostingVersionIds: [job.sourcePostingVersionId] }) }) }, contentStore: new Store(), auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now, heartbeatRenew: async () => true })
      .process({ version: 1, userId: job.userId, runId: job.runId, finalAttempt: true })).resolves.toBe("stale");
    await expect(Promise.all([
      database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, job.runId)),
      database.select().from(agentRuns).where(and(eq(agentRuns.userId, job.userId), eq(agentRuns.workflowVersion, "deep-match-v1"))),
      database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, job.runId)),
    ])).resolves.toEqual([[], [], [{ status: "running" }]]);
  });

  it.each(["fake", "greenhouse", "layered_public"] as const)("%s 推荐根在最后 checkpoint 后等待账户锁且 lease 过期时不写完成事实", async (executionMode) => {
    const root = await recommendationRoot(executionMode);
    const lockDatabase = createDatabase(container.getConnectionUri());
    const finalCheckpointEntered = deferred(); const releaseFinalCheckpoint = deferred(); const locked = deferred(); const release = deferred();
    let clockNow = now;
    let finalCheckpointReturned = false;
    const durable = checkpoint();
    const controlled: AgentRunCheckpoint = { check: async (input) => {
      const outcome = await durable.check(input);
      const isFinalCheckpoint = executionMode === "layered_public"
        ? input.checkpointKey.includes(":step_persist_results_start:1")
        : input.checkpointKey.includes(":domain_commit_before:1");
      if (isFinalCheckpoint) {
        expect(outcome.kind).toBe("continue");
        finalCheckpointEntered.resolve();
        await releaseFinalCheckpoint.promise;
        finalCheckpointReturned = true;
      }
      return outcome;
    } };
    const processing = recommendationProcessor({ executionMode, auditTrail: createAuditTrail({ db: database, clock: () => now }), clock: () => clockNow, checkpoint: controlled })
      .process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true });
    let lock: Promise<unknown> | undefined;
    try {
      await waitForBarrier({ barrier: finalCheckpointEntered.promise, operation: processing, name: `${executionMode} final completion checkpoint` });
      lock = lockDatabase.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${root.userId}, 0))`);
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      releaseFinalCheckpoint.resolve();
      await vi.waitFor(() => expect(finalCheckpointReturned).toBe(true), { timeout: 2_000 });
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(database);
      const [beforeCompletion] = await database.select({ claimToken: agentRuns.claimToken }).from(agentRuns).where(eq(agentRuns.id, root.runId));
      expect(beforeCompletion?.claimToken).toEqual(expect.any(String));
      clockNow = new Date(now.getTime() + 30_001);
      release.resolve();
      await lock;
      await expect(processing).resolves.toBe("stale");
      await expect(Promise.all([
        database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, root.runId)),
        database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, root.runId)),
        database.select().from(jobTriageVersions).where(eq(jobTriageVersions.userId, root.userId)),
        database.select({ status: agentRuns.status, claimToken: agentRuns.claimToken }).from(agentRuns).where(eq(agentRuns.id, root.runId)),
        database.select().from(agentRuns).where(and(eq(agentRuns.parentRunId, root.runId), eq(agentRuns.runPurpose, "recommendation"))),
        database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, root.runId), eq(agentRunEvents.eventType, "run.completed"))),
      ])).resolves.toEqual([[], [], [], [{ status: "running", claimToken: beforeCompletion!.claimToken }], [], []]);
    } finally {
      releaseFinalCheckpoint.resolve();
      release.resolve();
      await lock?.catch(() => undefined);
      await processing.catch(() => undefined);
      await lockDatabase.$client.end();
    }
  });

  it.each(["fake", "greenhouse", "layered_public"] as const)("%s 推荐根在 stop 先持有账户锁时不完成 root、冻结 triage 或创建 child", async (executionMode) => {
    const root = await recommendationRoot(executionMode);
    const collectionEntered = deferred(); const releaseCollection = deferred(); const stopEntered = deferred(); const releaseStop = deferred();
    const stopDatabase = createDatabase(container.getConnectionUri());
    const observerDatabase = createDatabase(container.getConnectionUri());
    const stopAudit = (() => {
      const base = createAuditTrail({ db: stopDatabase, clock: () => now });
      return {
        append: (event: any) => base.append(event),
        bind(transaction: any) {
          const bound = base.bind(transaction);
          return { append: async (event: any) => {
            await bound.append(event);
            if (event.eventType === "account.run_stopped") { stopEntered.resolve(); await releaseStop.promise; }
          }, bind: bound.bind, query: bound.query };
        },
        query: (input: any) => base.query(input),
      };
    })();
    const controls = createAccountRunControl({ db: stopDatabase, auditTrail: stopAudit as any, id: () => crypto.randomUUID(), clock: () => now });
    const processing = recommendationProcessor({ executionMode, auditTrail: createAuditTrail({ db: database, clock: () => now }), collectionEntered, releaseCollection })
      .process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true });
    let stop: Promise<unknown> | undefined;
    try {
      await waitForBarrier({ barrier: collectionEntered.promise, operation: processing, name: `${executionMode} stop-first collection` });
      stop = controls.control({ userId: root.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
      await stopEntered.promise;
      const processingResult = processing.then((outcome) => ({ outcome }), (error) => ({ error }));
      releaseCollection.resolve();
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);

      releaseStop.resolve();
      await expect(stop).resolves.toMatchObject({ applied: true, state: { stoppedAt: expect.any(String) } });
      await expect(processingResult).resolves.toMatchObject({ outcome: expect.stringMatching(/^(paused|stale)$/u) });
      await expect(Promise.all([
        database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, root.runId)),
        database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, root.runId)),
        database.select().from(jobDiscoveryRunResults).where(eq(jobDiscoveryRunResults.runId, root.runId)),
        database.select().from(jobTriageVersions).where(eq(jobTriageVersions.userId, root.userId)),
        database.select().from(agentRuns).where(eq(agentRuns.parentRunId, root.runId)),
      ])).resolves.toEqual([[{ status: "paused" }], [], [], [], []]);

      await expect(controls.control({ userId: root.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 1, action: "release" } })).resolves.toMatchObject({ applied: true });
      await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, root.runId))).resolves.toEqual([{ status: "paused" }]);
    } finally {
      releaseCollection.resolve();
      releaseStop.resolve();
      await Promise.allSettled([processing, ...(stop ? [stop] : [])]);
      await stopDatabase.$client.end();
      await observerDatabase.$client.end();
    }
  }, 60_000);

  it.each(["fake", "greenhouse", "layered_public"] as const)("%s 推荐根先提交 handoff 后，stop 看到并暂停唯一 child，release 不自动恢复", async (executionMode) => {
    const root = await recommendationRoot(executionMode);
    const handoffEntered = deferred(); const releaseHandoff = deferred(); const enqueued: string[] = [];
    const stopDatabase = createDatabase(container.getConnectionUri());
    const observerDatabase = createDatabase(container.getConnectionUri());
    const processor = recommendationProcessor({
      executionMode,
      auditTrail: auditThatPausesAfter("agent.run_completed", handoffEntered, releaseHandoff),
      matchingQueue: { enqueue: async (job) => { enqueued.push(job.runId); } },
    });
    const processing = processor.process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true });
    let stop: Promise<unknown> | undefined;
    try {
      await waitForBarrier({ barrier: handoffEntered.promise, operation: processing, name: `${executionMode} handoff-first completion` });
      const controls = createAccountRunControl({ db: stopDatabase, auditTrail: createAuditTrail({ db: stopDatabase, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
      stop = controls.control({ userId: root.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
      const stopResult = stop.then((value) => ({ value }), (error) => ({ error }));
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);

      releaseHandoff.resolve();
      await expect(processing).resolves.toBe("completed");
      await expect(stopResult).resolves.toMatchObject({ value: { applied: true, state: { stoppedAt: expect.any(String) } } });
      const [child] = await database.select({ id: agentRuns.id, status: agentRuns.status, controlState: agentRuns.controlState }).from(agentRuns).where(eq(agentRuns.parentRunId, root.runId));
      expect(child).toEqual(expect.objectContaining({ status: "paused", controlState: "none" }));
      await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, root.runId))).resolves.toEqual([{ status: "completed" }]);
      await expect(database.select().from(agentRuns).where(eq(agentRuns.parentRunId, root.runId))).resolves.toHaveLength(1);

      const queuedBeforeRelease = [...enqueued];
      await expect(controls.control({ userId: root.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 1, action: "release" } })).resolves.toMatchObject({ applied: true });
      await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, child!.id))).resolves.toEqual([{ status: "paused" }]);
      expect(enqueued).toEqual(queuedBeforeRelease);
    } finally {
      releaseHandoff.resolve();
      await Promise.allSettled([processing, ...(stop ? [stop] : [])]);
      await stopDatabase.$client.end();
      await observerDatabase.$client.end();
    }
  }, 60_000);

  it("handoff 的 triage 审计依赖抛错时回滚 root results、triage、child 和 root 完成事实", async () => {
    const root = await recommendationRoot("fake");
    const base = createAuditTrail({ db: database, clock: () => now });
    const failingAudit = {
      append: (event: any) => base.append(event),
      bind(transaction: any) {
        const bound = base.bind(transaction);
        return {
          append: async (event: any) => {
            await bound.append(event);
            if (event.eventType === "job.triage_created") throw new Error("TRIAGE_AUDIT_DEPENDENCY_FAILED");
          },
          bind: bound.bind,
          query: bound.query,
        };
      },
      query: (input: any) => base.query(input),
    };

    await expect(recommendationProcessor({ executionMode: "fake", auditTrail: failingAudit }).process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: false })).resolves.toBe("retry");
    await expect(Promise.all([
      database.select({ status: agentRuns.status, currentStep: agentRuns.currentStep }).from(agentRuns).where(eq(agentRuns.id, root.runId)),
      database.select().from(agentRunJobResults).where(eq(agentRunJobResults.runId, root.runId)),
      database.select().from(jobTriageVersions).where(eq(jobTriageVersions.userId, root.userId)),
      database.select().from(agentRuns).where(eq(agentRuns.parentRunId, root.runId)),
      database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, root.runId), eq(agentRunEvents.eventType, "run.completed"))),
    ])).resolves.toEqual([[{ status: "queued", currentStep: "persist_results" }], [], [], [], []]);
  });

  it("child 的入队失败由持久 queued 行恢复；stop 后旧恢复消息只能暂停 child", async () => {
    const root = await recommendationRoot("fake");
    const failedQueue: string[] = [];
    await expect(recommendationProcessor({ executionMode: "fake", auditTrail: createAuditTrail({ db: database, clock: () => now }), matchingQueue: { enqueue: async (job) => { failedQueue.push(job.runId); throw new Error("QUEUE_UNAVAILABLE"); } } }).process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true })).resolves.toBe("completed");
    const [child] = await database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.parentRunId, root.runId));
    expect(failedQueue).toEqual([child!.id]);
    await expect(createAgentRunRecoveryQueries({ db: database, clock: () => now }).listRecoverable()).resolves.toContainEqual({ version: 1, runId: child!.id, userId: root.userId });

    const control = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
    await control.control({ userId: root.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await database.update(agentRuns).set({ status: "queued", controlState: "none" }).where(eq(agentRuns.id, child!.id));
    await expect(recommendationProcessor({ executionMode: "fake", auditTrail: createAuditTrail({ db: database, clock: () => now }) }).process({ version: 1, userId: root.userId, runId: child!.id, finalAttempt: true })).resolves.toBe("paused");
    await expect(database.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, child!.id))).resolves.toEqual([{ status: "paused" }]);
  });

  it("同一 completed root 的重复消息和恢复只复用一个 child、候选快照与 queued 事件", async () => {
    const root = await recommendationRoot("fake");
    const enqueued: string[] = [];
    const processor = recommendationProcessor({ executionMode: "fake", auditTrail: createAuditTrail({ db: database, clock: () => now }), matchingQueue: { enqueue: async (job) => { enqueued.push(job.runId); } } });
    await expect(processor.process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true })).resolves.toBe("completed");
    await expect(processor.process({ version: 1, userId: root.userId, runId: root.runId, finalAttempt: true })).resolves.toBe("stale");
    await triggerDeepMatchAfterDiscovery({ db: database, id: () => crypto.randomUUID(), clock: () => now, runPreflight: createReadyRunPreflightEvaluator({ clock: () => now }), queue: { enqueue: async (job) => { enqueued.push(job.runId); } }, userId: root.userId, targetId: root.targetId, discoveryRunId: root.runId });
    const [child] = await database.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.parentRunId, root.runId));
    await expect(Promise.all([
      database.select().from(agentRuns).where(eq(agentRuns.parentRunId, root.runId)),
      database.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, child!.id)),
      database.select().from(agentRunEvents).where(and(eq(agentRunEvents.runId, child!.id), eq(agentRunEvents.eventType, "run.queued"))),
    ])).resolves.toEqual([[expect.any(Object)], [], [expect.any(Object)]]);
    expect(enqueued).toEqual([child!.id, child!.id]);
  });
});
