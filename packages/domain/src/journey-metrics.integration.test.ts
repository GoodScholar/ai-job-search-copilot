import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentRuns, careerDocuments, careerImports, companyWatchlists, companyWatchlistRevisions, firstRecommendationJourneyCompletions, jobProfiles, profileFacts, profileFactRevisions, modelDiagnosticResults, jobTargets, jobTargetRevisions, recommendationLists, createDatabase, migrateDatabase, type Database } from "@job-copilot/database";
import { createAccountSessions } from "./account-sessions";
import { createAuditTrail } from "./audit-trail";
import { createModelDiagnosticProjectionReader, createRunPreflightEvaluator } from "./run-preflight";
import { createJourneyMetrics } from "./journey-metrics";

const start = new Date("2026-09-19T00:00:00.000Z");
describe("首次推荐旅程最小指标", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let now = start;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = createDatabase(container.getConnectionUri());
    await migrateDatabase(db);
  }, 60_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE job_accounts, model_diagnostic_results CASCADE`); now = start; });
  afterAll(async () => { await db?.$client.end(); await container?.stop(); });
  const clock = () => now;
  const metrics = (database = db) => createJourneyMetrics({ db: database, clock, runPreflight: createRunPreflightEvaluator({
    clock, id: randomUUID, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: "test-metrics-deployment" }), discoveryExecutionMode: "greenhouse",
    capabilityAdapter: { adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", contractVersion: "source-capabilities-v1", capabilities: ["active_discovery", "read_details"] }) },
  }) });
  async function login(subject: string) {
    return createAccountSessions({ db, sessionTtlMs: 3_600_000, tokenSource: randomUUID, auditTrail: createAuditTrail({ db, clock }) })
      .startDevSession({ subject, now, requestId: randomUUID() });
  }
  it("只统计明确登记的邀请账户，首次登录时间跨会话保持稳定，导出无身份且并发观察不重复", async () => {
    now = start;
    const subject = `private-email-${randomUUID()}@example.test`;
    const session = await login(subject);
    const service = metrics();
    await service.collect();
    expect(await service.events()).toEqual([]);
    const journeyId = await service.enroll({ userId: session.account.userId, configuration: "valid" });
    expect(await service.enroll({ userId: session.account.userId, configuration: "valid" })).toBe(journeyId);
    now = new Date(start.getTime() + 60_000);
    await login(subject);
    await Promise.all([service.collect(), metrics().collect()]);
    const events = await service.events();
    expect(events.filter((e) => e.type === "started")).toMatchObject([{ journeyId, occurredAt: start.toISOString(), elapsedMs: 0, configuration: "valid" }]);
    expect(events.filter((e) => e.type === "blocked")).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: "MODEL_DIAGNOSTIC_UNAVAILABLE" })]));
    expect(events.some((e) => e.type === "completed")).toBe(false);
    const exported = JSON.stringify(events);
    for (const privateValue of [subject, session.account.userId, session.sessionToken, "userId", "email", "metadata"]) expect(exported).not.toContain(privateValue);
    expect(await service.summary()).toMatchObject({ eligibleJourneys: 1, evaluatedJourneys: 0, pendingJourneys: 1, completedWithin20Minutes: 0, completionRate: null });
  });
  it("首个发布事实的两种结局永久完成，空数组不完成；采集重试和后续退化不重复计数", async () => {
    const service = metrics();
    for (const kind of ["recommendation_list", "no_recommendations"] as const) {
      now = start;
      const { account: { userId } } = await login(randomUUID());
      const journeyId = await service.enroll({ userId, configuration: "valid" });
      const targetId = randomUUID(); const resultId = randomUUID();
      await db.insert(jobTargets).values({ id: targetId, userId, priority: "primary", state: "active", activeSlot: null, version: 1 });
      await db.insert(recommendationLists).values({ id: resultId, userId, targetId, sequence: 1, localDate: "2026-09-19" });
      await service.collect();
      expect((await service.events()).filter((e) => e.journeyId === journeyId && e.type === "completed")).toEqual([]);
      // 由发布器持有的不可变事实；真实发布器的两种结局另由既有集成测试/E2E 验证。
      await db.insert(firstRecommendationJourneyCompletions).values({ userId, resultId, resultKind: kind, completedAt: new Date(start.getTime() + 1_200_000) });
      now = new Date(start.getTime() + 1_260_000);
      await Promise.all([service.collect(), metrics().collect()]);
      await service.collect();
      expect((await service.events()).filter((e) => e.journeyId === journeyId && e.type === "completed"))
        .toMatchObject([{ terminalStatus: kind, elapsedMs: 1_200_000, occurredAt: "2026-09-19T00:20:00.000Z" }]);
    }
    expect(await service.summary()).toMatchObject({ eligibleJourneys: 2, evaluatedJourneys: 2, completedWithin20Minutes: 2, completionRate: 1 });
  });
  it("运行终止只投影稳定原因，未知失败不冒充已知阻塞，失效配置不进入分母", async () => {
    now = start;
    const { account: { userId } } = await login(randomUUID());
    const service = metrics(); const journeyId = await service.enroll({ userId, configuration: "invalid" });
    const targetId = randomUUID();
    await db.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await db.insert(agentRuns).values({ id: randomUUID(), userId, targetId, targetVersion: 1, idempotencyKey: randomUUID(), targetSnapshot: { private: "resume secret" }, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "job-discovery-workflow-v1", ruleVersion: "v1", adapter: "fake", adapterVersion: "v1", outputSchemaVersion: "v1", toolAllowlist: [], status: "failed", currentStep: "failed", startedAt: start, failedAt: new Date(start.getTime() + 30_000), failureCode: "AGENT_RUN_ADAPTER_FAILED", queuedAt: start });
    now = new Date(start.getTime() + 1_260_000);
    await service.collect();
    const events = (await service.events()).filter((e) => e.journeyId === journeyId);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "terminated", terminalStatus: "failed", reasonCode: "UNKNOWN_BLOCKER", elapsedMs: 30_000 })]));
    expect(JSON.stringify(events)).not.toContain("resume secret");
    expect(await service.summary()).toMatchObject({ eligibleJourneys: 0, invalidConfigurationJourneys: 1, unknownBlockedJourneys: 0 });
  });

  it("有效邀请账户的未知终止不会被已知准备阻塞掩盖；晚于20分钟完成不计入成功", async () => {
    now = start;
    const { account: { userId } } = await login(randomUUID());
    const service = metrics(); const journeyId = await service.enroll({ userId, configuration: "valid" });
    await expect(service.enroll({ userId, configuration: "invalid" })).rejects.toThrow("JOURNEY_METRIC_ENROLLMENT_IMMUTABLE");
    const targetId = randomUUID();
    await db.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await db.insert(agentRuns).values({ id: randomUUID(), userId, targetId, targetVersion: 1, idempotencyKey: randomUUID(), targetSnapshot: {}, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "job-discovery-workflow-v1", ruleVersion: "v1", adapter: "fake", adapterVersion: "v1", outputSchemaVersion: "v1", toolAllowlist: [], status: "failed", currentStep: "failed", startedAt: start, failedAt: new Date(start.getTime() + 30_000), failureCode: "AGENT_RUN_ADAPTER_FAILED", queuedAt: start });
    now = new Date(start.getTime() + 1_200_001);
    await service.collect();
    expect(await service.summary()).toMatchObject({ eligibleJourneys: 1, completedWithin20Minutes: 0, unknownBlockedJourneys: 1 });
    await db.insert(firstRecommendationJourneyCompletions).values({ userId, resultId: randomUUID(), resultKind: "no_recommendations", completedAt: now });
    await service.collect();
    expect((await service.events()).filter((e) => e.journeyId === journeyId && e.type === "completed")).toMatchObject([{ elapsedMs: 1_200_001 }]);
    expect(await service.summary()).toMatchObject({ eligibleJourneys: 1, completedWithin20Minutes: 0, completionRate: 0, unknownBlockedJourneys: 1 });
  });


  it("准备就绪但用户未开始运行只计入未达时效，不臆造未知产品阻塞", async () => {
    const { account: { userId } } = await login(randomUUID());
    const service = metrics(); const journeyId = await service.enroll({ userId, configuration: "valid" });
    const targetId = randomUUID(); const profileId = randomUUID(); const factId = randomUUID(); const documentId = randomUUID(); const watchlistId = randomUUID();
    await db.insert(careerDocuments).values({ id: documentId, userId, checksumSha256: "a".repeat(64), objectKey: "private/resume", originalFilename: "private-resume.md", mediaType: "text/markdown", byteSize: 1 });
    await db.insert(careerImports).values({ id: randomUUID(), userId, careerDocumentId: documentId, originatingRequestId: randomUUID(), status: "completed", completedAt: start });
    await db.insert(jobProfiles).values({ id: profileId, userId, version: 1 });
    await db.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill" });
    await db.insert(profileFactRevisions).values({ id: randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "private skill" }, state: "active", source: "user_confirmed", profileVersion: 1 });
    await db.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null });
    await db.insert(jobTargetRevisions).values({ id: randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints: { roleFamily: "private role", seniority: null, locations: [], workModes: [], relocation: "unknown", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } } });
    await db.insert(companyWatchlists).values({ id: watchlistId, userId, targetId, version: 1 });
    await db.insert(companyWatchlistRevisions).values({ id: randomUUID(), userId, watchlistId, targetId, version: 1, items: [{ itemId: randomUUID(), canonicalCompanyName: "private company", careersUrl: "https://boards.greenhouse.io/example", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: "private key", state: "enabled", position: 1 }] });
    await db.insert(modelDiagnosticResults).values({ configurationFingerprint: "test-metrics-deployment", status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", checkedAt: start, latencyBucket: "under_1s" });
    await service.collect();
    now = new Date(start.getTime() + 1_260_000);
    await service.collect();
    const events = (await service.events()).filter((e) => e.journeyId === journeyId);
    expect(events.filter((e) => e.type === "stage_reached").map((e) => e.stage).sort()).toEqual(["career_materials", "job_sources", "primary_target", "profile_evidence", "run_readiness"]);
    expect(events.some((e) => e.reasonCode === "UNKNOWN_BLOCKER")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(await service.summary()).toMatchObject({ evaluatedJourneys: 1, missed20MinuteTarget: 1, unknownBlockedJourneys: 0 });
  });
  async function holdDiagnosticReads() {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const work = db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE model_diagnostic_results IN ACCESS EXCLUSIVE MODE`);
      acquired();
      await barrier;
    });
    await ready;
    return { release: async () => { release(); await work; } };
  }
  it("采集中发布完成后只补采完成事实，不写入过期的准备阻塞", async () => {
    const { account: { userId } } = await login(randomUUID());
    const service = metrics(); const journeyId = await service.enroll({ userId, configuration: "valid" });
    now = new Date(start.getTime() + 1_260_000);
    const lock = await holdDiagnosticReads();
    const work = service.collect();
    try {
      await expect.poll(async () => {
        const rows = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'select %model_diagnostic_results%') as waiting`);
        return rows[0]?.waiting;
      }).toBe(true);
      await db.insert(firstRecommendationJourneyCompletions).values({ userId, resultId: randomUUID(), resultKind: "no_recommendations", completedAt: now });
    } finally { await lock.release(); }
    await work;
    const events = (await service.events()).filter((e) => e.journeyId === journeyId);
    expect(events.map((e) => e.type).sort()).toEqual(["completed", "started"]);
  });
  it("指标读取故障不能伪造用户未知阻塞，恢复后仍能继续采集", async () => {
    const { account: { userId } } = await login(randomUUID());
    const service = metrics(); await service.enroll({ userId, configuration: "valid" });
    const url = new URL(container.getConnectionUri()); url.searchParams.set("options", "-c statement_timeout=100");
    const timedDb = createDatabase(url.toString());
    const lock = await holdDiagnosticReads();
    try {
      await expect(metrics(timedDb).collect()).rejects.toThrow("JOURNEY_METRIC_COLLECTION_FAILED");
    } finally { await lock.release(); await timedDb.$client.end(); }
    expect((await service.events()).some((e) => e.reasonCode === "UNKNOWN_BLOCKER")).toBe(false);
    await service.collect();
    expect((await service.events()).some((e) => e.reasonCode === "MODEL_DIAGNOSTIC_UNAVAILABLE")).toBe(true);
  });

});
