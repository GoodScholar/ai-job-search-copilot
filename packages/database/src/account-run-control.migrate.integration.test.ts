import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, migrateDatabase, type Database } from "./index";

describe("账户运行停止控制迁移", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;
  beforeAll(async () => { container = await new PostgreSqlContainer("postgres:17-alpine").start(); database = createDatabase(container.getConnectionUri()); await migrateDatabase(database); }, 60_000);
  afterAll(async () => { await database?.$client.end(); await container?.stop(); });
  async function account() { const id = randomUUID(); await database.execute(sql`insert into job_accounts (id) values (${id})`); return id; }
  const snapshot = (version = 0) => JSON.stringify({ applied: false, state: { stoppedAt: null, controlVersion: version, scheduleResumeAfter: null } });

  it("强制账户控制版本、严格快照、账户内幂等键和不可变命令", async () => {
    const userId = await account(); const otherUserId = await account(); const commandId = randomUUID();
    await database.execute(sql`insert into account_run_policy_revisions (id, user_id, revision_number, settings) values (${randomUUID()}, ${userId}, 0, '{}'::jsonb)`);
    await expect(database.execute(sql`insert into account_run_policies (user_id, current_revision_number, version, control_version) values (${userId}, 0, 0, -1)`)).rejects.toMatchObject({ cause: { constraint_name: "account_run_policies_control_version_nonnegative" } });
    await expect(database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${userId}, ${commandId}, 'unknown', 0, false, ${snapshot()}::jsonb)`)).rejects.toThrow();
    const malformed = JSON.stringify({ applied: false, state: { stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null }, extra: true });
    await expect(database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${userId}, ${commandId}, 'stop', 0, false, ${malformed}::jsonb)`)).rejects.toThrow();
    for (const invalidSnapshot of [JSON.stringify({ applied: false }), JSON.stringify({ applied: "false", state: { stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null } }), JSON.stringify({ applied: false, state: { stoppedAt: null, controlVersion: "0", scheduleResumeAfter: null } })]) {
      await expect(database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${userId}, ${randomUUID()}, 'stop', 0, false, ${invalidSnapshot}::jsonb)`)).rejects.toThrow();
    }
    const oversizedSnapshot = JSON.stringify({ applied: false, state: { stoppedAt: "x".repeat(2_048), controlVersion: 0, scheduleResumeAfter: null } });
    await expect(database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${userId}, ${randomUUID()}, 'stop', 0, false, ${oversizedSnapshot}::jsonb)`)).rejects.toMatchObject({ cause: { constraint_name: "account_run_control_commands_snapshot_check" } });
    await database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${userId}, ${commandId}, 'stop', 0, false, ${snapshot()}::jsonb)`);
    await expect(database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${userId}, ${commandId}, 'stop', 0, false, ${snapshot()}::jsonb)`)).rejects.toThrow();
    await expect(database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${otherUserId}, ${commandId}, 'stop', 0, false, ${snapshot()}::jsonb)`)).resolves.toBeDefined();
    await expect(database.execute(sql`update account_run_control_commands set applied = true where user_id = ${userId} and command_id = ${commandId}`)).rejects.toThrow();
    await expect(database.execute(sql`delete from account_run_control_commands where user_id = ${userId} and command_id = ${commandId}`)).rejects.toThrow();
  });

  it("迁移后的策略行默认未停止，两个调度跳过原因有效而未知值被拒绝", async () => {
    const userId = await account();
    await database.execute(sql`insert into account_run_policy_revisions (id, user_id, revision_number, settings) values (${randomUUID()}, ${userId}, 0, '{}'::jsonb)`);
    const result = await database.execute(sql`insert into account_run_policies (user_id, current_revision_number, version) values (${userId}, 0, 0) returning stopped_at, control_version, schedule_resume_after`);
    expect(result).toEqual([{ stopped_at: null, control_version: 0, schedule_resume_after: null }]);
    const targetId = randomUUID(); const scheduleId = randomUUID();
    await database.execute(sql`insert into job_targets (id, user_id, version, priority, state, active_slot) values (${targetId}, ${userId}, 1, 'primary', 'active', null)`);
    await database.execute(sql`insert into job_discovery_schedules (id, user_id, target_id, version, state, daily_time) values (${scheduleId}, ${userId}, ${targetId}, 1, 'enabled', '09:00')`);
    for (const reason of ["ACCOUNT_RUN_STOPPED", "ACCOUNT_RUN_SCHEDULE_SKIPPED"]) await expect(database.execute(sql`insert into job_discovery_schedule_occurrences (id, user_id, schedule_id, target_id, scheduled_for, status, run_id, skip_reason) values (${randomUUID()}, ${userId}, ${scheduleId}, ${targetId}, now(), 'skipped', null, ${reason})`)).resolves.toBeDefined();
    await expect(database.execute(sql`insert into job_discovery_schedule_occurrences (id, user_id, schedule_id, target_id, scheduled_for, status, run_id, skip_reason) values (${randomUUID()}, ${userId}, ${scheduleId}, ${targetId}, now() + interval '1 second', 'skipped', null, 'UNKNOWN')`)).rejects.toThrow();
  });

  it("0050 将已有 0049 策略行升级为默认未停止", async () => {
    const legacyContainer = await new PostgreSqlContainer("postgres:17-alpine").start(); const legacy = createDatabase(legacyContainer.getConnectionUri());
    const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-0049-account-control-"));
    try {
      const source = fileURLToPath(new URL("../migrations", import.meta.url)); await cp(source, migrationsFolder, { recursive: true });
      await unlink(join(migrationsFolder, "0050_account_run_control.sql")); await unlink(join(migrationsFolder, "meta", "0050_snapshot.json"));
      const journalPath = join(migrationsFolder, "meta", "_journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
      journal.entries = journal.entries.filter(({ tag }) => tag !== "0050_account_run_control"); await writeFile(journalPath, JSON.stringify(journal, null, 2));
      await migrate(legacy, { migrationsFolder }); const userId = randomUUID();
      await legacy.execute(sql`insert into job_accounts (id) values (${userId})`); await legacy.execute(sql`insert into account_run_policy_revisions (id, user_id, revision_number, settings) values (${randomUUID()}, ${userId}, 0, '{}'::jsonb)`); await legacy.execute(sql`insert into account_run_policies (user_id, current_revision_number, version) values (${userId}, 0, 0)`);
      await migrate(legacy, { migrationsFolder: source });
      await expect(legacy.execute(sql`select stopped_at, control_version, schedule_resume_after from account_run_policies where user_id = ${userId}`)).resolves.toEqual([{ stopped_at: null, control_version: 0, schedule_resume_after: null }]);
    } finally { await legacy.$client.end(); await legacyContainer.stop(); await rm(migrationsFolder, { recursive: true, force: true }); }
  }, 60_000);
});
