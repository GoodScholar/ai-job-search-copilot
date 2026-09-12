import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, jobAccounts, migrateDatabase, type Database } from "@job-copilot/database";
import { createAuditTrail } from "./audit-trail";
import { createAccountRunControl } from "./account-run-control";
import { AccountRunControlError } from "./account-run-control";

describe("账户运行停止控制", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;
  const now = new Date("2026-09-11T00:00:00.000Z");
  beforeAll(async () => { container = await new PostgreSqlContainer("postgres:17-alpine").start(); database = createDatabase(container.getConnectionUri()); await migrateDatabase(database); }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });
  async function account() { const userId = randomUUID(); await database.insert(jobAccounts).values({ id: userId }); return userId; }
  function controls() { return createAccountRunControl({ db: database, auditTrail: createAuditTrail({ db: database, clock: () => now }), id: randomUUID, clock: () => now }); }

  it("停止、释放与重放保留账户控制版本，读取不物化策略基线", async () => {
    const userId = await account();
    const service = controls();
    expect(await service.get({ userId })).toEqual({ stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null });
    const command = { commandId: randomUUID(), expectedVersion: 0, action: "stop" as const };
    const first = await service.control({ userId, requestId: randomUUID(), command });
    expect(first).toMatchObject({ applied: true, state: { controlVersion: 1, stoppedAt: expect.any(String), scheduleResumeAfter: null } });
    const released = await service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } });
    expect(released).toMatchObject({ applied: true, state: { controlVersion: 2, stoppedAt: null, scheduleResumeAfter: expect.any(String) } });
    await expect(service.control({ userId, requestId: randomUUID(), command })).resolves.toEqual(first);
    await expect(service.get({ userId })).resolves.toMatchObject({ stoppedAt: null, controlVersion: 2 });
  });

  it("旧版本、同命令不同载荷与相同状态的新命令分别冲突或不变更版本", async () => {
    const userId = await account(); const service = controls();
    const commandId = randomUUID();
    await service.control({ userId, requestId: randomUUID(), command: { commandId, expectedVersion: 0, action: "stop" } });
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 0, action: "stop" } })).rejects.toMatchObject({ code: "ACCOUNT_RUN_CONTROL_VERSION_CONFLICT" } satisfies Partial<AccountRunControlError>);
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 1, action: "release" } })).resolves.toMatchObject({ applied: true, state: { controlVersion: 2 } });
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId: randomUUID(), expectedVersion: 2, action: "release" } })).resolves.toEqual({ applied: false, state: { stoppedAt: null, controlVersion: 2, scheduleResumeAfter: now.toISOString() } });
    await expect(service.control({ userId, requestId: randomUUID(), command: { commandId, expectedVersion: 0, action: "release" } })).rejects.toMatchObject({ code: "ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT" } satisfies Partial<AccountRunControlError>);
  });
});
