import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import {
  accountRunPolicies, accountRunPolicyRevisions, agentRuns, companyWatchlistRevisions, companyWatchlists,
  createDatabase, jobAccounts, jobProfiles, jobSourceHealthChecks, jobTargetRevisions, jobTargets,
  migrateDatabase, modelDiagnosticResults, profileFactRevisions, profileFacts, type Database,
} from "@job-copilot/database";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { createAuditTrail } from "./audit-trail";
import { createAccountRunControl } from "./account-run-control";
import type { SourceCapabilityAdapter } from "./source-capabilities";
import {
  RunPreflightRejectedError, authorizeRunPreflight, createRunPreflightEvaluator,
  createRunPreflightQueries, createModelDiagnosticProjectionReader, fingerprintRunPreflightWarnings,
} from "./run-preflight";

const now = new Date("2026-09-05T12:00:00.000Z");
const constraints = {
  roleFamily: "sentinel-role-not-for-projection", seniority: null, locations: [], workModes: [], relocation: "unknown" as const, salary: null, industries: [],
  dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
};
const completeCapabilities = ["active_discovery", "read_details", "continuous_monitoring", "safe_open_original_page"] as const;

function capabilityAdapter(capabilities: readonly (typeof completeCapabilities)[number][] = completeCapabilities): SourceCapabilityAdapter {
  return {
    adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2",
    declareCapabilities: ({ sourceId }) => ({ sourceId, adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2", contractVersion: "source-capabilities-v1", capabilities: [...capabilities] }),
  };
}

describe("统一运行前检查", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;
  const fingerprint = "deployment-fingerprint-secret-sentinel";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function account(input: { fact?: boolean; source?: "greenhouse" | "anysearch" | "disabled"; secondary?: boolean } = {}) {
    const userId = randomUUID(); const targetId = randomUUID(); const secondaryTargetId = randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    await database.insert(jobTargets).values({ id: targetId, userId, version: 1, priority: "primary", state: "active", activeSlot: null, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId, targetId, version: 1, priority: "primary", state: "active", constraints, createdAt: now });
    if (input.secondary) {
      await database.insert(jobTargets).values({ id: secondaryTargetId, userId, version: 1, priority: "secondary", state: "active", activeSlot: 1, createdAt: now, updatedAt: now });
      await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId, targetId: secondaryTargetId, version: 1, priority: "secondary", state: "active", constraints, createdAt: now });
    }
    if (input.fact) await addFact(userId);
    if (input.source) await addSource(userId, targetId, input.source);
    return { userId, targetId, secondaryTargetId };
  }

  async function addFact(userId: string, state: "active" | "removed" = "active") {
    const profileId = randomUUID(); const factId = randomUUID();
    await database.insert(jobProfiles).values({ id: profileId, userId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(profileFacts).values({ id: factId, userId, profileId, factType: "skill", createdAt: now });
    await database.insert(profileFactRevisions).values({ id: randomUUID(), userId, profileFactId: factId, revisionNumber: 1, factType: "skill", factValue: { name: "sentinel-profile-text" }, state, source: "user_confirmed", candidateFactId: null, reason: "raw-error-sentinel", profileVersion: 1, createdAt: now });
  }

  async function addSource(userId: string, targetId: string, kind: "greenhouse" | "anysearch" | "disabled") {
    const itemId = randomUUID(); const watchlistId = randomUUID();
    const enabled = kind !== "disabled";
    const careersUrl = kind === "anysearch" ? "https://careers.example.test/jobs" : "https://boards.greenhouse.io/sentinelboard";
    const allowedDomains = kind === "anysearch" ? ["example.test"] : ["boards.greenhouse.io", "boards-api.greenhouse.io"];
    await database.insert(companyWatchlists).values({ id: watchlistId, userId, targetId, version: 1, createdAt: now, updatedAt: now });
    await database.insert(companyWatchlistRevisions).values({ id: randomUUID(), userId, watchlistId, targetId, version: 1, createdAt: now, items: [{ itemId, canonicalCompanyName: "sentinel-company", careersUrl, allowedDomains, sourceNote: "api-key-secret-sentinel", state: enabled ? "enabled" : "disabled", position: 1 }] });
    return itemId;
  }

  async function addSecondGreenhouseSource(userId: string, targetId: string) {
    const [watchlist] = await database.select({ id: companyWatchlists.id, version: companyWatchlists.version, items: companyWatchlistRevisions.items })
      .from(companyWatchlists).innerJoin(companyWatchlistRevisions, and(eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id), eq(companyWatchlistRevisions.version, companyWatchlists.version)))
      .where(and(eq(companyWatchlists.userId, userId), eq(companyWatchlists.targetId, targetId)));
    const itemId = randomUUID(); const version = watchlist!.version + 1;
    const items = [...(watchlist!.items as object[]), { itemId, canonicalCompanyName: "second-sentinel-company", careersUrl: "https://boards.greenhouse.io/secondboard", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: "second-secret", state: "enabled", position: 2 }];
    await database.update(companyWatchlists).set({ version, updatedAt: now }).where(eq(companyWatchlists.id, watchlist!.id));
    await database.insert(companyWatchlistRevisions).values({ id: randomUUID(), userId, watchlistId: watchlist!.id, targetId, version, items, createdAt: now });
    return itemId;
  }

  function evaluator(input: { capabilities?: readonly (typeof completeCapabilities)[number][]; mode?: "greenhouse" | "fake" | "layered_public"; modelFingerprint?: string } = {}) {
    return createRunPreflightEvaluator({ capabilityAdapter: capabilityAdapter(input.capabilities ?? completeCapabilities), modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: input.modelFingerprint ?? fingerprint }), discoveryExecutionMode: input.mode ?? "greenhouse", id: randomUUID, clock: () => now });
  }
  const get = async (input: Parameters<ReturnType<typeof createRunPreflightQueries>["get"]>[0], value = evaluator()) => createRunPreflightQueries({ db: database, evaluator: value }).get(input);

  it("warning fingerprint 的 workflow、targetId 与 code 各自独立参与哈希", () => {
    const warning = {
      code: "SOURCE_HEALTH_UNCHECKED" as const,
      evidence: { kind: "source_health" as const, checkedSourceCount: 1, healthySourceCount: 1, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: "2026-09-05T12:00:00.000Z" },
      suggestedActions: ["review_source_health" as const],
    };
    const base = fingerprintRunPreflightWarnings({ workflow: "discovery", trigger: "manual", targetId: "11111111-1111-4111-8111-111111111111", warnings: [warning] });
    expect(fingerprintRunPreflightWarnings({ workflow: "deep_match", trigger: "manual", targetId: "11111111-1111-4111-8111-111111111111", warnings: [warning] })).not.toBe(base);
    expect(fingerprintRunPreflightWarnings({ workflow: "discovery", trigger: "manual", targetId: "22222222-2222-4222-8222-222222222222", warnings: [warning] })).not.toBe(base);
    expect(fingerprintRunPreflightWarnings({ workflow: "discovery", trigger: "manual", targetId: "11111111-1111-4111-8111-111111111111", warnings: [{ ...warning, code: "SOURCE_HEALTH_DEGRADED" }] })).not.toBe(base);
  });

  it("warning fingerprint 按安全语义稳定排序，不受 warning 输入顺序影响", () => {
    const source = { code: "SOURCE_HEALTH_UNCHECKED" as const, evidence: { kind: "source_health" as const, checkedSourceCount: 0, healthySourceCount: 0, degradedSourceCount: 0, uncheckedSourceCount: 1, latestCheckedAt: null }, suggestedActions: ["review_source_health" as const] };
    const capability = { code: "SOURCE_CAPABILITY_PARTIAL" as const, evidence: { kind: "source_capability" as const, enabledSourceCount: 2, capableSourceCount: 1, status: "partial" as const, checkedAt: now.toISOString() }, suggestedActions: ["review_source_capabilities" as const] };
    const input = { workflow: "discovery" as const, trigger: "manual" as const, targetId: "11111111-1111-4111-8111-111111111111" };
    expect(fingerprintRunPreflightWarnings({ ...input, warnings: [source, capability] })).toBe(fingerprintRunPreflightWarnings({ ...input, warnings: [capability, source] }));
  });

  it("当前账户的职业文本、URL、域名和原始错误不会泄漏到安全投影", async () => {
    const owner = await account({ source: "greenhouse" }); await addFact(owner.userId, "removed"); const other = await account({ fact: true, source: "greenhouse" });
    const report = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(report.targetId).toBe(owner.targetId);
    expect(report.status).toBe("blocked");
    expect(report.items.map((item) => item.code)).toEqual(["PROFILE_EVIDENCE_MISSING", "PRIMARY_JOB_TARGET_READY", "REQUESTED_JOB_TARGET_READY", "SOURCE_CAPABILITY_READY", "SOURCE_HEALTH_UNCHECKED", "MODEL_DIAGNOSTIC_UNAVAILABLE", "ACCOUNT_RUN_POLICY_READY"]);
    expect(report.items[0]?.evidence).toMatchObject({ kind: "profile", activeTrustedFactCount: 0 });
    expect(report.items[3]?.evidence).toMatchObject({ kind: "source_capability", enabledSourceCount: 1 });
    expect(JSON.stringify(report)).not.toContain("sentinel-profile-text");
    expect(JSON.stringify(report)).not.toContain("api-key-secret-sentinel");
    expect(JSON.stringify(report)).not.toContain("https://boards.greenhouse.io/sentinelboard");
    expect(JSON.stringify(report)).not.toContain("boards-api.greenhouse.io");
    expect(JSON.stringify(report)).not.toContain("raw-error-sentinel");
    expect(JSON.stringify(report)).not.toContain(fingerprint);
    expect(other.targetId).not.toBe(report.targetId);
  });

  it("活动次目标可被请求，缺失和停用 requested target 稳定阻塞，removed 最新事实不计数", async () => {
    const owner = await account({ fact: true, source: "greenhouse", secondary: true });
    const requested = await get({ userId: owner.userId, targetId: owner.secondaryTargetId, workflow: "discovery", trigger: "manual" });
    expect(requested.targetId).toBe(owner.secondaryTargetId);
    expect(requested.items[2]?.code).toBe("REQUESTED_JOB_TARGET_READY");
    await database.update(jobTargets).set({ state: "inactive", activeSlot: null }).where(and(eq(jobTargets.userId, owner.userId), eq(jobTargets.id, owner.secondaryTargetId)));
    const inactive = await get({ userId: owner.userId, targetId: owner.secondaryTargetId, workflow: "discovery", trigger: "manual" });
    expect(inactive.items[2]?.code).toBe("REQUESTED_JOB_TARGET_INACTIVE");
    const missing = await get({ userId: owner.userId, targetId: randomUUID(), workflow: "discovery", trigger: "manual" });
    expect(missing.items[2]?.code).toBe("REQUESTED_JOB_TARGET_MISSING");
    const removedOwner = await account({ source: "greenhouse" }); await addFact(removedOwner.userId, "removed");
    const removed = await get({ userId: removedOwner.userId, workflow: "discovery", trigger: "manual" });
    expect(removed.items[0]?.code).toBe("PROFILE_EVIDENCE_MISSING");
  });

  it("只把 enabled Greenhouse 视作真实来源：全数缺能力阻塞，只有部分缺能力才警告", async () => {
    const anySearch = await account({ fact: true, source: "anysearch" });
    expect((await get({ userId: anySearch.userId, workflow: "discovery", trigger: "manual" })).items[3]?.code).toBe("SOURCE_CAPABILITY_UNAVAILABLE");
    const disabled = await account({ fact: true, source: "disabled" });
    expect((await get({ userId: disabled.userId, workflow: "discovery", trigger: "manual" })).items[3]?.evidence).toMatchObject({ kind: "source_capability", enabledSourceCount: 0 });
    const partial = await account({ fact: true, source: "greenhouse" });
    const manual = await get({ userId: partial.userId, workflow: "discovery", trigger: "manual" }, evaluator({ capabilities: ["active_discovery", "read_details"] }));
    expect(manual.items[3]).toMatchObject({ code: "SOURCE_CAPABILITY_READY", severity: "informational" });
    const schedule = await get({ userId: partial.userId, workflow: "discovery", trigger: "schedule", scheduledFor: now }, evaluator({ capabilities: ["active_discovery", "read_details"] }));
    expect(schedule.items[3]).toMatchObject({ code: "SOURCE_CAPABILITY_UNAVAILABLE", severity: "blocking", evidence: { enabledSourceCount: 1, capableSourceCount: 0 } });
    await addSecondGreenhouseSource(partial.userId, partial.targetId);
    const partialAdapter: SourceCapabilityAdapter = { ...capabilityAdapter(), declareCapabilities: ({ sourceId }) => ({ ...capabilityAdapter().declareCapabilities({ sourceId }), capabilities: sourceId === "greenhouse:secondboard" ? ["active_discovery", "read_details"] : [...completeCapabilities] }) };
    const partialEvaluator = createRunPreflightEvaluator({ capabilityAdapter: partialAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "greenhouse", id: randomUUID, clock: () => now });
    const mixed = await get({ userId: partial.userId, workflow: "discovery", trigger: "schedule", scheduledFor: now }, partialEvaluator);
    expect(mixed.items[3]).toMatchObject({ code: "SOURCE_CAPABILITY_PARTIAL", severity: "warning", evidence: { enabledSourceCount: 2, capableSourceCount: 1 } });
  });

  it("effective trustedSourceLimit 在能力和健康检查前截断已排序的真实 Greenhouse 来源", async () => {
    const owner = await account({ fact: true, source: "greenhouse" });
    await addSecondGreenhouseSource(owner.userId, owner.targetId);
    const settings = structuredClone(systemAccountRunPolicy().effective);
    settings.discovery.trustedSourceLimit = 0;
    await database.insert(accountRunPolicyRevisions).values({ id: randomUUID(), userId: owner.userId, revisionNumber: 1, settings, createdAt: now });
    await database.insert(accountRunPolicies).values({ userId: owner.userId, currentRevisionNumber: 1, version: 1, updatedAt: now });

    const zero = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(zero.items[3]).toMatchObject({ code: "SOURCE_CAPABILITY_UNAVAILABLE", evidence: { enabledSourceCount: 0, capableSourceCount: 0 } });
    expect(zero.items[4]).toMatchObject({ code: "SOURCE_HEALTH_READY", evidence: { uncheckedSourceCount: 0 } });
    settings.discovery.trustedSourceLimit = 1;
    await database.update(accountRunPolicyRevisions).set({ settings }).where(and(eq(accountRunPolicyRevisions.userId, owner.userId), eq(accountRunPolicyRevisions.revisionNumber, 1)));
    const one = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(one.items[3]).toMatchObject({ code: "SOURCE_CAPABILITY_READY", evidence: { enabledSourceCount: 1, capableSourceCount: 1 } });
    expect(one.items[4]).toMatchObject({ code: "SOURCE_HEALTH_UNCHECKED", evidence: { uncheckedSourceCount: 1 } });
  });

  it("健康检查未检查和退化均非阻塞，并且只按 owner/target/item/source 采用最新记录", async () => {
    const owner = await account({ fact: true, source: "greenhouse" });
    const unverified = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(unverified.items[4]).toMatchObject({ code: "SOURCE_HEALTH_UNCHECKED", severity: "warning" });
    const [watchlist] = await database.select({ items: companyWatchlistRevisions.items }).from(companyWatchlistRevisions).where(eq(companyWatchlistRevisions.targetId, owner.targetId));
    const itemId = (watchlist!.items as Array<{ itemId: string }>)[0]!.itemId;
    const runId = randomUUID();
    await database.insert(agentRuns).values({ id: runId, userId: owner.userId, targetId: owner.targetId, idempotencyKey: randomUUID(), targetVersion: 1, targetSnapshot: { targetId: owner.targetId }, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "job-discovery-workflow-v1", ruleVersion: "fake-job-discovery-rules-v1", adapter: "fake", adapterVersion: "fake-job-discovery-v1", outputSchemaVersion: "job-discovery-result-v1", toolAllowlist: [], queuedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourceHealthChecks).values({ id: randomUUID(), userId: owner.userId, runId, targetId: owner.targetId, watchlistItemId: itemId, sourceId: "greenhouse:sentinelboard", status: "healthy", reasonCodes: [], impactScope: "none", impactAffectedCount: null, observedPostingCount: 1, selectedDetailCount: 1, validDetailCount: 1, requestAttemptCount: 1, checkedAt: new Date("2026-09-05T11:00:00.000Z") });
    expect((await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" })).items[4]).toMatchObject({ code: "SOURCE_HEALTH_READY", severity: "informational" });
    const laterRunId = randomUUID();
    await database.insert(agentRuns).values({ id: laterRunId, userId: owner.userId, targetId: owner.targetId, idempotencyKey: randomUUID(), targetVersion: 1, targetSnapshot: { targetId: owner.targetId }, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "job-discovery-workflow-v1", ruleVersion: "fake-job-discovery-rules-v1", adapter: "fake", adapterVersion: "fake-job-discovery-v1", outputSchemaVersion: "job-discovery-result-v1", toolAllowlist: [], queuedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourceHealthChecks).values({ id: randomUUID(), userId: owner.userId, runId: laterRunId, targetId: owner.targetId, watchlistItemId: itemId, sourceId: "greenhouse:sentinelboard", status: "rate_limited", reasonCodes: ["SOURCE_RATE_LIMITED"], impactScope: "entire_source", impactAffectedCount: null, observedPostingCount: 0, selectedDetailCount: 0, validDetailCount: 0, requestAttemptCount: 1, checkedAt: now });
    const degraded = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(degraded.items[4]).toMatchObject({ code: "SOURCE_HEALTH_DEGRADED", severity: "warning", evidence: { degradedSourceCount: 1, healthySourceCount: 0 } });
    expect(degraded.items[4]?.severity).toBe("warning");
  });

  it("deep match 的来源项仅为非必需信息，策略预算和计划的两个时间窗口及缺失时间可阻塞", async () => {
    const owner = await account({ fact: true });
    const deep = await get({ userId: owner.userId, workflow: "deep_match", trigger: "manual" });
    expect(deep.items.slice(3, 5).map((item) => [item.code, item.severity])).toEqual([["SOURCE_CAPABILITY_NOT_REQUIRED", "informational"], ["SOURCE_HEALTH_NOT_REQUIRED", "informational"]]);
    const settings = structuredClone(systemAccountRunPolicy().effective); settings.budgets.publicDiscovery.maxResults = 0; settings.backgroundWindow = { start: "08:00", end: "10:00", timeZone: "Asia/Shanghai" };
    await database.insert(accountRunPolicyRevisions).values({ id: randomUUID(), userId: owner.userId, revisionNumber: 1, settings, createdAt: now });
    await database.update(accountRunPolicies).set({ currentRevisionNumber: 1, version: 1, updatedAt: now }).where(eq(accountRunPolicies.userId, owner.userId));
    const budget = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(budget.items[6]).toMatchObject({ code: "ACCOUNT_RUN_POLICY_BLOCKED", severity: "blocking" });
    settings.budgets.publicDiscovery.maxResults = 1;
    await database.update(accountRunPolicyRevisions).set({ settings }).where(and(eq(accountRunPolicyRevisions.userId, owner.userId), eq(accountRunPolicyRevisions.revisionNumber, 1)));
    const scheduled = await get({ userId: owner.userId, workflow: "discovery", trigger: "schedule", scheduledFor: new Date("2026-09-05T04:00:00.000Z") });
    expect(scheduled.items[6]?.code).toBe("ACCOUNT_RUN_POLICY_BLOCKED");
    const missingScheduledFor = await get({ userId: owner.userId, workflow: "discovery", trigger: "schedule" });
    expect(missingScheduledFor.items[6]?.code).toBe("ACCOUNT_RUN_POLICY_BLOCKED");
    const manual = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(manual.items[6]?.code).toBe("ACCOUNT_RUN_POLICY_READY");
  });

  it("schedule 分别在当前时刻或 scheduledFor 越出窗口时阻塞", async () => {
    const owner = await account({ fact: true, source: "greenhouse" });
    const settings = structuredClone(systemAccountRunPolicy().effective); settings.backgroundWindow = { start: "08:00", end: "22:00", timeZone: "Asia/Shanghai" };
    await database.insert(accountRunPolicyRevisions).values({ id: randomUUID(), userId: owner.userId, revisionNumber: 1, settings, createdAt: now });
    await database.insert(accountRunPolicies).values({ userId: owner.userId, currentRevisionNumber: 1, version: 1, updatedAt: now });
    const scheduledOutside = await get({ userId: owner.userId, workflow: "discovery", trigger: "schedule", scheduledFor: new Date("2026-09-05T15:00:00.000Z") });
    expect(scheduledOutside.items[6]?.code).toBe("ACCOUNT_RUN_POLICY_BLOCKED");
    const afterHours = createRunPreflightEvaluator({ capabilityAdapter: capabilityAdapter(), modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "greenhouse", id: randomUUID, clock: () => new Date("2026-09-05T15:00:00.000Z") });
    const currentOutside = await get({ userId: owner.userId, workflow: "discovery", trigger: "schedule", scheduledFor: new Date("2026-09-05T04:00:00.000Z") }, afterHours);
    expect(currentOutside.items[6]?.code).toBe("ACCOUNT_RUN_POLICY_BLOCKED");
    const missingScheduledFor = await get({ userId: owner.userId, workflow: "discovery", trigger: "schedule" });
    expect(missingScheduledFor.items[6]?.code).toBe("ACCOUNT_RUN_POLICY_BLOCKED");
  });

  it("账户停止只新增一项 account policy blocker，释放后恢复原策略修订的正常预检", async () => {
    const owner = await account({ fact: true, source: "greenhouse" });
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    const controls = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now });
    await controls.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } });

    const stopped = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(stopped.items).toHaveLength(7);
    expect(stopped.items.filter((item) => item.severity === "blocking")).toEqual([
      expect.objectContaining({ code: "ACCOUNT_RUN_POLICY_BLOCKED", summary: "账户已停止全部运行", suggestedActions: ["review_account_run_policy"] }),
    ]);
    const stoppedPolicy = stopped.items[6]!;
    await controls.control({ userId: owner.userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });

    const released = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(released.items).toHaveLength(7);
    expect(released.items[6]).toMatchObject({ code: "ACCOUNT_RUN_POLICY_READY", severity: "informational", evidence: { revisionNumber: (stoppedPolicy.evidence as { revisionNumber: number }).revisionNumber } });
    expect(released.items.filter((item) => item.severity === "blocking")).toEqual([]);
  });

  it("fingerprint 只由安全警告状态决定，报告顺序和 JSON 稳定，授权矩阵精确执行", async () => {
    const owner = await account({ fact: true, source: "greenhouse" });
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: new Date("2026-09-05T10:00:00.000Z") });
    await addSecondGreenhouseSource(owner.userId, owner.targetId);
    const first = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    const laterEvaluator = createRunPreflightEvaluator({ capabilityAdapter: capabilityAdapter(), modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "greenhouse", id: randomUUID, clock: () => new Date("2026-09-05T13:00:00.000Z") });
    const later = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" }, laterEvaluator);
    expect(first.warningFingerprint).toBe(later.warningFingerprint);
    const scheduledFingerprint = await get({ userId: owner.userId, workflow: "discovery", trigger: "schedule", scheduledFor: now });
    expect(scheduledFingerprint.warningFingerprint).not.toBe(first.warningFingerprint);
    const deepMatchFingerprint = await get({ userId: owner.userId, workflow: "deep_match", trigger: "manual" });
    expect(deepMatchFingerprint.warningFingerprint).not.toBe(first.warningFingerprint);
    const secondaryTargetId = randomUUID();
    await database.insert(jobTargets).values({ id: secondaryTargetId, userId: owner.userId, version: 1, priority: "secondary", state: "active", activeSlot: 1, createdAt: now, updatedAt: now });
    await database.insert(jobTargetRevisions).values({ id: randomUUID(), userId: owner.userId, targetId: secondaryTargetId, version: 1, priority: "secondary", state: "active", constraints, createdAt: now });
    await addSource(owner.userId, secondaryTargetId, "greenhouse");
    const targetFingerprint = await get({ userId: owner.userId, targetId: secondaryTargetId, workflow: "discovery", trigger: "manual" });
    expect(targetFingerprint.warningFingerprint).not.toBe(first.warningFingerprint);
    const firstItemId = (await database.select({ items: companyWatchlistRevisions.items }).from(companyWatchlistRevisions).where(and(eq(companyWatchlistRevisions.userId, owner.userId), eq(companyWatchlistRevisions.targetId, owner.targetId))))[0]!.items as Array<{ itemId: string }>;
    const healthRunId = randomUUID();
    await database.insert(agentRuns).values({ id: healthRunId, userId: owner.userId, targetId: owner.targetId, idempotencyKey: randomUUID(), targetVersion: 1, targetSnapshot: { targetId: owner.targetId }, sourceScope: {}, budgetSnapshot: {}, workflowVersion: "job-discovery-workflow-v1", ruleVersion: "fake-job-discovery-rules-v1", adapter: "fake", adapterVersion: "fake-job-discovery-v1", outputSchemaVersion: "job-discovery-result-v1", toolAllowlist: [], queuedAt: now, createdAt: now, updatedAt: now });
    await database.insert(jobSourceHealthChecks).values({ id: randomUUID(), userId: owner.userId, runId: healthRunId, targetId: owner.targetId, watchlistItemId: firstItemId[0]!.itemId, sourceId: "greenhouse:sentinelboard", status: "healthy", reasonCodes: [], impactScope: "none", impactAffectedCount: null, observedPostingCount: 1, selectedDetailCount: 1, validDetailCount: 1, requestAttemptCount: 1, checkedAt: now });
    const healthFingerprint = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(healthFingerprint.items[4]?.evidence).toMatchObject({ checkedSourceCount: 1, uncheckedSourceCount: 1 });
    expect(healthFingerprint.warningFingerprint).not.toBe(first.warningFingerprint);
    const scheduledAfterHealth = await get({ userId: owner.userId, workflow: "discovery", trigger: "schedule", scheduledFor: now });
    const codeAdapter: SourceCapabilityAdapter = { ...capabilityAdapter(), declareCapabilities: ({ sourceId }) => ({ ...capabilityAdapter().declareCapabilities({ sourceId }), capabilities: sourceId === "greenhouse:secondboard" ? ["active_discovery", "read_details"] : [...completeCapabilities] }) };
    const codeEvaluator = createRunPreflightEvaluator({ capabilityAdapter: codeAdapter, modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "greenhouse", id: randomUUID, clock: () => now });
    const codeFingerprint = await get({ userId: owner.userId, workflow: "discovery", trigger: "schedule", scheduledFor: now }, codeEvaluator);
    expect(codeFingerprint.items[3]?.code).toBe("SOURCE_CAPABILITY_PARTIAL");
    expect(codeFingerprint.warningFingerprint).not.toBe(scheduledAfterHealth.warningFingerprint);
    expect(first.items.map((item) => item.evidence.kind)).toEqual(["profile", "job_target", "job_target", "source_capability", "source_health", "model_diagnostic", "account_run_policy"]);
    const stable = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(JSON.stringify(stable)).toBe(JSON.stringify(await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" })));
    const evaluation = await evaluator().evaluate(database, { userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(() => authorizeRunPreflight({ evaluation, warningFingerprint: null })).toThrowError("RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED");
    expect(() => authorizeRunPreflight({ evaluation, warningFingerprint: "a".repeat(64) })).toThrowError("RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED");
    expect(() => authorizeRunPreflight({ evaluation, warningFingerprint: evaluation.report.warningFingerprint })).not.toThrow();
    const scheduled = await evaluator().evaluate(database, { userId: owner.userId, workflow: "discovery", trigger: "schedule", scheduledFor: now });
    expect(() => authorizeRunPreflight({ evaluation: scheduled, warningFingerprint: null })).not.toThrow();
    const blockedOwner = await account(); const blocked = await evaluator().evaluate(database, { userId: blockedOwner.userId, workflow: "discovery", trigger: "manual" });
    expect(() => authorizeRunPreflight({ evaluation: blocked, warningFingerprint: null })).toThrowError("RUN_PREFLIGHT_BLOCKED");
    expect(() => authorizeRunPreflight({ evaluation, warningFingerprint: null })).toThrow(RunPreflightRejectedError);
  });

  it("模型稳定投影仅查看当前指纹，旧 available 不会触发外部 adapter", async () => {
    const freshFingerprint = "projection-fresh-fingerprint";
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: "other-fingerprint", status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: now });
    await expect(createModelDiagnosticProjectionReader({ configurationFingerprint: freshFingerprint }).get(database, now)).resolves.toMatchObject({ status: "unverified" });
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: freshFingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: new Date("2026-09-05T01:00:00.000Z") });
    await expect(createModelDiagnosticProjectionReader({ configurationFingerprint: freshFingerprint }).get(database, now)).resolves.toMatchObject({ status: "available" });
  });

  it("模型稳定投影遇到 advisory lock 竞争立即返回 checking，且没有外部调用入口", async () => {
    const lockedFingerprint = `locked-projection-${randomUUID()}`; let externalCalls = 0;
    const lock = await database.$client.reserve(); const other = createDatabase(container.getConnectionUri());
    try {
      await lock`begin`; await lock`select pg_advisory_xact_lock(hashtextextended(${lockedFingerprint}, 50))`;
      await expect(createModelDiagnosticProjectionReader({ configurationFingerprint: lockedFingerprint }).get(other, now)).resolves.toMatchObject({ status: "checking" });
      expect(externalCalls).toBe(0);
    } finally { await other.$client.end(); await lock`rollback`; lock.release(); }
  });

  it.each([
    ["failed", "MODEL_DIAGNOSTIC_FAILED"],
    ["temporarily_unavailable", "MODEL_DIAGNOSTIC_PROVIDER_UNAVAILABLE"],
  ] as const)("失败模型稳定投影 %s 仍阻塞运行", async (status, reasonCode) => {
    const owner = await account({ fact: true, source: "greenhouse" }); const modelFingerprint = `blocking-${status}-${randomUUID()}`;
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: modelFingerprint, status, checks: { authentication: "not_verified", modelAvailability: "not_verified", structuredOutput: "not_verified", timeout: "not_verified" }, reasonCode, latencyBucket: "under_1s", checkedAt: now });
    const report = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" }, evaluator({ modelFingerprint }));
    expect(report.items[5]).toMatchObject({ code: "MODEL_DIAGNOSTIC_UNAVAILABLE", severity: "blocking", evidence: { status } });
  });
});
