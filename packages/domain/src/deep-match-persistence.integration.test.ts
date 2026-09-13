import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentInboxItems, agentRuns, calibrationProposalRevisions, calibrationProposals, createDatabase, deepMatchRunCandidates, jobAccounts, jobMatchVersions, jobOpportunities, jobOpportunitySources, jobProfiles, jobSourcePostingVersions, jobSourcePostings, recommendationListItems, recommendationLists, recommendationRuleVersions,
  firstRecommendationJourneyCompletions, jobTargetRevisions, jobTargets, jobTriageVersions, migrateDatabase, profileFactRevisions, profileFacts, recommendationExclusions, type Database,
} from "@job-copilot/database";
import { and, eq, sql } from "drizzle-orm";
import { DeepMatchCandidateSchema, FakeDeepMatchAdapter } from "@job-copilot/contracts/deep-match";
import { JobTargetConstraintsSchema } from "@job-copilot/contracts/job-targets";
import { createDeepMatchRunStarter as createDomainDeepMatchRunStarter, ensureDeepMatchRunInTransaction } from "./deep-match-agent-runs";
import { createAgentRunRecoveryQueries } from "./agent-run-processor";
import { createDeepMatchCommands, createDeepMatchQueries } from "./deep-match-persistence";
import { createAccountRunControl } from "./account-run-control";
import { createAuditTrail, type AuditTrail } from "./audit-trail";
import { RunPreflightRejectedError, type RunPreflightEvaluator } from "./run-preflight";
import { createReadyRunPreflightEvaluator } from "./testing/run-preflight";
import { RunPreflightReportSchema } from "@job-copilot/contracts/run-preflight";

const now = new Date("2026-09-01T02:00:00.000Z");
const hash = "a".repeat(64);
const modelCall = () => ({ signal: new AbortController().signal, usageKey: "test-model-call", budget: { maxTokens: 20_000, reservedInputTokens: 32, reservedOutputTokens: 48 } });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
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

function createDeepMatchRunStarter(deps: Omit<Parameters<typeof createDomainDeepMatchRunStarter>[0], "runPreflight"> & { runPreflight?: Parameters<typeof createDomainDeepMatchRunStarter>[0]["runPreflight"] }) {
  return createDomainDeepMatchRunStarter({ ...deps, runPreflight: deps.runPreflight ?? createReadyRunPreflightEvaluator({ clock: deps.clock }) });
}

