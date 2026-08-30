import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";

const fingerprint = "a".repeat(64);
const queryFingerprint = "b".repeat(64);

async function insertRun(database: Database, input: { userId: string; targetId: string; runId: string; idempotencyKey: string }) {
  await database.execute(sql`
    insert into agent_runs (
      id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot,
      workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step
    ) values (
      ${input.runId}, ${input.userId}, ${input.targetId}, ${input.idempotencyKey}, 1,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'workflow-v4', 'rules-v1', 'layered-public', 'v1', 'result-v4', '[]'::jsonb, 'queued', 'queued'
    )
  `);
}

describe("job discovery lead migrations", () => {
  let container: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = createDatabase(container.getConnectionUri());
    await migrateDatabase(database);
  }, 60_000);

  afterAll(async () => {
    await database?.$client.end();
    await container?.stop();
  });

  it("migrates owner-bound leads and attributions with database-enforced outcomes", async () => {
    const tables = await database.execute(sql`
      select table_name from information_schema.tables where table_schema = 'public'
        and table_name in ('job_discovery_leads', 'job_discovery_attributions') order by table_name
    `) as unknown as Array<{ table_name: string }>;
    expect(tables.map(({ table_name }) => table_name)).toEqual(["job_discovery_attributions", "job_discovery_leads"]);

    const constraints = await database.execute(sql`
      select conname from pg_constraint where conname in (
        'job_discovery_leads_owner_run_target_fk', 'job_discovery_leads_owner_version_fk',
        'job_discovery_leads_outcome_check', 'job_discovery_leads_provider_check',
        'job_discovery_leads_query_kind_check', 'job_discovery_leads_ttl_check',
        'job_discovery_leads_attr_ref_unique', 'job_discovery_attributions_lead_ref_fk',
        'job_discovery_attributions_owner_version_fk', 'job_discovery_attributions_lead_unique'
      ) order by conname
    `) as unknown as Array<{ conname: string }>;
    expect(constraints).toHaveLength(10);

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

    await database.execute(sql`insert into job_accounts (id) values (${ownerId}), (${otherOwnerId})`);
    await database.execute(sql`insert into job_targets (id, user_id, version, priority, state) values (${targetId}, ${ownerId}, 1, 'primary', 'active'), (${otherTargetId}, ${otherOwnerId}, 1, 'primary', 'active')`);
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

    const lead = sql`
      insert into job_discovery_leads (
        id, user_id, run_id, target_id, provider, query_id, query_kind, query_fingerprint,
        normalized_url, stable_fingerprint, expires_at, state, source_posting_version_id, rejection_code, created_at, updated_at
      ) values (
        ${leadId}, ${ownerId}, ${runId}, ${targetId}, 'anysearch', ${queryId}, 'general', ${queryFingerprint},
        'https://jobs.example.com/opening?id=123', ${fingerprint}, now() + interval '30 days', 'pending', null, null, now(), now()
      )
    `;
    await expect(database.execute(lead)).resolves.toBeDefined();
    await expect(database.execute(sql`
      insert into job_discovery_leads (id, user_id, run_id, target_id, provider, query_id, query_kind, query_fingerprint, normalized_url, stable_fingerprint, expires_at, state, source_posting_version_id, rejection_code, created_at, updated_at)
      values ('ffffffff-ffff-4fff-8fff-ffffffffffff', ${ownerId}, ${runId}, ${targetId}, 'other', ${queryId}, 'general', ${queryFingerprint}, 'https://jobs.example.com/opening?id=124', ${"c".repeat(64)}, now() + interval '30 days', 'pending', null, null, now(), now())
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.execute(sql`
      insert into job_discovery_leads (id, user_id, run_id, target_id, provider, query_id, query_kind, query_fingerprint, normalized_url, stable_fingerprint, expires_at, state, source_posting_version_id, rejection_code, created_at, updated_at)
      values ('12121212-1212-4121-8121-121212121212', ${ownerId}, ${runId}, ${targetId}, 'anysearch', ${queryId}, 'unknown', ${queryFingerprint}, 'https://jobs.example.com/opening?id=125', ${"d".repeat(64)}, now() + interval '30 days', 'pending', null, null, now(), now())
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.execute(sql`
      insert into job_discovery_leads (id, user_id, run_id, target_id, provider, query_id, query_kind, query_fingerprint, normalized_url, stable_fingerprint, expires_at, state, source_posting_version_id, rejection_code, created_at, updated_at)
      values ('13131313-1313-4131-8131-131313131313', ${ownerId}, ${runId}, ${targetId}, 'anysearch', ${queryId}, 'general', 'not-a-fingerprint', 'https://jobs.example.com/opening?id=126', ${"e".repeat(64)}, now() + interval '30 days', 'pending', null, null, now(), now())
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.execute(sql`
      insert into job_discovery_leads (id, user_id, run_id, target_id, provider, query_id, query_kind, query_fingerprint, normalized_url, stable_fingerprint, expires_at, state, source_posting_version_id, rejection_code, created_at, updated_at)
      values ('14141414-1414-4141-8141-141414141414', ${ownerId}, ${runId}, ${targetId}, 'anysearch', ${queryId}, 'general', ${queryFingerprint}, 'https://jobs.example.com/opening?id=127', ${"f".repeat(64)}, now() + interval '29 days', 'pending', null, null, now(), now())
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.execute(sql`
      update job_discovery_leads set source_posting_version_id = ${versionId} where id = ${leadId}
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.execute(sql`
      update job_discovery_leads set state = 'rejected', rejection_code = 'policy_rejected' where id = ${leadId}
    `)).rejects.toMatchObject({ cause: { code: "23514" } });

    await database.execute(sql`
      update job_discovery_leads set state = 'verified', source_posting_version_id = ${versionId}, updated_at = now() where id = ${leadId}
    `);
    await database.execute(sql`
      insert into job_discovery_leads (
        id, user_id, run_id, target_id, provider, query_id, query_kind, query_fingerprint,
        normalized_url, stable_fingerprint, expires_at, state, source_posting_version_id, rejection_code, created_at, updated_at
      ) values (
        '19191919-1919-4191-8191-191919191919', ${ownerId}, ${runId}, ${targetId}, 'anysearch', ${queryId}, 'general', ${queryFingerprint},
        'https://jobs.example.com/opening?id=128', ${"1".repeat(64)}, now() + interval '30 days', 'verified', ${versionId}, null, now(), now()
      )
    `);
    await database.execute(sql`
      insert into job_discovery_attributions (id, user_id, run_id, lead_id, query_id, provider, source_posting_version_id)
      values ('15151515-1515-4151-8151-151515151515', ${ownerId}, ${runId}, ${leadId}, ${queryId}, 'anysearch', ${versionId})
    `);
    await expect(database.execute(sql`
      insert into job_discovery_attributions (id, user_id, run_id, lead_id, query_id, provider, source_posting_version_id)
      values ('16161616-1616-4161-8161-161616161616', ${ownerId}, ${otherRunId}, '19191919-1919-4191-8191-191919191919', ${queryId}, 'anysearch', ${versionId})
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(database.execute(sql`
      insert into job_discovery_attributions (id, user_id, run_id, lead_id, query_id, provider, source_posting_version_id)
      values ('17171717-1717-4171-8171-171717171717', ${ownerId}, ${runId}, '19191919-1919-4191-8191-191919191919', ${queryId}, 'anysearch', ${otherVersionId})
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("upgrades a real 0023 database without losing its rows", async () => {
    const legacyContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
    const legacyDatabase = createDatabase(legacyContainer.getConnectionUri());
    const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-0023-"));
    try {
      const migrationSource = fileURLToPath(new URL("../migrations", import.meta.url));
      await cp(migrationSource, migrationsFolder, { recursive: true });
      await unlink(join(migrationsFolder, "0024_fat_jane_foster.sql"));
      const journalPath = join(migrationsFolder, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
      journal.entries = journal.entries.filter((entry) => entry.tag !== "0024_fat_jane_foster");
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migrate(legacyDatabase, { migrationsFolder });
      const accountId = "18181818-1818-4181-8181-181818181818";
      await legacyDatabase.execute(sql`insert into job_accounts (id) values (${accountId})`);
      await migrateDatabase(legacyDatabase);
      await expect(legacyDatabase.execute(sql`select id from job_accounts where id = ${accountId}`)).resolves.toEqual([{ id: accountId }]);
      await expect(legacyDatabase.execute(sql`select to_regclass('public.job_discovery_leads') as table_name`)).resolves.toEqual([{ table_name: "job_discovery_leads" }]);
    } finally {
      await legacyDatabase.$client.end();
      await legacyContainer.stop();
      await rm(migrationsFolder, { recursive: true, force: true });
    }
  });
});
