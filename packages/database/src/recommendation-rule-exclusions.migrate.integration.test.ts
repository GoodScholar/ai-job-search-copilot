import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client";
import { migrateDatabase } from "./migrate";

const reasonCodes = ["TRIAGE_NOT_PASS", "DEADLINE_EXPIRED", "SCORE_BELOW_THRESHOLD", "CANDIDATE_LIMIT", "MATCH_QUALITY_INSUFFICIENT", "RULE_EXCLUDED"] as const;
const ownerId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const postingId = "33333333-3333-4333-8333-333333333333";
const postingVersionId = "44444444-4444-4444-8444-444444444444";
const opportunityId = "55555555-5555-4555-8555-555555555555";
const listId = "66666666-6666-4666-8666-666666666666";

async function seedExclusionOwner(database: Database) {
  await database.execute(sql`insert into job_accounts (id) values (${ownerId})`);
  await database.execute(sql`insert into job_targets (id, user_id, version, priority, state) values (${targetId}, ${ownerId}, 1, 'primary', 'active')`);
  await database.execute(sql`insert into job_source_postings (id, user_id, source_type, source_identifier, source_identity) values (${postingId}, ${ownerId}, 'fake', 'rule-exclusion-source', '{}'::jsonb)`);
  await database.execute(sql`insert into job_source_posting_versions (id, user_id, source_posting_id, version, content_sha256, raw_content_sha256, raw_object_reference, retrieved_at) values (${postingVersionId}, ${ownerId}, ${postingId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, '{}'::jsonb, now())`);
  await database.execute(sql`insert into job_opportunities (id, user_id, source_posting_version_id, dedup_key, normalized_data) values (${opportunityId}, ${ownerId}, ${postingVersionId}, ${"c".repeat(64)}, '{}'::jsonb)`);
  await database.execute(sql`insert into recommendation_lists (id, user_id, target_id, local_date, sequence) values (${listId}, ${ownerId}, ${targetId}, '2026-09-13', 1)`);
}

async function insertExclusion(database: Database, reasonCode: string) {
  await database.execute(sql`
    insert into recommendation_exclusions (id, user_id, target_id, opportunity_id, recommendation_list_id, reason_code)
    values (${crypto.randomUUID()}, ${ownerId}, ${targetId}, ${opportunityId}, ${listId}, ${reasonCode})
  `);
}

async function migrateAt0050(database: Database) {
  const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-0050-rule-exclusions-"));
  const migrationSource = fileURLToPath(new URL("../migrations", import.meta.url));
  await cp(migrationSource, migrationsFolder, { recursive: true });
  await rm(join(migrationsFolder, "0051_recommendation_rule_exclusions.sql"), { force: true });
  await rm(join(migrationsFolder, "meta", "0051_snapshot.json"), { force: true });
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter(({ tag }) => tag !== "0051_recommendation_rule_exclusions");
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await migrate(database, { migrationsFolder });
  return migrationsFolder;
}

describe("recommendation rule exclusions migration", () => {
  it("从真实 0050 升级后保留历史排除，并仅放宽至规则排除原因", async () => {
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const database = createDatabase(container.getConnectionUri());
    let migrationsFolder: string | undefined;
    try {
      migrationsFolder = await migrateAt0050(database);
      await seedExclusionOwner(database);
      await insertExclusion(database, "TRIAGE_NOT_PASS");
      await expect(insertExclusion(database, "RULE_EXCLUDED")).rejects.toMatchObject({ cause: { code: "23514" } });

      await migrateDatabase(database);

      await expect(database.execute(sql`select reason_code from recommendation_exclusions where reason_code = 'TRIAGE_NOT_PASS'`)).resolves.toEqual([{ reason_code: "TRIAGE_NOT_PASS" }]);
      for (const reasonCode of reasonCodes) await expect(insertExclusion(database, reasonCode)).resolves.toBeUndefined();
      await expect(insertExclusion(database, "UNKNOWN_EXCLUSION")).rejects.toMatchObject({ cause: { code: "23514" } });
    } finally {
      await database.$client.end();
      await container.stop();
      if (migrationsFolder) await rm(migrationsFolder, { recursive: true, force: true });
    }
  }, 60_000);

  it("在 fresh chain 中写入规则排除并拒绝未知原因", async () => {
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const database = createDatabase(container.getConnectionUri());
    try {
      await migrateDatabase(database);
      await seedExclusionOwner(database);
      await expect(insertExclusion(database, "RULE_EXCLUDED")).resolves.toBeUndefined();
      await expect(insertExclusion(database, "UNKNOWN_EXCLUSION")).rejects.toMatchObject({ cause: { code: "23514" } });
    } finally {
      await database.$client.end();
      await container.stop();
    }
  }, 60_000);
});