describe("deep match persistence", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDatabase(container.getConnectionUri());
    await migrateDatabase(db);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  it("does not export the private staging command to package consumers", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
    expect(manifest.exports["./deep-match-persistence"]).toBeUndefined();
    expect(manifest.exports["./recommendation-queries"]).toBeDefined();
  });

  async function fixture(input: { score?: number; verdict?: "pass" | "fail"; deadlineStatus?: "valid" | "expired"; owner?: { userId: string; profileId: string; targetId: string } } = {}) {
    const userId = input.owner?.userId ?? crypto.randomUUID();
    const profileId = input.owner?.profileId ?? crypto.randomUUID();
    const targetId = input.owner?.targetId ?? crypto.randomUUID();
    const sourcePostingId = crypto.randomUUID();
    const sourceHash = sourcePostingId.replaceAll("-", "").padEnd(64, "a");
    const sourcePostingVersionId = crypto.randomUUID();
    const opportunityId = crypto.randomUUID();
    const factId = crypto.randomUUID();
    const factRevisionId = crypto.randomUUID();
    if (!input.owner) {
      await db.insert(jobAccounts).values({ id: userId });
      await db.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
      await db.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
      await db.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints: { roleFamily: "frontend", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } }, createdAt: now });
      await db.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
      await db.insert(profileFactRevisions).values({ id: factRevisionId, userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "TypeScript" }, state: "active", source: "user_confirmed", candidateFactId: null, reason: null, profileVersion: 1, createdAt: now });
    }
    await db.insert(jobSourcePostings).values({ id: sourcePostingId, userId, sourceType: "user_import", sourceIdentifier: sourceHash, sourceIdentity: { hash: sourceHash }, isOfficial: false, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await db.insert(jobSourcePostingVersions).values({ id: sourcePostingVersionId, userId, sourcePostingId, version: 1, contentSha256: sourceHash, rawContentSha256: sourceHash, rawObjectReference: { key: "safe" }, normalizedData: { qualifications: { workMode: null, relocationRequired: null, salary: null, seniority: null, education: null, languages: null, workEligibility: null, industry: null, employmentType: null, requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } } } }, retrievedAt: now, availability: "open", createdAt: now });
    await db.insert(jobOpportunities).values({ id: opportunityId, userId, importId: null, sourcePostingVersionId, canonicalOpportunityId: null, dedupKey: sourceHash, company: "示例科技", title: "前端工程师", location: "上海", postedAt: null, deadline: new Date("2026-09-20T00:00:00.000Z"), description: "需要 TypeScript", normalizedData: { qualifications: { requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } } } }, availability: "open", availabilityUpdatedAt: now, createdAt: now, updatedAt: now });
    await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId, opportunityId, sourcePostingVersionId, createdAt: now });
    const verdict = input.verdict ?? "pass";
    const scored = verdict === "pass" && (input.deadlineStatus ?? "valid") !== "expired";
    const triageVersionId = crypto.randomUUID();
    await db.insert(jobTriageVersions).values({ id: triageVersionId, userId, opportunityId, sourcePostingVersionId, profileId, profileVersion: 1, targetId, targetVersion: 1, qualificationRuleVersion: "q1", coarseRuleVersion: "c1", overallVerdict: verdict, gateResults: {}, pendingItems: [], deadlineStatus: input.deadlineStatus ?? "valid", confidenceBasisPoints: 10_000, dimensionScores: scored ? {} : null, overallScore: scored ? (input.score ?? 80) : null, threshold: scored ? 70 : null, sequence: 1, createdAt: now });
    return { userId, profileId, targetId, opportunityId, sourcePostingVersionId, triageVersionId, factRevisionId };
  }

  async function stageFixture(
    input: Awaited<ReturnType<typeof fixture>>,
    options: {
      clock?: Date;
    } = {},
  ) {
    const publishedAt = options.clock ?? now;
    const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => publishedAt });
    const started = await starter.start({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), trigger: "manual" });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({
      status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: publishedAt, activeSliceStartedAt: publishedAt,
      claimToken, claimExpiresAt: new Date(publishedAt.getTime() + 30_000), controlState: "none",
    }).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, started.runId)));
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => publishedAt });
    const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: started.runId }))[0]!;
    const staged = await commands.invokeAndValidate({ userId: input.userId, runId: started.runId, candidate, modelCall: modelCall() });
    await commands.stageValidatedAssessment({ userId: input.userId, runId: started.runId, claimToken, candidate, assessment: staged.assessment, usage: staged.usage });
    return { input, commands, runId: started.runId, claimToken, publishedAt };
  }

  async function publishStagedFixture(
    input: Awaited<ReturnType<typeof fixture>>,
    options: {
      clock?: Date;
      ruleConfig?: { minimumOverallScore: number; minimumEvidenceDimensions: number; requiredEvidenceDimensions: string[]; excludedOpportunityIds: string[] };
      onPublished?: (transaction: any, result: { resultCount: number }) => Promise<void>;
    } = {},
  ) {
    const staged = await stageFixture(input, options);
    const published = await staged.commands.publishStagedRun({
      userId: input.userId, targetId: input.targetId, runId: staged.runId, fence: { claimToken: staged.claimToken }, selectionExclusions: [],
      ...(options.ruleConfig ? { ruleConfig: options.ruleConfig } : {}),
      ...(options.onPublished ? { onPublished: options.onPublished } : {}),
    });
    return { ...published, runId: staged.runId, claimToken: staged.claimToken };
  }

  async function preflight(status: "ready_with_warnings" | "blocked"): Promise<RunPreflightEvaluator> {
    const ready = createReadyRunPreflightEvaluator({ clock: () => now });
    return {
      async evaluate(database, request) {
        const evaluation = await ready.evaluate(database, request);
        const changed = status === "blocked"
          ? { ...evaluation.report.items[0]!, code: "PROFILE_EVIDENCE_MISSING" as const, severity: "blocking" as const, suggestedActions: ["review_profile"], evidence: { kind: "profile" as const, activeTrustedFactCount: 0, latestFactRevisionId: null, checkedAt: now.toISOString() } }
          : { ...evaluation.report.items[4]!, code: "SOURCE_HEALTH_UNCHECKED" as const, severity: "warning" as const, retryable: true, suggestedActions: ["review_source_health"], evidence: { kind: "source_health" as const, checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null } };
        return { ...evaluation, report: RunPreflightReportSchema.parse({ ...evaluation.report, status, warningFingerprint: status === "ready_with_warnings" ? "b".repeat(64) : null, items: evaluation.report.items.map((item, index) => index === (status === "blocked" ? 0 : 4) ? changed : item) }) };
      },
    };
  }

  it("手动 deep-match 仅接受当前 warning，automatic blocker 不创建 child", async () => {
    const input = await fixture();
    const warning = await preflight("ready_with_warnings");
    const manual = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now, runPreflight: warning });
    await expect(manual.start({ userId: input.userId, trigger: "manual", command: { targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), warningFingerprint: null } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" } satisfies Partial<RunPreflightRejectedError>);
    await expect(manual.start({ userId: input.userId, trigger: "manual", command: { targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), warningFingerprint: "a".repeat(64) } })).rejects.toMatchObject({ code: "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED" } satisfies Partial<RunPreflightRejectedError>);
    const created = await manual.start({ userId: input.userId, trigger: "manual", command: { targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), warningFingerprint: "b".repeat(64) } });
    await expect(db.select({ snapshot: agentRuns.preflightSnapshot }).from(agentRuns).where(eq(agentRuns.id, created.runId))).resolves.toEqual([{ snapshot: expect.objectContaining({ status: "ready_with_warnings", warningFingerprint: "b".repeat(64) }) }]);

    const blocked = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now, runPreflight: await preflight("blocked") });
    await expect(blocked.start({ userId: input.userId, trigger: "automatic", targetId: input.targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() })).resolves.toMatchObject({ kind: "blocked", preflight: { status: "blocked" } });
  });

  it("selects only owner-bound latest passing, valid and above-threshold triage candidates in stable score order", async () => {
    const eligible = await fixture({ score: 90 });
    const owner = { userId: eligible.userId, profileId: eligible.profileId, targetId: eligible.targetId };
    await fixture({ owner, score: 60 });
    await fixture({ owner, deadlineStatus: "expired" });
    await fixture({ owner, verdict: "fail" });
    const other = await fixture({ score: 99 });

    const selected = await createDeepMatchQueries({ db }).selectCandidateSelection({ userId: eligible.userId, targetId: eligible.targetId, targetVersion: 1 });

    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0]).toMatchObject({ opportunityId: eligible.opportunityId, sourcePostingVersionId: eligible.sourcePostingVersionId, overallScore: 90 });
    expect(selected.candidates.some((candidate) => candidate.opportunityId === other.opportunityId)).toBe(false);
    expect(selected.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: "SCORE_BELOW_THRESHOLD" }),
      expect.objectContaining({ reasonCode: "DEADLINE_EXPIRED" }),
      expect.objectContaining({ reasonCode: "TRIAGE_NOT_PASS" }),
    ]));
  });

  it("推荐 selection 使用本 root 冻结的来源版本，而不是当前机会指针或内容", async () => {
    const input = await fixture({ score: 90 });
    const [source] = await db.select({ sourcePostingId: jobSourcePostingVersions.sourcePostingId }).from(jobSourcePostingVersions)
      .where(eq(jobSourcePostingVersions.id, input.sourcePostingVersionId));
    const frozenNormalizedData = { company: "冻结公司", title: "冻结前端工程师", location: "杭州", deadline: "2026-09-20T00:00:00.000Z", qualifications: {
      workMode: null, relocationRequired: null, salary: null, seniority: null, education: null, languages: null,
      workEligibility: null, industry: null, employmentType: null,
      requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TypeScript" } },
    } };
    const currentSourcePostingVersionId = crypto.randomUUID();
    await db.update(jobSourcePostingVersions).set({ normalizedData: frozenNormalizedData }).where(eq(jobSourcePostingVersions.id, input.sourcePostingVersionId));
    await db.insert(jobSourcePostingVersions).values({ id: currentSourcePostingVersionId, userId: input.userId, sourcePostingId: source!.sourcePostingId, version: 2, contentSha256: "b".repeat(64), rawContentSha256: "b".repeat(64), rawObjectReference: { key: "current" }, normalizedData: { company: "当前公司", title: "当前后端工程师", location: "北京" }, retrievedAt: now, availability: "open", createdAt: now });
    await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId: input.userId, opportunityId: input.opportunityId, sourcePostingVersionId: currentSourcePostingVersionId, createdAt: now });
    await db.update(jobOpportunities).set({ sourcePostingVersionId: currentSourcePostingVersionId, company: "当前公司", title: "当前后端工程师", location: "北京", description: "当前岗位描述", normalizedData: { company: "当前公司", title: "当前后端工程师", location: "北京" }, updatedAt: now }).where(eq(jobOpportunities.id, input.opportunityId));

    const selection = await createDeepMatchQueries({ db }).selectCandidateSelection({
      userId: input.userId, targetId: input.targetId, targetVersion: 1,
      frozenTriageVersionIds: [input.triageVersionId], profileId: input.profileId, profileVersion: 1,
    });

    expect(selection).toMatchObject({ exclusions: [], candidates: [expect.objectContaining({
      opportunityId: input.opportunityId, sourcePostingVersionId: input.sourcePostingVersionId,
      opportunitySnapshot: { company: "冻结公司", title: "冻结前端工程师", location: "杭州" },
    })] });
    expect(selection.candidates[0]!.jobEvidence.map((item) => item.value)).toEqual(expect.arrayContaining(["冻结前端工程师", "杭州"]));
    expect(selection.candidates[0]!.jobEvidence.map((item) => item.value)).not.toEqual(expect.arrayContaining(["当前后端工程师", "北京", "当前岗位描述"]));
  });

  it("推荐 selection 仅使用 root 冻结的 triage tuple，不扩展到同一来源版本的其他机会", async () => {
    const root = await fixture({ score: 90 });
    const unrelatedOpportunityId = crypto.randomUUID();
    const unrelatedTriageVersionId = crypto.randomUUID();
    await db.insert(jobOpportunities).values({
      id: unrelatedOpportunityId, userId: root.userId, importId: null, sourcePostingVersionId: root.sourcePostingVersionId,
      canonicalOpportunityId: null, dedupKey: crypto.randomUUID().replaceAll("-", "").repeat(2), company: "无关公司", title: "无关岗位",
      location: "上海", postedAt: null, deadline: null, description: "不属于本 root", normalizedData: {}, availability: "open",
      availabilityUpdatedAt: now, createdAt: now, updatedAt: now,
    });
    await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId: root.userId, opportunityId: unrelatedOpportunityId, sourcePostingVersionId: root.sourcePostingVersionId, createdAt: now });
    await db.insert(jobTriageVersions).values({
      id: unrelatedTriageVersionId, userId: root.userId, opportunityId: unrelatedOpportunityId, sourcePostingVersionId: root.sourcePostingVersionId,
      profileId: root.profileId, profileVersion: 1, targetId: root.targetId, targetVersion: 1, qualificationRuleVersion: "q1", coarseRuleVersion: "c1",
      overallVerdict: "fail", gateResults: {}, pendingItems: [], deadlineStatus: "valid", confidenceBasisPoints: 10_000,
      dimensionScores: null, overallScore: null, threshold: null, sequence: 1, createdAt: now,
    });

    await expect(createDeepMatchQueries({ db }).selectCandidateSelection({
      userId: root.userId, targetId: root.targetId, targetVersion: 1, frozenTriageVersionIds: [root.triageVersionId],
      profileId: root.profileId, profileVersion: 1,
    })).resolves.toEqual({
      candidates: [expect.objectContaining({ opportunityId: root.opportunityId, sourcePostingVersionId: root.sourcePostingVersionId })],
      exclusions: [],
    });
  });

  it("推荐 selection 在冻结来源缺少 qualifications 时不回退当前机会数据", async () => {
    const input = await fixture({ score: 90 });
    await db.update(jobSourcePostingVersions).set({ normalizedData: {} }).where(eq(jobSourcePostingVersions.id, input.sourcePostingVersionId));
    await db.update(jobOpportunities).set({ normalizedData: { qualifications: {
      workMode: null, relocationRequired: null, salary: null, seniority: null, education: null, languages: null,
      workEligibility: null, industry: null, employmentType: null,
      requiredSkills: { value: ["CurrentOnly"], evidence: { field: "requiredSkills", path: "技能", value: "CurrentOnly" } },
    } } }).where(eq(jobOpportunities.id, input.opportunityId));

    await expect(createDeepMatchQueries({ db }).selectCandidateSelection({
      userId: input.userId, targetId: input.targetId, targetVersion: 1,
      frozenTriageVersionIds: [input.triageVersionId], profileId: input.profileId, profileVersion: 1,
    })).resolves.toEqual({ candidates: [], exclusions: [{ opportunityId: input.opportunityId, reasonCode: "MATCH_QUALITY_INSUFFICIENT" }] });
  });

  it("selection 只将通过资格与粗排门槛的规则排除岗位记录为 RULE_EXCLUDED", async () => {
    const eligible = await fixture({ score: 90 });
    const owner = { userId: eligible.userId, profileId: eligible.profileId, targetId: eligible.targetId };
    const belowThreshold = await fixture({ owner, score: 60 });

    await expect(createDeepMatchQueries({ db }).selectCandidateSelection({
      userId: eligible.userId, targetId: eligible.targetId, targetVersion: 1,
      frozenTriageVersionIds: [eligible.triageVersionId, belowThreshold.triageVersionId], profileId: eligible.profileId, profileVersion: 1,
      ruleConfig: { excludedOpportunityIds: [eligible.opportunityId, belowThreshold.opportunityId] },
    })).resolves.toEqual({ candidates: [], exclusions: expect.arrayContaining([
      { opportunityId: eligible.opportunityId, reasonCode: "RULE_EXCLUDED" },
      { opportunityId: belowThreshold.opportunityId, reasonCode: "SCORE_BELOW_THRESHOLD" },
    ]) });
  });

  it("推荐 child 冻结当前非默认规则及其版本而不改变粗排语义", async () => {
    const input = await fixture({ score: 90 });
    const automatic = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now });
    const ordinary = await automatic.start({ userId: input.userId, targetId: input.targetId, trigger: "automatic", discoveryRunId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
    const [template] = await db.select().from(agentRuns).where(eq(agentRuns.id, ordinary.runId));
    const parentRunId = crypto.randomUUID();
    await db.insert(agentRuns).values({
      id: parentRunId, userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), targetVersion: 1,
      targetSnapshot: template!.targetSnapshot, profileSnapshot: { targetId: input.targetId, version: 1, confirmedActiveSkillNames: ["TypeScript"] }, watchlistSnapshot: { targetId: input.targetId, version: 0, companies: [] },
      sourceScope: { kind: "recommendation" }, budgetSnapshot: template!.budgetSnapshot, accountPolicyRevisionNumber: template!.accountPolicyRevisionNumber, accountPolicySnapshot: template!.accountPolicySnapshot, preflightSnapshot: template!.preflightSnapshot,
      workflowVersion: "layered-public-job-discovery-v1", ruleVersion: "layered-public-job-discovery-rules-v1", adapter: "layered-public", adapterVersion: "test", outputSchemaVersion: "job-discovery-result-v1", toolAllowlist: [], modelSnapshot: null,
      runPurpose: "recommendation", recommendationContext: { version: "recommendation-context-v1", profile: { profileId: input.profileId, profileVersion: 1 }, budgets: { discovery: template!.budgetSnapshot, deepMatch: template!.budgetSnapshot }, preflight: template!.preflightSnapshot, accountPolicyRevisionNumber: template!.accountPolicyRevisionNumber },
      status: "queued", currentStep: "queued", controlState: "none", version: 1, attemptCount: 0, activeDurationMs: 0, toolCallCount: 0, sourceRequestCount: 0, modelCallCount: 0, inputTokenCount: 0, outputTokenCount: 0, totalTokenCount: 0, resultCount: 0, usageComplete: false, queuedAt: now, createdAt: now, updatedAt: now,
    });
    const proposalId = crypto.randomUUID(); const proposalRevisionId = crypto.randomUUID();
    const ruleConfig = { minimumOverallScore: 95, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] };
    await db.insert(calibrationProposals).values({ id: proposalId, userId: input.userId, targetId: input.targetId, reason: "SALARY", status: "approved", version: 2, createdAt: now, updatedAt: now });
    await db.insert(calibrationProposalRevisions).values({ id: proposalRevisionId, userId: input.userId, proposalId, revisionNumber: 1, baseRuleVersion: 0, strategy: "raise_quality_bar", ruleConfig, impactPreview: { sampleSize: 1, estimatedAffectedCount: 1, ruleDiff: {} }, idempotencyKey: crypto.randomUUID(), commandSummary: hash, createdAt: now });
    await db.insert(recommendationRuleVersions).values({ id: crypto.randomUUID(), userId: input.userId, targetId: input.targetId, proposalId, proposalRevisionId, version: 1, config: ruleConfig, createdAt: now });

    const created = await db.transaction((transaction) => ensureDeepMatchRunInTransaction({
      transaction, id: () => crypto.randomUUID(), clock: () => now, runPreflight: { evaluate: async () => { throw new Error("recommendation child skips preflight"); } } as any,
      userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: parentRunId,
      recommendation: { parentRunId, profileId: input.profileId, profileVersion: 1, targetSnapshot: template!.targetSnapshot, budgetSnapshot: template!.budgetSnapshot, accountPolicyRevisionNumber: template!.accountPolicyRevisionNumber!, accountPolicySnapshot: template!.accountPolicySnapshot, preflightSnapshot: template!.preflightSnapshot, frozenTriageVersionIds: [input.triageVersionId], frozenRecommendationEvidence: { version: "recommendation-evidence-v1", plannedTrustedSourceCount: 1, plannedPublicQueryCount: 0, discoveryFacts: { version: "recommendation-discovery-facts-v1", trusted: [{ sourceId: "fake:aurora-careers", checked: true, outcome: "credible_results", losses: [] }], publicQueries: [] }, frozenTriageVersionIds: [input.triageVersionId] } },
    }));

    expect(created).toMatchObject({ kind: "created", reused: false, run: { ruleVersion: "recommendation-rule-v1" } });
    const [child] = await db.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, (created as { kind: "created"; run: { id: string } }).run.id));
    expect(child!.sourceScope).toMatchObject({ recommendationRuleConfig: ruleConfig, selectionExclusions: [], frozenRecommendationEvidence: { version: "recommendation-evidence-v1", frozenTriageVersionIds: [input.triageVersionId] } });
    await expect(db.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, (created as { kind: "created"; run: { id: string } }).run.id))).resolves.toHaveLength(1);
  });

  it("freezes every structured qualification with its source-version evidence and normalized value", async () => {
    const input = await fixture();
    await db.update(jobSourcePostingVersions).set({ normalizedData: { qualifications: {
      workMode: { value: "remote", evidence: { field: "workMode", path: "工作方式", value: "允许远程协作" } },
      relocationRequired: { value: false, evidence: { field: "relocationRequired", path: "搬迁要求", value: "无需搬迁" } },
      salary: { value: { minimum: 30_000, maximum: 50_000, currency: "CNY", period: "month" }, evidence: { field: "salary", path: "薪资范围", value: "月薪 3-5 万" } },
      seniority: { value: "senior", evidence: { field: "seniority", path: "岗位级别", value: "资深" } },
      education: { value: "bachelor", evidence: { field: "education", path: "学历要求", value: "本科及以上" } },
      languages: { value: [{ name: "English", level: "C1" }], evidence: { field: "languages", path: "语言能力", value: "英语可工作沟通" } },
      workEligibility: { value: "authorized", evidence: { field: "workEligibility", path: "工作资格", value: "可在中国合法工作" } },
      industry: { value: "互联网", evidence: { field: "industry", path: "所属行业", value: "互联网服务" } }, employmentType: { value: "direct", evidence: { field: "employmentType", path: "用工形式", value: "正式直聘" } }, requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "技能", value: "TS" } },
    } } }).where(eq(jobSourcePostingVersions.id, input.sourcePostingVersionId));
    const [candidate] = (await createDeepMatchQueries({ db }).selectCandidateSelection({ userId: input.userId, targetId: input.targetId, targetVersion: 1 })).candidates;
    expect(candidate!.jobEvidence.map(({ provenance }) => provenance)).toEqual(expect.arrayContaining([
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "seniority", path: "岗位级别", originalValue: "资深", normalizedValue: "senior" },
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "education", path: "学历要求", originalValue: "本科及以上", normalizedValue: "bachelor" },
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "languages", path: "语言能力", originalValue: "英语可工作沟通", normalizedValue: "English（C1）" },
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "workEligibility", path: "工作资格", originalValue: "可在中国合法工作", normalizedValue: "authorized" },
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "workMode", path: "工作方式", originalValue: "允许远程协作", normalizedValue: "remote" },
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "relocationRequired", path: "搬迁要求", originalValue: "无需搬迁", normalizedValue: "false" },
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "salary", path: "薪资范围", originalValue: "月薪 3-5 万", normalizedValue: "{\"minimum\":30000,\"maximum\":50000,\"currency\":\"CNY\",\"period\":\"month\"}" },
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "industry", path: "所属行业", originalValue: "互联网服务", normalizedValue: "互联网" },
      { sourcePostingVersionId: input.sourcePostingVersionId, field: "employmentType", path: "用工形式", originalValue: "正式直聘", normalizedValue: "direct" },
    ]));
  });

  it("bounds every frozen job evidence field before the candidate reaches the adapter", async () => {
    const input = await fixture();
    const longTitle = "职".repeat(20_000);
    const longLocation = "地".repeat(20_000);
    const skills = Array.from({ length: 100 }, (_, index) => `技能${index}`.padEnd(128, "甲"));
    const languages = Array.from({ length: 20 }, (_, index) => ({ name: `语言${index}`.padEnd(128, "乙"), level: "C1" }));
    await db.update(jobSourcePostingVersions).set({ normalizedData: { qualifications: {
      workMode: null, relocationRequired: null, salary: null, seniority: null, education: null,
      languages: { value: languages, evidence: { field: "languages", path: "语言能力", value: "语言要求" } },
      workEligibility: null, industry: null, employmentType: null,
      requiredSkills: { value: skills, evidence: { field: "requiredSkills", path: "技能", value: "技能要求" } },
    } } }).where(eq(jobSourcePostingVersions.id, input.sourcePostingVersionId));
    await db.update(jobOpportunities).set({ title: longTitle, location: longLocation, description: longTitle }).where(eq(jobOpportunities.id, input.opportunityId));

    const selection = await createDeepMatchQueries({ db }).selectCandidateSelection({ userId: input.userId, targetId: input.targetId, targetVersion: 1 });
    const [candidate] = selection.candidates;

    expect(candidate).toBeDefined();
    expect(DeepMatchCandidateSchema.parse({
      opportunityId: candidate!.opportunityId,
      sourcePostingVersionId: candidate!.sourcePostingVersionId,
      jobEvidence: candidate!.jobEvidence,
      profileEvidence: candidate!.profileEvidence,
    })).toEqual(expect.objectContaining({ opportunityId: input.opportunityId }));
    for (const evidence of candidate!.jobEvidence) {
      expect(evidence.value.length).toBeLessThanOrEqual(512);
      expect(evidence.provenance?.originalValue.length).toBeLessThanOrEqual(512);
      expect(evidence.provenance?.normalizedValue.length).toBeLessThanOrEqual(512);
    }
    expect(candidate!.jobEvidence.find((evidence) => evidence.provenance?.field === "title")?.provenance?.originalValue).toBe(longTitle.slice(0, 512));
    expect(candidate!.jobEvidence.find((evidence) => evidence.provenance?.field === "location")?.provenance?.originalValue).toBe(longLocation.slice(0, 512));
  });

  it("keeps a contract-valid maximum target snapshot selectable, freezable and historically reproducible", async () => {
    const input = await fixture();
    const roleFamily = "岗".repeat(200);
    const locations = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(200, "地"));
    const constraints = JobTargetConstraintsSchema.parse({
      roleFamily, seniority: null, locations, workModes: ["onsite", "hybrid", "remote"], relocation: "conditional", salary: null, industries: [],
      dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
    });
    await db.update(jobTargetRevisions).set({ constraints }).where(and(eq(jobTargetRevisions.userId, input.userId), eq(jobTargetRevisions.targetId, input.targetId), eq(jobTargetRevisions.version, 1)));

    const queries = createDeepMatchQueries({ db });
    const selection = await queries.selectCandidateSelection({ userId: input.userId, targetId: input.targetId, targetVersion: 1 });
    const [selected] = selection.candidates;

    expect(selection.exclusions).toEqual([]);
    expect(DeepMatchCandidateSchema.parse({ opportunityId: selected!.opportunityId, sourcePostingVersionId: selected!.sourcePostingVersionId, jobEvidence: selected!.jobEvidence, profileEvidence: selected!.profileEvidence })).toEqual(expect.objectContaining({ opportunityId: input.opportunityId }));
    const targetEvidence = selected!.profileEvidence.filter((evidence) => evidence.kind === "target_revision");
    expect(targetEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining(":career"), targetRevisionId: expect.any(String), value: `已确认的岗位方向：${roleFamily}`, dimensions: ["career_direction"] }),
      expect.objectContaining({ id: expect.stringContaining(":location"), targetRevisionId: expect.any(String), value: `已确认的地点/工作方式约束：onsite、hybrid、remote、conditional、${locations[0]}、${locations[1]!.slice(0, 8)}`, dimensions: ["location_logistics"] }),
    ]));
    expect(targetEvidence.every((evidence) => evidence.targetRevisionId === targetEvidence[0]!.targetRevisionId && evidence.value.length <= 256)).toBe(true);

    const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), trigger: "manual" });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, run.runId));
    const frozen = (await queries.getFrozenCandidates({ userId: input.userId, runId: run.runId }))[0]!;
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now, adapter: new FakeDeepMatchAdapter() });
    const staged = await commands.invokeAndValidate({ userId: input.userId, runId: run.runId, candidate: frozen, modelCall: modelCall() });
    await commands.stageValidatedAssessment({ userId: input.userId, runId: run.runId, claimToken, candidate: frozen, assessment: staged.assessment, usage: staged.usage });
    const published = await commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: run.runId, fence: { claimToken }, selectionExclusions: [] });
    await expect(db.select({
      userId: agentInboxItems.userId,
      recommendationListId: agentInboxItems.recommendationListId,
      kind: agentInboxItems.kind,
      status: agentInboxItems.status,
      reasonCode: agentInboxItems.reasonCode,
    }).from(agentInboxItems).where(eq(agentInboxItems.recommendationListId, published.recommendationListId))).resolves.toEqual([{
      userId: input.userId,
      recommendationListId: published.recommendationListId,
      kind: "recommendation_list",
      status: "unread",
      reasonCode: "RECOMMENDATION_LIST_PUBLISHED",
    }]);
    const beforeTargetChange = await queries.getLatestList({ userId: input.userId, targetId: input.targetId });
    await db.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId: input.userId, targetId: input.targetId, version: 2, priority: "primary", state: "active", constraints: { ...constraints, roleFamily: "后端工程师" }, createdAt: new Date(now.getTime() + 1_000) });
    await db.update(jobTargets).set({ version: 2 }).where(eq(jobTargets.id, input.targetId));
    const afterTargetChange = await queries.getLatestList({ userId: input.userId, targetId: input.targetId });
    expect(afterTargetChange?.items[0]?.profileEvidence).toEqual(beforeTargetChange?.items[0]?.profileEvidence);
  });

  it("stably excludes a candidate that cannot satisfy the adapter input contract", async () => {
    const input = await fixture();
    await db.update(jobTargetRevisions).set({ constraints: {
      roleFamily: "岗".repeat(20_000), seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [],
      dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
    } }).where(and(eq(jobTargetRevisions.userId, input.userId), eq(jobTargetRevisions.targetId, input.targetId), eq(jobTargetRevisions.version, 1)));

    await expect(createDeepMatchQueries({ db }).selectCandidateSelection({ userId: input.userId, targetId: input.targetId, targetVersion: 1 }))
      .resolves.toEqual({ candidates: [], exclusions: [{ opportunityId: input.opportunityId, reasonCode: "MATCH_QUALITY_INSUFFICIENT" }] });
  });

  it("does not mix an old target-version triage into a newly frozen matching run", async () => {
    const input = await fixture();
    await db.insert(jobTargetRevisions).values({ id: crypto.randomUUID(), userId: input.userId, targetId: input.targetId, version: 2, priority: "primary", state: "active", constraints: { roleFamily: "backend", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } }, createdAt: now });
    await db.update(jobTargets).set({ version: 2 }).where(eq(jobTargets.id, input.targetId));
    const started = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    await expect(db.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, started.runId))).resolves.toEqual([]);
    await expect(db.select({ targetVersion: agentRuns.targetVersion }).from(agentRuns).where(eq(agentRuns.id, started.runId))).resolves.toEqual([{ targetVersion: 2 }]);
    await expect(db.select({ sourceScope: agentRuns.sourceScope }).from(agentRuns).where(eq(agentRuns.id, started.runId))).resolves.toEqual([expect.objectContaining({ sourceScope: expect.objectContaining({ selectionExclusions: [{ opportunityId: input.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }] }) })]);
  });

  it("retains every selection exclusion instead of silently truncating the historical decision set", async () => {
    const eligible = await fixture({ score: 90 });
    const owner = { userId: eligible.userId, profileId: eligible.profileId, targetId: eligible.targetId };
    for (let index = 0; index < 11; index += 1) await fixture({ owner, verdict: "fail" });

    const selected = await createDeepMatchQueries({ db }).selectCandidateSelection({ userId: eligible.userId, targetId: eligible.targetId, targetVersion: 1 });

    expect(selected.exclusions.filter((item) => item.reasonCode === "TRIAGE_NOT_PASS")).toHaveLength(11);
  });

  it("records evidence-insufficient exclusion and backfills the next eligible candidate", async () => {
    const first = await fixture({ score: 90 });
    const owner = { userId: first.userId, profileId: first.profileId, targetId: first.targetId };
    const second = await fixture({ owner, score: 80 });
    await db.update(jobSourcePostingVersions).set({ normalizedData: {} }).where(eq(jobSourcePostingVersions.id, first.sourcePostingVersionId));
    await db.update(jobOpportunities).set({ title: null, location: null, description: null, normalizedData: {} }).where(eq(jobOpportunities.id, first.opportunityId));
    const selected = await createDeepMatchQueries({ db }).selectCandidateSelection({ userId: first.userId, targetId: first.targetId, targetVersion: 1 });
    expect(selected.candidates.map((candidate) => candidate.opportunityId)).toEqual([second.opportunityId]);
    expect(selected.exclusions).toContainEqual({ opportunityId: first.opportunityId, reasonCode: "MATCH_QUALITY_INSUFFICIENT" });
  });

  it("persists exactly one recoverable matching child run when queue delivery fails and retries delivery on duplicate trigger", async () => {
    const input = await fixture();
    const queue = { calls: 0, fail: true, async enqueue() { this.calls += 1; if (this.fail) throw new Error("QUEUE_DOWN"); } };
    const starter = createDeepMatchRunStarter({ db, queue, id: () => crypto.randomUUID(), clock: () => now });
    const key = crypto.randomUUID();
    const discoveryRunId = crypto.randomUUID();
    const first = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: key, trigger: "automatic", discoveryRunId });
    queue.fail = false;
    const second = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: key, trigger: "automatic", discoveryRunId });
    expect(first).toMatchObject({ reused: false });
    expect(second).toMatchObject({ runId: first.runId, reused: true });
    expect(queue.calls).toBe(2);
    await expect(db.select().from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.idempotencyKey, key)))).resolves.toHaveLength(1);
    await expect(db.select().from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.userId, input.userId), eq(deepMatchRunCandidates.runId, first.runId)))).resolves.toHaveLength(1);
  });


  it("does not publish a partial matching run when a staged candidate is missing its assessment", async () => {
    const input = await fixture();
    const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "manual", opportunityId: input.opportunityId });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" })
      .where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, run.runId)));
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });

    await expect((commands as any).publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: run.runId, fence: { claimToken }, selectionExclusions: [] }))
      .rejects.toThrow("DEEP_MATCH_STAGE_INCOMPLETE");
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(0);
    await expect(db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId))).resolves.toHaveLength(0);
  });

  it.each(["another opportunity", "a forged frozen snapshot", "a swapped profile revision", "a swapped target revision"] as const)("atomically rejects a staged assessment for %s", async (mutation) => {
    const input = await fixture();
    const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "manual", opportunityId: input.opportunityId });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, run.runId));
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: run.runId }))[0]!;
    const staged = await commands.invokeAndValidate({ userId: input.userId, runId: run.runId, candidate, modelCall: modelCall() });
    const assessment = mutation === "another opportunity"
      ? { ...staged.assessment, opportunityId: crypto.randomUUID() }
      : mutation === "a forged frozen snapshot"
        ? { ...staged.assessment, evidenceSnapshot: { ...staged.assessment.evidenceSnapshot!, jobEvidence: [{ ...staged.assessment.evidenceSnapshot!.jobEvidence[0]!, value: "伪造的岗位证据" }] } }
        : mutation === "a swapped profile revision"
          ? { ...staged.assessment, evidenceSnapshot: { ...staged.assessment.evidenceSnapshot!, profileEvidence: staged.assessment.evidenceSnapshot!.profileEvidence.map((evidence) => evidence.kind === "profile_fact" ? { ...evidence, profileFactRevisionId: crypto.randomUUID() } : evidence) } }
          : { ...staged.assessment, evidenceSnapshot: { ...staged.assessment.evidenceSnapshot!, profileEvidence: staged.assessment.evidenceSnapshot!.profileEvidence.map((evidence) => evidence.kind === "target_revision" ? { ...evidence, targetRevisionId: crypto.randomUUID() } : evidence) } };
    await db.update(deepMatchRunCandidates).set({ assessment, adapterUsage: staged.usage }).where(and(eq(deepMatchRunCandidates.runId, run.runId), eq(deepMatchRunCandidates.opportunityId, candidate.opportunityId)));

    await expect(commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: run.runId, fence: { claimToken }, selectionExclusions: [] })).rejects.toThrow("DEEP_MATCH_STAGED_CANDIDATE_INVALID");
    await expect(Promise.all([
      db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId)),
      db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId)),
    ])).resolves.toEqual([[], []]);
  });

  it("reuses the first staged candidate result without a second model call before one atomic publish", async () => {
    const input = await fixture();
    const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "manual", opportunityId: input.opportunityId });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" })
      .where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.id, run.runId)));
    const fake = new FakeDeepMatchAdapter(); let calls = 0;
    const adapter = { ...fake, assess: async (...args: Parameters<FakeDeepMatchAdapter["assess"]>) => { calls += 1; return fake.assess(...args); } };
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now, adapter });
    const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: run.runId }))[0]!;
    const first = await commands.invokeAndValidate({ userId: input.userId, runId: run.runId, candidate, modelCall: modelCall() });
    await commands.stageValidatedAssessment({ userId: input.userId, runId: run.runId, claimToken, candidate, assessment: first.assessment, usage: first.usage });
    const restored = await commands.invokeAndValidate({ userId: input.userId, runId: run.runId, candidate, modelCall: modelCall() });

    expect(first.reused).toBe(false); expect(restored.reused).toBe(true); expect(calls).toBe(1);
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(0);
    await expect(db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId))).resolves.toHaveLength(0);
    await commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: run.runId, fence: { claimToken }, selectionExclusions: [] });
    await expect(db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toHaveLength(1);
    await expect(db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId))).resolves.toHaveLength(1);
  });

  it("rolls back the child and its candidate snapshot when initialization crashes after insertion", async () => {
    const input = await fixture();
    let calls = 0;
    const id = () => { calls += 1; if (calls === 3) throw new Error("CHILD_INIT_CRASH"); return crypto.randomUUID(); };
    const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id, clock: () => now });

    await expect(starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() })).rejects.toThrow("CHILD_INIT_CRASH");
    await expect(Promise.all([
      db.select().from(agentRuns).where(eq(agentRuns.userId, input.userId)),
      db.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.userId, input.userId)),
    ])).resolves.toEqual([[], []]);
  });

  it("never offers a manually inserted uninitialized matching row to the reconciler race", async () => {
    const input = await fixture();
    const child = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    await db.update(agentRuns).set({ sourceScope: { kind: "deep_match", trigger: "automatic", opportunityId: null, discoveryRunId: crypto.randomUUID() } }).where(eq(agentRuns.id, child.runId));
    await expect(createAgentRunRecoveryQueries({ db, clock: () => now }).listRecoverable()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ runId: child.runId })]));
  });

  it("marks a legitimate zero-candidate child initialized and retains its frozen exclusions across retry", async () => {
    const input = await fixture({ verdict: "fail" });
    const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now });
    const child = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    const [first] = await db.select().from(agentRuns).where(eq(agentRuns.id, child.runId));
    expect(first?.sourceScope).toMatchObject({ initialized: true, selectionExclusions: [{ opportunityId: input.opportunityId, reasonCode: "TRIAGE_NOT_PASS" }] });
    await expect(db.select().from(deepMatchRunCandidates).where(eq(deepMatchRunCandidates.runId, child.runId))).resolves.toEqual([]);

    await db.update(jobTriageVersions).set({ overallVerdict: "pass", dimensionScores: {}, overallScore: 99, threshold: 70 }).where(eq(jobTriageVersions.id, input.triageVersionId));
    const replay = await starter.start({ userId: input.userId, targetId: input.targetId, idempotencyKey: first!.idempotencyKey, trigger: "automatic", discoveryRunId: (first!.sourceScope as { discoveryRunId: string }).discoveryRunId });
    expect(replay).toMatchObject({ runId: child.runId, reused: true });
    const [unchanged] = await db.select().from(agentRuns).where(eq(agentRuns.id, child.runId));
    expect(unchanged?.sourceScope).toEqual(first?.sourceScope);
  });

  it("publishes the frozen source tuple after the opportunity current source pointer moves", async () => {
    const input = await fixture();
    const child = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
      .start({ userId: input.userId, targetId: input.targetId, idempotencyKey: crypto.randomUUID(), trigger: "automatic", discoveryRunId: crypto.randomUUID() });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, child.runId));
    const newerSource = crypto.randomUUID();
    const [original] = await db.select().from(jobSourcePostingVersions).where(eq(jobSourcePostingVersions.id, input.sourcePostingVersionId));
    await db.insert(jobSourcePostingVersions).values({ ...original!, id: newerSource, version: 2, contentSha256: "b".repeat(64), rawContentSha256: "b".repeat(64), createdAt: new Date(now.getTime() + 1_000) });
    await db.insert(jobOpportunitySources).values({ id: crypto.randomUUID(), userId: input.userId, opportunityId: input.opportunityId, sourcePostingVersionId: newerSource, createdAt: new Date(now.getTime() + 1_000) });
    await db.update(jobOpportunities).set({ sourcePostingVersionId: newerSource }).where(eq(jobOpportunities.id, input.opportunityId));

    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: child.runId }))[0]!;
    const staged = await commands.invokeAndValidate({ userId: input.userId, runId: child.runId, candidate, modelCall: modelCall() });
    await commands.stageValidatedAssessment({ userId: input.userId, runId: child.runId, claimToken, candidate, assessment: staged.assessment, usage: staged.usage });
    await commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: child.runId, fence: { claimToken }, selectionExclusions: [] });
    await expect(db.select({ sourcePostingVersionId: jobMatchVersions.sourcePostingVersionId }).from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId))).resolves.toEqual([{ sourcePostingVersionId: input.sourcePostingVersionId }]);
  });

  it("keeps the 0034 fourth-highlight rejection under three independent staged-publish rounds", async () => {
    const input = await fixture();
    const publish = async () => {
      const run = await createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now })
        .start({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), trigger: "manual" });
      const claimToken = crypto.randomUUID();
      await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, run.runId));
      const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
      const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: run.runId }))[0]!;
      const staged = await commands.invokeAndValidate({ userId: input.userId, runId: run.runId, candidate, modelCall: modelCall() });
      await commands.stageValidatedAssessment({ userId: input.userId, runId: run.runId, claimToken, candidate, assessment: staged.assessment, usage: staged.usage });
      return commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: run.runId, fence: { claimToken }, selectionExclusions: [] });
    };
    for (let round = 0; round < 3; round += 1) {
      const published = await Promise.all([publish(), publish(), publish(), publish()]);
      const listId = published[0]!.recommendationListId;
      const ids = published.map((result) => result.items[0]!.matchVersionId);
      await db.transaction((transaction) => transaction.insert(recommendationListItems).values({ id: crypto.randomUUID(), userId: input.userId, recommendationListId: listId, matchVersionId: ids[1]!, ordinal: 2, highlighted: true, createdAt: now }));
      const insert = (matchVersionId: string, ordinal: number) => db.transaction((transaction) => transaction.insert(recommendationListItems).values({ id: crypto.randomUUID(), userId: input.userId, recommendationListId: listId, matchVersionId, ordinal, highlighted: true, createdAt: now }));
      const outcome = await Promise.allSettled([insert(ids[2]!, 3), insert(ids[3]!, 4)]);
      expect(outcome.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcome.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(db.select().from(recommendationListItems).where(eq(recommendationListItems.recommendationListId, listId))).resolves.toHaveLength(3);
    }
  }, 60_000);

  it("在插入非空推荐项目后，以可信发布时钟冻结 recommendation_list 完成事实", async () => {
    const input = await fixture();
    const published = await publishStagedFixture(input);

    expect(published.items).toHaveLength(1);
    await expect(db.select().from(recommendationListItems).where(and(
      eq(recommendationListItems.userId, input.userId), eq(recommendationListItems.recommendationListId, published.recommendationListId),
    ))).resolves.toHaveLength(1);
    await expect(db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, input.userId)))
      .resolves.toEqual([expect.objectContaining({
        userId: input.userId,
        resultKind: "recommendation_list",
        resultId: published.recommendationListId,
        completedAt: now,
      })]);
  });

  it("零 accepted 即使生成空清单和排除记录也不完成首次推荐旅程", async () => {
    const input = await fixture();
    const published = await publishStagedFixture(input, {
      ruleConfig: { minimumOverallScore: 100, minimumEvidenceDimensions: 0, requiredEvidenceDimensions: [], excludedOpportunityIds: [] },
    });

    expect(published.items).toEqual([]);
    await expect(db.select().from(recommendationLists).where(and(
      eq(recommendationLists.userId, input.userId), eq(recommendationLists.id, published.recommendationListId),
    ))).resolves.toHaveLength(1);
    await expect(db.select().from(recommendationExclusions).where(and(
      eq(recommendationExclusions.userId, input.userId), eq(recommendationExclusions.recommendationListId, published.recommendationListId),
    ))).resolves.toHaveLength(1);
    await expect(db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, input.userId))).resolves.toEqual([]);
  });

  it("两个首次发布竞争时保留先提交者的完成事实，稳定身份重试也不覆盖它", async () => {
    const firstInput = await fixture();
    const owner = { userId: firstInput.userId, profileId: firstInput.profileId, targetId: firstInput.targetId };
    const secondInput = await fixture({ owner });
    const firstCompletedAt = new Date("2026-09-01T02:00:00.000Z");
    const secondCompletedAt = new Date("2026-09-01T02:01:00.000Z");
    const first = await stageFixture(firstInput, { clock: firstCompletedAt });
    const second = await stageFixture(secondInput, { clock: secondCompletedAt });
    const firstPublishInput = { userId: owner.userId, targetId: owner.targetId, runId: first.runId, fence: { claimToken: first.claimToken }, selectionExclusions: [] as const };
    const secondPublishInput = { userId: owner.userId, targetId: owner.targetId, runId: second.runId, fence: { claimToken: second.claimToken }, selectionExclusions: [] as const };
    const firstPausedBeforeCommit = deferred();
    const releaseFirstCommit = deferred();
    const firstPublishing = first.commands.publishStagedRun({
      ...firstPublishInput,
      onPublished: async () => { firstPausedBeforeCommit.resolve(); await releaseFirstCommit.promise; },
    });
    await firstPausedBeforeCommit.promise;

    const competingDatabase = createDatabase(container.getConnectionUri());
    const observerDatabase = createDatabase(container.getConnectionUri());
    let secondPublishing: Promise<Awaited<ReturnType<typeof first.commands.publishStagedRun>>> | undefined;
    try {
      const competingCommands = createDeepMatchCommands({ db: competingDatabase, id: () => crypto.randomUUID(), clock: () => secondCompletedAt });
      let secondSettled = false;
      secondPublishing = competingCommands.publishStagedRun(secondPublishInput).finally(() => { secondSettled = true; });
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);
      expect(secondSettled).toBe(false);

      releaseFirstCommit.resolve();
      const [firstPublished, secondPublished] = await Promise.all([firstPublishing, secondPublishing]);
      expect(firstPublished.items).toHaveLength(1);
      expect(secondPublished.items).toHaveLength(1);
      await expect(db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, owner.userId)))
        .resolves.toEqual([{
          userId: owner.userId,
          resultKind: "recommendation_list",
          resultId: firstPublished.recommendationListId,
          completedAt: firstCompletedAt,
        }]);

      const retried = await first.commands.publishStagedRun(firstPublishInput);
      expect(retried.items).toHaveLength(1);
      await expect(db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, owner.userId)))
        .resolves.toEqual([{
          userId: owner.userId,
          resultKind: "recommendation_list",
          resultId: firstPublished.recommendationListId,
          completedAt: firstCompletedAt,
        }]);
    } finally {
      releaseFirstCommit.resolve();
      await Promise.allSettled([firstPublishing, ...(secondPublishing ? [secondPublishing] : [])]);
      await competingDatabase.$client.end();
      await observerDatabase.$client.end();
    }
  }, 60_000);

  it("publication 先取得账户锁时，随后 stop 等待并保留已提交推荐事实", async () => {
    const input = await fixture();
    const staged = await stageFixture(input);
    const enteredPublication = deferred(); const releasePublication = deferred();
    const publication = staged.commands.publishStagedRun({
      userId: input.userId, targetId: input.targetId, runId: staged.runId, fence: { claimToken: staged.claimToken }, selectionExclusions: [],
      onPublished: async () => { enteredPublication.resolve(); await releasePublication.promise; },
    });
    const stopDatabase = createDatabase(container.getConnectionUri());
    const observerDatabase = createDatabase(container.getConnectionUri());
    let stop: Promise<unknown> | undefined;
    try {
      await enteredPublication.promise;
      const controls = createAccountRunControl({ db: stopDatabase, auditTrail: createAuditTrail({ db: stopDatabase, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now });
      let stopSettled = false;
      stop = controls.control({ userId: input.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } }).finally(() => { stopSettled = true; });
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);
      expect(stopSettled).toBe(false);

      releasePublication.resolve();
      const [published, stopped] = await Promise.all([publication, stop]);
      expect(published.items).toHaveLength(1);
      expect(stopped).toMatchObject({ applied: true, state: { stoppedAt: expect.any(String) } });
      await expect(Promise.all([
        db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId)),
        db.select().from(recommendationListItems).where(eq(recommendationListItems.userId, input.userId)),
        db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId)),
        db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, input.userId)),
      ])).resolves.toEqual([[expect.any(Object)], [expect.any(Object)], [expect.any(Object)], [expect.objectContaining({ resultKind: "recommendation_list", resultId: published.recommendationListId })]]);
    } finally {
      releasePublication.resolve();
      await Promise.allSettled([publication, ...(stop ? [stop] : [])]);
      await stopDatabase.$client.end();
      await observerDatabase.$client.end();
    }
  }, 60_000);

  it("stop 先取得账户锁时，publication 等待后拒绝且不新增推荐事实", async () => {
    const input = await fixture();
    const staged = await stageFixture(input);
    const stopFactWritten = deferred(); const releaseStop = deferred();
    const stopDatabase = createDatabase(container.getConnectionUri());
    const publicationDatabase = createDatabase(container.getConnectionUri());
    const observerDatabase = createDatabase(container.getConnectionUri());
    const baseAuditTrail = createAuditTrail({ db: stopDatabase, clock: () => now });
    const heldStopAuditTrail: AuditTrail = {
      append: (event) => baseAuditTrail.append(event),
      bind(transaction) {
        const bound = baseAuditTrail.bind(transaction);
        return {
          append: async (event) => {
            await bound.append(event);
            if (event.eventType === "account.run_stopped") { stopFactWritten.resolve(); await releaseStop.promise; }
          },
          bind: bound.bind,
          query: bound.query,
        };
      },
      query: (input) => baseAuditTrail.query(input),
    };
    const controls = createAccountRunControl({ db: stopDatabase, auditTrail: heldStopAuditTrail, id: () => crypto.randomUUID(), clock: () => now });
    const stop = controls.control({ userId: input.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    let publication: Promise<unknown> | undefined;
    try {
      await stopFactWritten.promise;
      const commands = createDeepMatchCommands({ db: publicationDatabase, id: () => crypto.randomUUID(), clock: () => now });
      publication = commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: staged.runId, fence: { claimToken: staged.claimToken }, selectionExclusions: [] });
      const publicationResult = publication.then(() => ({ rejected: false as const }), (error) => ({ rejected: true as const, error }));
      await waitUntilAConnectionIsWaitingForAccountAdvisoryLock(observerDatabase);

      releaseStop.resolve();
      await expect(stop).resolves.toMatchObject({ applied: true, state: { stoppedAt: expect.any(String) } });
      await expect(publicationResult).resolves.toMatchObject({ rejected: true, error: expect.objectContaining({ message: "DEEP_MATCH_CLAIM_LOST" }) });
      await expect(Promise.all([
        db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId)),
        db.select().from(recommendationListItems).where(eq(recommendationListItems.userId, input.userId)),
        db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId)),
        db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, input.userId)),
      ])).resolves.toEqual([[], [], [], []]);
    } finally {
      releaseStop.resolve();
      await Promise.allSettled([stop, ...(publication ? [publication] : [])]);
      await stopDatabase.$client.end();
      await publicationDatabase.$client.end();
      await observerDatabase.$client.end();
    }
  }, 60_000);

  it("onPublished 失败时回滚推荐清单、Inbox、运行完成写入与旅程完成事实", async () => {
    const input = await fixture();
    await expect(publishStagedFixture(input, {
      onPublished: async (transaction) => {
        await transaction.update(agentRuns).set({
          status: "completed", currentStep: "completed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null,
          completedAt: now, terminationKind: "completed", usageComplete: true, updatedAt: now,
        }).where(eq(agentRuns.userId, input.userId));
        throw new Error("PUBLISHED_CALLBACK_FAILED");
      },
    })).rejects.toThrow("PUBLISHED_CALLBACK_FAILED");

    await expect(Promise.all([
      db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId)),
      db.select().from(recommendationListItems).where(eq(recommendationListItems.userId, input.userId)),
      db.select().from(agentInboxItems).where(eq(agentInboxItems.userId, input.userId)),
      db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, input.userId)),
      db.select({ status: agentRuns.status, currentStep: agentRuns.currentStep }).from(agentRuns).where(eq(agentRuns.userId, input.userId)),
    ])).resolves.toEqual([[], [], [], [], [{ status: "running", currentStep: "assess_matches" }]]);
  });

  it("可信发布完成事实按账户隔离", async () => {
    const owner = await fixture();
    const other = await fixture();
    await publishStagedFixture(owner);

    await expect(db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, owner.userId)))
      .resolves.toHaveLength(1);
    await expect(db.select().from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, other.userId)))
      .resolves.toEqual([]);
  });

  it("keyset-paginates fixture histories and exclusions without duplicate cursor rows", async () => {
    const input = await fixture();
    const listIds = Array.from({ length: 21 }, () => crypto.randomUUID());
    await db.insert(recommendationLists).values(listIds.map((id, index) => ({ id, userId: input.userId, targetId: input.targetId, localDate: "2026-09-01", sequence: index + 1, createdAt: sql`transaction_timestamp()` })));
    const owner = { userId: input.userId, profileId: input.profileId, targetId: input.targetId };
    const exclusions = await Promise.all(Array.from({ length: 26 }, async () => ({ opportunityId: (await fixture({ owner, verdict: "fail" })).opportunityId })));
    await db.insert(recommendationExclusions).values(exclusions.map((entry) => ({ id: crypto.randomUUID(), userId: input.userId, targetId: input.targetId, recommendationListId: listIds[20]!, opportunityId: entry.opportunityId, reasonCode: "TRIAGE_NOT_PASS", createdAt: sql`transaction_timestamp()` })));
    const queries = createDeepMatchQueries({ db });
    const first = await queries.getListHistoryPage({ userId: input.userId, targetId: input.targetId, limit: 20 });
    const second = await queries.getListHistoryPage({ userId: input.userId, targetId: input.targetId, cursor: first.nextCursor!, limit: 20 });
    expect(new Set([...first.items, ...second.items].map((item) => item.recommendationListId)).size).toBe(21);
    const pageOne = await queries.getListExclusionsPage({ userId: input.userId, targetId: input.targetId, recommendationListId: listIds[20]!, limit: 25 });
    const pageTwo = await queries.getListExclusionsPage({ userId: input.userId, targetId: input.targetId, recommendationListId: listIds[20]!, cursor: pageOne.nextCursor!, limit: 25 });
    expect(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.opportunityId)).size).toBe(26);
    const latest = await queries.getLatestList({ userId: input.userId, targetId: input.targetId });
    expect(latest).toMatchObject({ recommendationListId: listIds[20], exclusionsNextCursor: expect.any(String) });
    expect(latest?.exclusions).toHaveLength(25);
    await expect(queries.getListExclusionsPage({ userId: input.userId, targetId: input.targetId, recommendationListId: listIds[20]!, cursor: latest!.exclusionsNextCursor!, limit: 25 })).resolves.toMatchObject({ items: [expect.any(Object)], nextCursor: null });
  }, 60_000);

  it("账户停止且 run pause 标记丢失后 publishStagedRun 不发布 recommendation", async () => {
    const input = await fixture();
    const staged = await stageFixture(input);
    await createAccountRunControl({ db, auditTrail: createAuditTrail({ db, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .control({ userId: input.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await db.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, staged.runId));

    await expect(staged.commands.publishStagedRun({ userId: input.userId, targetId: input.targetId, runId: staged.runId, fence: { claimToken: staged.claimToken }, selectionExclusions: [] })).rejects.toThrow("DEEP_MATCH_CLAIM_LOST");
    await expect(Promise.all([
      db.select().from(recommendationLists).where(eq(recommendationLists.userId, input.userId)),
      db.select().from(jobMatchVersions).where(eq(jobMatchVersions.userId, input.userId)),
    ])).resolves.toEqual([[], []]);
  });

  it("账户停止且 run pause 标记丢失后 stageValidatedAssessment 不暂存模型结果", async () => {
    const input = await fixture();
    const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now });
    const started = await starter.start({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), trigger: "manual" });
    const claimToken = crypto.randomUUID();
    await db.update(agentRuns).set({ status: "running", currentStep: "assess_matches", attemptCount: 1, startedAt: now, activeSliceStartedAt: now, claimToken, claimExpiresAt: new Date(now.getTime() + 30_000), controlState: "none" }).where(eq(agentRuns.id, started.runId));
    const commands = createDeepMatchCommands({ db, id: () => crypto.randomUUID(), clock: () => now });
    const candidate = (await createDeepMatchQueries({ db }).getFrozenCandidates({ userId: input.userId, runId: started.runId }))[0]!;
    const result = await commands.invokeAndValidate({ userId: input.userId, runId: started.runId, candidate, modelCall: modelCall() });
    await createAccountRunControl({ db, auditTrail: createAuditTrail({ db, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .control({ userId: input.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });
    await db.update(agentRuns).set({ controlState: "none" }).where(eq(agentRuns.id, started.runId));

    await expect(commands.stageValidatedAssessment({ userId: input.userId, runId: started.runId, claimToken, candidate, assessment: result.assessment, usage: result.usage })).rejects.toThrow("DEEP_MATCH_CLAIM_LOST");
    await expect(db.select({ assessment: deepMatchRunCandidates.assessment }).from(deepMatchRunCandidates).where(and(eq(deepMatchRunCandidates.runId, started.runId), eq(deepMatchRunCandidates.opportunityId, candidate.opportunityId))))
      .resolves.toEqual([{ assessment: null }]);
  });

  it("账户停止拒绝新的手动与 automatic deep-match child，已存幂等事实只回放且不复活", async () => {
    const input = await fixture();
    const starter = createDeepMatchRunStarter({ db, queue: { enqueue: async () => undefined }, id: () => crypto.randomUUID(), clock: () => now });
    const manualKey = crypto.randomUUID();
    const automaticKey = crypto.randomUUID();
    const existingManual = await starter.start({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: manualKey, trigger: "manual" });
    const existingAutomatic = await starter.start({ userId: input.userId, targetId: input.targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: automaticKey, trigger: "automatic" });
    await createAccountRunControl({ db, auditTrail: createAuditTrail({ db, clock: () => now }), id: () => crypto.randomUUID(), clock: () => now })
      .control({ userId: input.userId, requestId: crypto.randomUUID(), command: { commandId: crypto.randomUUID(), expectedVersion: 0, action: "stop" } });

    await expect(starter.start({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: crypto.randomUUID(), trigger: "manual" }))
      .rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED" });
    await expect(starter.start({ userId: input.userId, targetId: input.targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), trigger: "automatic" }))
      .rejects.toMatchObject({ code: "ACCOUNT_RUN_STOPPED" });
    await expect(starter.start({ userId: input.userId, targetId: input.targetId, opportunityId: input.opportunityId, idempotencyKey: manualKey, trigger: "manual" }))
      .resolves.toMatchObject({ kind: "created", runId: existingManual.runId, reused: true });
    await expect(starter.start({ userId: input.userId, targetId: input.targetId, discoveryRunId: crypto.randomUUID(), idempotencyKey: automaticKey, trigger: "automatic" }))
      .resolves.toMatchObject({ kind: "created", runId: existingAutomatic.runId, reused: true });
    await expect(db.select({ id: agentRuns.id, status: agentRuns.status }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), eq(agentRuns.status, "paused"))))
      .resolves.toEqual(expect.arrayContaining([{ id: existingManual.runId, status: "paused" }, { id: existingAutomatic.runId, status: "paused" }]));
  });

});
