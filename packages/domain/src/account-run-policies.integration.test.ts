import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { accountRunPolicies, createDatabase, jobAccounts, migrateDatabase, type Database } from "@job-copilot/database";
import { eq } from "drizzle-orm";
import { createAccountRunPolicies, AccountRunPolicyError } from "./account-run-policies";
import { createAccountRunControl } from "./account-run-control";
import { createAuditTrail } from "./audit-trail";

describe("账户运行策略", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });

  async function account() {
    const userId = randomUUID();
    await database.insert(jobAccounts).values({ id: userId });
    return userId;
  }
  const settings = (queryLimit = 3) => ({
    discovery: { trustedSourceLimit: 20, publicQueryLimit: queryLimit, verificationCandidateLimit: 8, enabledProviders: ["anysearch"] as ["anysearch"] },
    budgets: {
      publicDiscovery: { maxActiveDurationMs: 120_000, maxAttempts: 2, maxToolCalls: 20, maxResults: 4, maxModelCalls: 0, maxTokens: 0 },
      deepMatch: { maxActiveDurationMs: 120_000, maxAttempts: 2, maxToolCalls: 0, maxResults: 8, maxModelCalls: 5, maxTokens: 10_000 },
      fake: { maxActiveDurationMs: 30_000, maxAttempts: 2, maxToolCalls: 5, maxResults: 3, maxModelCalls: 0, maxTokens: 0 },
    }, backgroundWindow: { start: "22:00", end: "06:00", timeZone: "Asia/Shanghai" as const },
  });

  it("首次读取惰性物化不可变账户基线，后续读取和历史保留首次时间", async () => {
    const userId = await account();
    const firstAt = new Date("2026-09-05T00:00:00.000Z");
    const laterAt = new Date("2026-09-06T00:00:00.000Z");
    const first = createAccountRunPolicies({ db: database, id: randomUUID, clock: () => firstAt });
    await expect(first.get({ userId })).resolves.toMatchObject({ revision: { revisionNumber: 0, isSystemBaseline: true, createdAt: firstAt.toISOString() } });
    const later = createAccountRunPolicies({ db: database, id: randomUUID, clock: () => laterAt });
    await expect(later.get({ userId })).resolves.toMatchObject({ revision: { revisionNumber: 0, createdAt: firstAt.toISOString() } });
    await expect(later.getRevision({ userId, revisionNumber: 0 })).resolves.toMatchObject({ revision: { revisionNumber: 0, createdAt: firstAt.toISOString() } });
    await expect(later.history({ userId })).resolves.toMatchObject({ revisions: [{ revisionNumber: 0, createdAt: firstAt.toISOString() }] });
  });

  it("首次读取返回可追溯系统基线，保存后保留不可变修订历史", async () => {
    const userId = await account();
    const service = createAccountRunPolicies({ db: database, id: randomUUID, clock: () => new Date("2026-09-05T00:00:00.000Z") });
    await expect(service.get({ userId })).resolves.toMatchObject({ revision: { revisionNumber: 0, isSystemBaseline: true }, userSettings: null });
    await expect(service.save({ userId, command: { expectedVersion: 0, settings: settings() } })).resolves.toMatchObject({ revision: { revisionNumber: 1, isSystemBaseline: false }, effective: { discovery: { publicQueryLimit: 3 } } });
    await expect(service.save({ userId, command: { expectedVersion: 1, settings: settings(2) } })).resolves.toMatchObject({ revision: { revisionNumber: 2 }, effective: { discovery: { publicQueryLimit: 2 } } });
    await expect(service.history({ userId })).resolves.toMatchObject({ revisions: [{ revisionNumber: 2 }, { revisionNumber: 1 }, { revisionNumber: 0, isSystemBaseline: true }] });
  });

  it("两个账户的保存、读取和历史严格隔离", async () => {
    const owner = await account(); const other = await account();
    const service = createAccountRunPolicies({ db: database, id: randomUUID, clock: () => new Date() });
    await service.save({ userId: owner, command: { expectedVersion: 0, settings: settings() } });
    await service.save({ userId: other, command: { expectedVersion: 0, settings: settings(2) } });
    await expect(service.get({ userId: owner })).resolves.toMatchObject({ effective: { discovery: { publicQueryLimit: 3 } } });
    await expect(service.get({ userId: other })).resolves.toMatchObject({ effective: { discovery: { publicQueryLimit: 2 } } });
    const [ownerHistory, otherHistory] = await Promise.all([service.history({ userId: owner }), service.history({ userId: other })]);
    expect(ownerHistory.revisions).toContainEqual(expect.objectContaining({ revisionNumber: 1, settings: expect.objectContaining({ discovery: expect.objectContaining({ publicQueryLimit: 3 }) }) }));
    expect(otherHistory.revisions).toContainEqual(expect.objectContaining({ revisionNumber: 1, settings: expect.objectContaining({ discovery: expect.objectContaining({ publicQueryLimit: 2 }) }) }));
  });

  it("同一 expectedVersion 的真正竞争只产生一个修订", async () => {
    const userId = await account();
    const service = createAccountRunPolicies({ db: database, id: randomUUID, clock: () => new Date() });
    const outcomes = await Promise.allSettled([
      service.save({ userId, command: { expectedVersion: 0, settings: settings(3) } }),
      service.save({ userId, command: { expectedVersion: 0, settings: settings(2) } }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")[0]).toMatchObject({ reason: { code: "ACCOUNT_RUN_POLICY_VERSION_CONFLICT" } });
    await expect(service.get({ userId })).resolves.toMatchObject({ revision: { revisionNumber: 1 } });
    await expect(service.history({ userId })).resolves.toMatchObject({ revisions: [{ revisionNumber: 1 }, { revisionNumber: 0 }] });
  });

  it("停止与策略保存串行且分别保留控制版本和策略修订", async () => {
    const userId = await account(); const clock = () => new Date("2026-09-07T00:00:00.000Z");
    const policies = createAccountRunPolicies({ db: database, id: randomUUID, clock });
    const controls = createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock }), id: randomUUID, clock });
    const [stop, saved] = await Promise.all([
      controls.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } }),
      policies.save({ userId, command: { expectedVersion: 0, settings: settings(2) } }),
    ]);
    expect(stop).toMatchObject({ applied: true, state: { controlVersion: 1, stoppedAt: clock().toISOString() } });
    expect(saved).toMatchObject({ revision: { revisionNumber: 1 }, effective: { discovery: { publicQueryLimit: 2 } } });
    await expect(database.select({ version: accountRunPolicies.version, currentRevisionNumber: accountRunPolicies.currentRevisionNumber, controlVersion: accountRunPolicies.controlVersion, stoppedAt: accountRunPolicies.stoppedAt }).from(accountRunPolicies).where(eq(accountRunPolicies.userId, userId))).resolves.toEqual([{ version: 1, currentRevisionNumber: 1, controlVersion: 1, stoppedAt: clock() }]);
  });
});
