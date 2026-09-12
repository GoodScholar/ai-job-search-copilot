import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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
    await expect(database.execute(sql`insert into account_run_policies (user_id, current_revision_number, version, control_version) values (${userId}, 0, 0, -1)`)).rejects.toThrow();
    await expect(database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${userId}, ${commandId}, 'unknown', 0, false, ${snapshot()}::jsonb)`)).rejects.toThrow();
    const malformed = JSON.stringify({ applied: false, state: { stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null }, extra: true });
    await expect(database.execute(sql`insert into account_run_control_commands (user_id, command_id, action, expected_version, applied, result_snapshot) values (${userId}, ${commandId}, 'stop', 0, false, ${malformed}::jsonb)`)).rejects.toThrow();
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
});
