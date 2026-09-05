import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";
import { assertTrue } from "./test-safe-assertions";

const fingerprint = "a".repeat(64);
const queryFingerprint = "b".repeat(64);

async function insertRun(database: Database, input: { userId: string; targetId: string; runId: string; idempotencyKey: string }) {
  await database.execute(sql`
    insert into agent_runs (
      id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot,
      workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step
    ) values (
      ${input.runId}, ${input.userId}, ${input.targetId}, ${input.idempotencyKey}, 1,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'job-discovery-workflow-v3', 'rules-v1', 'greenhouse', 'v1', 'result-v3', '[]'::jsonb, 'queued', 'queued'
    )
  `);
}

describe("public discovery workflow migration", () => {
  it("为 v4 冻结快照和独立发现诊断提供 additive 0025 迁移", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL("../migrations/0025_layered_public_discovery_workflow.sql", import.meta.url)), "utf8");

    expect(migrationSql).toContain('ADD COLUMN "profile_snapshot"');
    expect(migrationSql).toContain('ADD COLUMN "watchlist_snapshot"');
    expect(migrationSql).toContain('CREATE TABLE "job_discovery_diagnostics"');
    expect(migrationSql).toContain('UNIQUE NULLS NOT DISTINCT("user_id","run_id","scope","provider","query_id","lead_id","code")');
    expect(migrationSql).not.toContain("job_source_health_checks");
  });

  it("以独立 additive 0026 将发现关注项与 Watchlist 来源关注项隔离", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL("../migrations/0026_discovery_attention.sql", import.meta.url)), "utf8");

    expect(migrationSql).toContain('discovery_attention');
    expect(migrationSql).toContain('DISCOVERY_ATTENTION');
    expect(migrationSql).toContain("SOURCE_HEALTH_ATTENTION");
  });

  it("以 additive 0027 固化 v4 result/source issue 的 owner 约束和双唯一结果身份", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL("../migrations/0027_massive_purple_man.sql", import.meta.url)), "utf8");
    expect(migrationSql).toContain('CREATE TABLE "job_discovery_run_results"');
    expect(migrationSql).toContain('CREATE TABLE "job_discovery_source_issues"');
    expect(migrationSql).toContain('UNIQUE("user_id","run_id","ordinal")');
    expect(migrationSql).toContain('UNIQUE("user_id","run_id","source_posting_version_id")');
    expect(migrationSql).toContain('job_discovery_run_results_owner_run_fk');
    expect(migrationSql).toContain('job_discovery_source_issues_owner_run_fk');
    expect(migrationSql).toContain('ordinal" between 1 and 5');
  });

  it("从真实 0024 升级后保留旧事实，并以 PostgreSQL 约束 v4 diagnostics、attention、source issue 与 result", async () => {
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const database = createDatabase(container.getConnectionUri());
    const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-0024-v4-"));

    const ownerId = "11111111-1111-4111-8111-111111111111";
    const otherOwnerId = "22222222-2222-4222-8222-222222222222";
    const targetId = "33333333-3333-4333-8333-333333333333";
    const otherTargetId = "44444444-4444-4444-8444-444444444444";
    const runId = "55555555-5555-4555-8555-555555555555";
    const otherRunId = "66666666-6666-4666-8666-666666666666";
    const versionId = "77777777-7777-4777-8777-777777777777";
    const otherVersionId = "88888888-8888-4888-8888-888888888888";
    const queryId = "99999999-9999-4999-8999-999999999999";
    const leadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    try {
      const migrationSource = fileURLToPath(new URL("../migrations", import.meta.url));
      await cp(migrationSource, migrationsFolder, { recursive: true });
      await Promise.all([
        unlink(join(migrationsFolder, "0025_layered_public_discovery_workflow.sql")),
        unlink(join(migrationsFolder, "0026_discovery_attention.sql")),
        unlink(join(migrationsFolder, "0027_massive_purple_man.sql")),
        unlink(join(migrationsFolder, "0028_job_triage_versions.sql")),
        unlink(join(migrationsFolder, "0029_heavy_devos.sql")),
        unlink(join(migrationsFolder, "0030_deep_match_recommendations.sql")),
        unlink(join(migrationsFolder, "0031_deep_match_agent_runs.sql")),
        unlink(join(migrationsFolder, "0032_recommendation_highlight_limit.sql")),
        unlink(join(migrationsFolder, "0033_deep_match_usage_entries.sql")),
        unlink(join(migrationsFolder, "0034_recommendation_highlight_limit_lock.sql")),
        unlink(join(migrationsFolder, "0035_agent_run_step_model_failures.sql")),
        unlink(join(migrationsFolder, "0036_recommendation_exclusion_list_ownership.sql")),
        unlink(join(migrationsFolder, "0037_deep_match_run_staging.sql")),
        unlink(join(migrationsFolder, "0038_recommendation_feedback_calibration.sql")),
        unlink(join(migrationsFolder, "0039_boring_sleepwalker.sql")),
        unlink(join(migrationsFolder, "0040_loud_northstar.sql")),
        unlink(join(migrationsFolder, "0041_thankful_lethal_legion.sql")),
        unlink(join(migrationsFolder, "0042_mighty_malcolm_colcord.sql")),
        unlink(join(migrationsFolder, "0043_task_control_agent_inbox.sql")),
        unlink(join(migrationsFolder, "0044_account_run_policies.sql")),
        unlink(join(migrationsFolder, "0045_account_run_policy_schedule_window.sql")),
        unlink(join(migrationsFolder, "0046_model_diagnostic_results.sql")),
        unlink(join(migrationsFolder, "0047_agent_run_preflight_snapshot.sql")),
        unlink(join(migrationsFolder, "meta", "0025_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0026_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0027_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0028_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0029_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0038_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0039_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0040_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0041_snapshot.json")),
        unlink(join(migrationsFolder, "meta", "0042_snapshot.json")),
      ]);
      const journalPath = join(migrationsFolder, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
      journal.entries = journal.entries.filter(({ tag }) => !["0025_layered_public_discovery_workflow", "0026_discovery_attention", "0027_massive_purple_man", "0028_job_triage_versions", "0029_heavy_devos", "0030_deep_match_recommendations", "0031_deep_match_agent_runs", "0032_recommendation_highlight_limit", "0033_deep_match_usage_entries", "0034_recommendation_highlight_limit_lock", "0035_agent_run_step_model_failures", "0036_recommendation_exclusion_list_ownership", "0037_deep_match_run_staging", "0038_recommendation_feedback_calibration", "0039_boring_sleepwalker", "0040_loud_northstar", "0041_thankful_lethal_legion", "0042_mighty_malcolm_colcord", "0043_task_control_agent_inbox", "0044_account_run_policies", "0045_account_run_policy_schedule_window", "0046_model_diagnostic_results", "0047_agent_run_preflight_snapshot"].includes(tag));
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migrate(database, { migrationsFolder });

      await database.execute(sql`insert into job_accounts (id) values (${ownerId}), (${otherOwnerId})`);
      await database.execute(sql`
        insert into job_targets (id, user_id, version, priority, state)
        values (${targetId}, ${ownerId}, 1, 'primary', 'active'), (${otherTargetId}, ${otherOwnerId}, 1, 'primary', 'active')
      `);
      await insertRun(database, { userId: ownerId, targetId, runId, idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
      await insertRun(database, { userId: otherOwnerId, targetId: otherTargetId, runId: otherRunId, idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
      await database.execute(sql`
        insert into job_source_postings (id, user_id, source_type, source_identifier, source_identity)
        values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', ${ownerId}, 'official', 'source', '{}'::jsonb),
               ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ${otherOwnerId}, 'official', 'other-source', '{}'::jsonb)
      `);
      await database.execute(sql`
        insert into job_source_posting_versions (id, user_id, source_posting_id, version, content_sha256, raw_content_sha256, raw_object_reference, retrieved_at)
        values (${versionId}, ${ownerId}, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1, ${fingerprint}, ${fingerprint}, '{}'::jsonb, now()),
               (${otherVersionId}, ${otherOwnerId}, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 1, ${fingerprint}, ${fingerprint}, '{}'::jsonb, now())
      `);
      await database.execute(sql`
        insert into job_discovery_leads (
          id, user_id, run_id, target_id, provider, query_id, query_kind, query_fingerprint,
          normalized_url, stable_fingerprint, expires_at, state, source_posting_version_id, rejection_code, created_at, updated_at
        ) values (
          ${leadId}, ${ownerId}, ${runId}, ${targetId}, 'anysearch', ${queryId}, 'general', ${queryFingerprint},
          'https://jobs.example.com/opening?id=123', ${fingerprint}, now() + interval '30 days', 'pending', null, null, now(), now()
        )
      `);
      await database.execute(sql`
        insert into agent_inbox_items (id, user_id, run_id, trigger_event_sequence, kind, status, reason_code, budget_dimension)
        values ('12121212-1212-4121-8121-121212121212', ${ownerId}, ${runId}, 1, 'source_attention', 'open', 'SOURCE_HEALTH_ATTENTION', null)
      `);

      await migrateDatabase(database);

      await expect(database.execute(sql`select id, normalized_url from job_discovery_leads where id = ${leadId}`)).resolves.toEqual([
        { id: leadId, normalized_url: "https://jobs.example.com/opening?id=123" },
      ]);
      await expect(database.execute(sql`select kind, reason_code from agent_inbox_items where id = '12121212-1212-4121-8121-121212121212'`)).resolves.toEqual([
        { kind: "discovery_attention", reason_code: "DISCOVERY_ATTENTION" },
      ]);

      await database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, code, retryable, affected_count)
        values ('13131313-1313-4131-8131-131313131313', ${ownerId}, ${runId}, 'provider', 'anysearch', 'ANYSEARCH_UNAVAILABLE', true, 1)
      `);
      await database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, query_id, query_kind, query_fingerprint, code, retryable, affected_count)
        values ('14141414-1414-4141-8141-141414141414', ${ownerId}, ${runId}, 'query', 'anysearch', ${queryId}, 'general', ${queryFingerprint}, 'QUERY_UNAVAILABLE', true, 1)
      `);
      await database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, lead_id, code, retryable, affected_count)
        values ('15151515-1515-4151-8151-151515151515', ${ownerId}, ${runId}, 'lead', 'anysearch', ${leadId}, 'PAGE_TIMEOUT', true, 1)
      `);
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, code, retryable, affected_count)
        values ('16161616-1616-4161-8161-161616161616', ${ownerId}, ${runId}, 'provider', 'anysearch', 'ANYSEARCH_UNAVAILABLE', true, 1)
      `)).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, query_id, code, retryable, affected_count)
        values ('17171717-1717-4171-8171-171717171717', ${ownerId}, ${runId}, 'provider', 'anysearch', ${queryId}, 'BAD_PAIR', true, 1)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, query_kind, query_fingerprint, code, retryable, affected_count)
        values ('18181818-1818-4181-8181-181818181818', ${ownerId}, ${runId}, 'query', 'anysearch', 'general', ${queryFingerprint}, 'BAD_PAIR', true, 1)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, code, retryable, affected_count)
        values ('19191919-1919-4191-8191-191919191919', ${ownerId}, ${runId}, 'lead', 'anysearch', 'BAD_PAIR', true, 1)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, code, retryable, affected_count)
        values ('20202020-2020-4202-8202-202020202020', ${ownerId}, ${runId}, 'provider', 'other', 'BAD_CODE', true, 1)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, code, retryable, affected_count)
        values ('21212121-2121-4212-8222-212121212121', ${ownerId}, ${runId}, 'provider', 'anysearch', 'bad_code', true, 1)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, code, retryable, affected_count)
        values ('22222222-2222-4222-8222-222222222223', ${ownerId}, ${runId}, 'provider', 'anysearch', 'TOO_MANY', true, 11)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, code, retryable, affected_count)
        values ('23232323-2323-4232-8232-232323232323', ${ownerId}, ${otherRunId}, 'provider', 'anysearch', 'CROSS_OWNER_RUN', true, 1)
      `)).rejects.toMatchObject({ cause: { code: "23503" } });
      await expect(database.execute(sql`
        insert into job_discovery_diagnostics (id, user_id, run_id, scope, provider, lead_id, code, retryable, affected_count)
        values ('24242424-2424-4242-8242-242424242424', ${ownerId}, ${runId}, 'lead', 'anysearch', '25252525-2525-4252-8252-252525252525', 'CROSS_OWNER_LEAD', true, 1)
      `)).rejects.toMatchObject({ cause: { code: "23503" } });

      await database.execute(sql`
        insert into agent_inbox_items (id, user_id, run_id, trigger_event_sequence, kind, status, reason_code, budget_dimension)
        values ('26262626-2626-4262-8262-262626262626', ${ownerId}, ${runId}, 2, 'discovery_attention', 'unread', 'DISCOVERY_ATTENTION', null)
      `);
      await expect(database.execute(sql`
        insert into agent_inbox_items (id, user_id, run_id, trigger_event_sequence, kind, status, reason_code, budget_dimension)
        values ('27272727-2727-4272-8272-272727272727', ${ownerId}, ${runId}, 3, 'discovery_attention', 'unread', 'SOURCE_HEALTH_ATTENTION', null)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into agent_inbox_items (id, user_id, run_id, trigger_event_sequence, kind, status, reason_code, budget_dimension)
        values ('28282828-2828-4282-8282-282828282828', ${ownerId}, ${runId}, 4, 'source_attention', 'unread', 'DISCOVERY_ATTENTION', null)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });

      await database.execute(sql`
        insert into job_discovery_source_issues (id, user_id, run_id, provider, code, affected_count)
        values ('29292929-2929-4292-8292-292929292929', ${ownerId}, ${runId}, 'anysearch', 'ANYSEARCH_UNAVAILABLE', 1)
      `);
      await expect(database.execute(sql`
        insert into job_discovery_source_issues (id, user_id, run_id, provider, code, affected_count)
        values ('30303030-3030-4303-8303-303030303030', ${ownerId}, ${runId}, 'anysearch', 'ANYSEARCH_UNAVAILABLE', 1)
      `)).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(database.execute(sql`
        insert into job_discovery_source_issues (id, user_id, run_id, provider, code, affected_count)
        values ('31313131-3131-4313-8313-313131313131', ${ownerId}, ${otherRunId}, 'anysearch', 'CROSS_OWNER_RUN', 1)
      `)).rejects.toMatchObject({ cause: { code: "23503" } });
      await expect(database.execute(sql`
        insert into job_discovery_source_issues (id, user_id, run_id, provider, code, affected_count)
        values ('32323232-3232-4323-8323-323232323232', ${ownerId}, ${runId}, 'other', 'BAD_PROVIDER', 1)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into job_discovery_source_issues (id, user_id, run_id, provider, code, affected_count)
        values ('34343434-3434-4343-8343-343434343434', ${ownerId}, ${runId}, 'anysearch', 'bad_code', 1)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(database.execute(sql`
        insert into job_discovery_source_issues (id, user_id, run_id, provider, code, affected_count)
        values ('35353535-3535-4353-8353-353535353535', ${ownerId}, ${runId}, 'anysearch', 'TOO_MANY', 11)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });

      await database.execute(sql`
        insert into job_discovery_run_results (id, user_id, run_id, source_posting_version_id, ordinal)
        values ('36363636-3636-4363-8363-363636363636', ${ownerId}, ${runId}, ${versionId}, 1)
      `);
      await expect(database.execute(sql`
        insert into job_discovery_run_results (id, user_id, run_id, source_posting_version_id, ordinal)
        values ('37373737-3737-4373-8373-373737373737', ${ownerId}, ${otherRunId}, ${versionId}, 2)
      `)).rejects.toMatchObject({ cause: { code: "23503" } });
      await expect(database.execute(sql`
        insert into job_discovery_run_results (id, user_id, run_id, source_posting_version_id, ordinal)
        values ('38383838-3838-4383-8383-383838383838', ${ownerId}, ${runId}, ${otherVersionId}, 2)
      `)).rejects.toMatchObject({ cause: { code: "23503" } });
      let zeroOrdinalRejected = false;
      try {
        await database.execute(sql`
          insert into job_discovery_run_results (id, user_id, run_id, source_posting_version_id, ordinal)
          values ('39393939-3939-4393-8393-393939393939', ${ownerId}, ${runId}, ${versionId}, 0)
        `);
      } catch { zeroOrdinalRejected = true; }
      assertTrue(zeroOrdinalRejected);
      await expect(database.execute(sql`
        insert into job_discovery_run_results (id, user_id, run_id, source_posting_version_id, ordinal)
        values ('40404040-4040-4404-8404-404040404040', ${ownerId}, ${runId}, ${versionId}, 6)
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
      let duplicateVersionRejected = false;
      try {
        await database.execute(sql`
          insert into job_discovery_run_results (id, user_id, run_id, source_posting_version_id, ordinal)
          values ('41414141-4141-4414-8414-414141414141', ${ownerId}, ${runId}, ${versionId}, 1)
        `);
      } catch { duplicateVersionRejected = true; }
      assertTrue(duplicateVersionRejected);
      let repeatedVersionRejected = false;
      try {
        await database.execute(sql`
          insert into job_discovery_run_results (id, user_id, run_id, source_posting_version_id, ordinal)
          values ('42424242-4242-4424-8424-424242424242', ${ownerId}, ${runId}, ${versionId}, 2)
        `);
      } catch { repeatedVersionRejected = true; }
      assertTrue(repeatedVersionRejected);

      const snapshots = await Promise.all(["0024", "0025", "0026", "0027", "0028", "0029"].map(async (number) => JSON.parse(await readFile(fileURLToPath(new URL(`../migrations/meta/${number}_snapshot.json`, import.meta.url)), "utf8")) as { id: string; prevId: string }));
      const currentJournal = JSON.parse(await readFile(fileURLToPath(new URL("../migrations/meta/_journal.json", import.meta.url)), "utf8")) as { entries: Array<{ tag: string }> };
      expect(snapshots.slice(1).map((snapshot) => snapshot.prevId)).toEqual(snapshots.slice(0, -1).map((snapshot) => snapshot.id));
      const v4Start = currentJournal.entries.findIndex(({ tag }) => tag === "0024_fat_jane_foster");
      expect(currentJournal.entries.slice(v4Start, v4Start + 6).map(({ tag }) => tag)).toEqual([
        "0024_fat_jane_foster", "0025_layered_public_discovery_workflow", "0026_discovery_attention", "0027_massive_purple_man", "0028_job_triage_versions", "0029_heavy_devos",
      ]);
    } finally {
      await database.$client.end();
      await container.stop();
      await rm(migrationsFolder, { recursive: true, force: true });
    }
  }, 60_000);
});
