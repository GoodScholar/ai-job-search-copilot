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
import type { SourceCapabilityAdapter } from "./source-capabilities";
import {
  RunPreflightRejectedError, authorizeRunPreflight, createRunPreflightEvaluator,
  createRunPreflightQueries, createModelDiagnosticProjectionReader,
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

  function evaluator(input: { capabilities?: readonly (typeof completeCapabilities)[number][]; mode?: "greenhouse" | "fake" | "layered_public"; modelFingerprint?: string } = {}) {
    return createRunPreflightEvaluator({ capabilityAdapter: capabilityAdapter(input.capabilities ?? completeCapabilities), modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: input.modelFingerprint ?? fingerprint }), discoveryExecutionMode: input.mode ?? "greenhouse", id: randomUUID, clock: () => now });
  }
  const get = async (input: Parameters<ReturnType<typeof createRunPreflightQueries>["get"]>[0], value = evaluator()) => createRunPreflightQueries({ db: database, evaluator: value }).get(input);

  it("无当前有效画像事实、无主目标或无真实来源会阻塞，且 owner 数据不会串读", async () => {
    const owner = await account(); const other = await account({ fact: true, source: "greenhouse" });
    const report = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(report.targetId).toBe(owner.targetId);
    expect(report.status).toBe("blocked");
    expect(report.items.map((item) => item.code)).toEqual(["PROFILE_EVIDENCE_MISSING", "PRIMARY_JOB_TARGET_READY", "REQUESTED_JOB_TARGET_READY", "SOURCE_CAPABILITY_UNAVAILABLE", "SOURCE_HEALTH_READY", "MODEL_DIAGNOSTIC_UNAVAILABLE", "ACCOUNT_RUN_POLICY_READY"]);
    expect(report.items[0]?.evidence).toMatchObject({ kind: "profile", activeTrustedFactCount: 0 });
    expect(report.items[3]?.evidence).toMatchObject({ kind: "source_capability", enabledSourceCount: 0 });
    expect(JSON.stringify(report)).not.toContain("sentinel-profile-text");
    expect(JSON.stringify(report)).not.toContain("api-key-secret-sentinel");
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

  it("只把 enabled Greenhouse 视作真实来源，能力缺失为警告，计划额外要求持续监控", async () => {
    const anySearch = await account({ fact: true, source: "anysearch" });
    expect((await get({ userId: anySearch.userId, workflow: "discovery", trigger: "manual" })).items[3]?.code).toBe("SOURCE_CAPABILITY_UNAVAILABLE");
    const disabled = await account({ fact: true, source: "disabled" });
    expect((await get({ userId: disabled.userId, workflow: "discovery", trigger: "manual" })).items[3]?.evidence).toMatchObject({ kind: "source_capability", enabledSourceCount: 0 });
    const partial = await account({ fact: true, source: "greenhouse" });
    const manual = await get({ userId: partial.userId, workflow: "discovery", trigger: "manual" }, evaluator({ capabilities: ["active_discovery", "read_details"] }));
    expect(manual.items[3]).toMatchObject({ code: "SOURCE_CAPABILITY_READY", severity: "informational" });
    const schedule = await get({ userId: partial.userId, workflow: "discovery", trigger: "schedule", scheduledFor: now }, evaluator({ capabilities: ["active_discovery", "read_details"] }));
    expect(schedule.items[3]).toMatchObject({ code: "SOURCE_CAPABILITY_PARTIAL", severity: "warning" });
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

  it("deep match 的来源项仅为非必需信息，策略预算和计划的两个时间窗口可阻塞", async () => {
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
    const manual = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    expect(manual.items[6]?.code).toBe("ACCOUNT_RUN_POLICY_READY");
  });

  it("fingerprint 只由安全警告状态决定，报告顺序和 JSON 稳定，授权矩阵精确执行", async () => {
    const owner = await account({ fact: true, source: "greenhouse" });
    await database.insert(modelDiagnosticResults).values({ configurationFingerprint: fingerprint, status: "available", checks: { authentication: "passed", modelAvailability: "passed", structuredOutput: "passed", timeout: "passed" }, reasonCode: "MODEL_DIAGNOSTIC_AVAILABLE", latencyBucket: "under_1s", checkedAt: new Date("2026-09-05T10:00:00.000Z") });
    const first = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" });
    const laterEvaluator = createRunPreflightEvaluator({ capabilityAdapter: capabilityAdapter(), modelDiagnosticReader: createModelDiagnosticProjectionReader({ configurationFingerprint: fingerprint }), discoveryExecutionMode: "greenhouse", id: randomUUID, clock: () => new Date("2026-09-05T13:00:00.000Z") });
    const later = await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" }, laterEvaluator);
    expect(first.warningFingerprint).toBe(later.warningFingerprint);
    expect(first.items.map((item) => item.evidence.kind)).toEqual(["profile", "job_target", "job_target", "source_capability", "source_health", "model_diagnostic", "account_run_policy"]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(await get({ userId: owner.userId, workflow: "discovery", trigger: "manual" })));
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
