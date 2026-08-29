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

async function listPublicTables(database: Database): Promise<string[]> {
  const result = await database.execute(sql`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name
  `);

  return (result as unknown as Array<{ table_name: string }>).map((row) => row.table_name);
}

type Column = {
  table_name: string;
  column_name: string;
  data_type: string;
};

async function listColumns(database: Database): Promise<Column[]> {
  const result = await database.execute(sql`
    select table_name, column_name, data_type
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position
  `);

  return result as unknown as Column[];
}

async function listConstraintNames(database: Database): Promise<string[]> {
  const result = await database.execute(sql`
    select conname
    from pg_constraint
    order by conname
  `);

  return (result as unknown as Array<{ conname: string }>).map((row) => row.conname);
}

describe("database migrations", () => {
  let container: StartedPostgreSqlContainer;
  let migratedDatabase: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    migratedDatabase = createDatabase(container.getConnectionUri());
    await migrateDatabase(migratedDatabase);
  }, 60_000);

  afterAll(async () => {
    if (migratedDatabase) {
      await migratedDatabase.$client.end();
    }
    if (container) {
      await container.stop();
    }
  });

  it("migrates the identity and audit tables on PostgreSQL", async () => {
    const tables = await listPublicTables(migratedDatabase);
    expect(tables).toEqual(expect.arrayContaining([
      "job_accounts", "external_identities", "sessions", "audit_events",
    ]));
  });

  it("PostgreSQL 17 的 transaction_timeout 覆盖同一事务内累计语句并回滚写入", async () => {
    const accountId = "c9462b80-3fa0-4400-87ea-bd909e703b18";
    // transaction_timeout 会终止会话；使用容器内独立 psql 验证，避免刻意杀死应用共享连接池。
    const command = `begin; set local transaction_timeout = 100; insert into job_accounts (id) values ('${accountId}'); select pg_sleep(0.08); select pg_sleep(0.08); commit;`;
    const result = await container.exec(["psql", "-U", container.getUsername(), "-d", container.getDatabase(), "-v", "ON_ERROR_STOP=1", "-c", command]);
    expect(result.exitCode).not.toBe(0);
    await expect(migratedDatabase.execute(sql`select id from job_accounts where id = ${accountId}`)).resolves.toEqual([]);
  });

  it("records active account and audit trail fields with PostgreSQL types", async () => {
    const columns = await listColumns(migratedDatabase);
    expect(columns).toEqual(expect.arrayContaining([
      { table_name: "job_accounts", column_name: "status", data_type: "character varying" },
      { table_name: "job_accounts", column_name: "updated_at", data_type: "timestamp with time zone" },
      { table_name: "audit_events", column_name: "occurred_at", data_type: "timestamp with time zone" },
      { table_name: "audit_events", column_name: "request_id", data_type: "uuid" },
      { table_name: "audit_events", column_name: "outcome", data_type: "character varying" },
      { table_name: "audit_events", column_name: "reason_code", data_type: "character varying" },
      { table_name: "audit_events", column_name: "actor_user_id", data_type: "uuid" },
      { table_name: "audit_events", column_name: "resource_type", data_type: "character varying" },
      { table_name: "audit_events", column_name: "resource_id", data_type: "uuid" },
      { table_name: "audit_events", column_name: "metadata", data_type: "jsonb" },
    ]));
  });

  it("defaults new accounts to active and preserves identity and session uniqueness", async () => {
    const accountId = "3d4c8eb3-2b92-4d91-aad4-959b7d4cd7a3";
    const secondAccountId = "9ecafc2a-df98-4652-a1d7-19c0db3c76e6";
    const firstSessionId = "ad3f2a86-4e59-4e89-b6b2-13593799ccd2";
    const secondSessionId = "a8a7aa9f-b1c9-4799-9c6c-3ed7d661299d";
    const tokenHash = "a".repeat(64);

    const accountResult = await migratedDatabase.execute(sql`
      insert into job_accounts (id) values (${accountId}) returning status
    `);
    expect((accountResult as unknown as Array<{ status: string }>)[0]?.status).toBe("active");
    await migratedDatabase.execute(sql`insert into job_accounts (id) values (${secondAccountId})`);

    await migratedDatabase.execute(sql`
      insert into external_identities (provider, subject, user_id)
      values ('dev', 'subject-1', ${accountId})
    `);
    await expect(migratedDatabase.execute(sql`
      insert into external_identities (provider, subject, user_id)
      values ('dev', 'subject-1', ${secondAccountId})
    `)).rejects.toMatchObject({ cause: { code: "23505" } });

    const sessionColumns = (await listColumns(migratedDatabase))
      .filter((column) => column.table_name === "sessions")
      .map((column) => column.column_name);
    expect(sessionColumns).toContain("token_hash");
    expect(sessionColumns).not.toContain("token");

    await migratedDatabase.execute(sql`
      insert into sessions (id, user_id, token_hash, expires_at)
      values (${firstSessionId}, ${accountId}, ${tokenHash}, now() + interval '1 day')
    `);
    await expect(migratedDatabase.execute(sql`
      insert into sessions (id, user_id, token_hash, expires_at)
      values (${secondSessionId}, ${secondAccountId}, ${tokenHash}, now() + interval '1 day')
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("rejects an audit event whose actor is not an account", async () => {
    const accountId = "8cf9ef56-08fd-4465-b4ef-4c713d0d80a5";
    const unknownActorId = "f7ebc18f-a588-4cf4-8d48-b48f766d0c17";

    await migratedDatabase.execute(sql`insert into job_accounts (id) values (${accountId})`);
    await expect(migratedDatabase.execute(sql`
      insert into audit_events (
        id, user_id, actor_user_id, event_type, occurred_at, request_id, outcome, reason_code, metadata
      ) values (
        'cbb90d70-a7c1-4554-9df2-309a7c2aa451', ${accountId}, ${unknownActorId}, 'AUTH_LOGIN', now(),
        'adfbd5ec-4b3a-4b63-af71-f1635205704c', 'DENIED', 'AUTH_REQUIRED', '{}'::jsonb
      )
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("migrates account-owned career imports and evidence", async () => {
    expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
      "career_documents", "career_imports", "candidate_facts", "candidate_fact_evidence",
    ]));

    const constraints = await migratedDatabase.execute(sql`
      select conname from pg_constraint where conname in (
        'career_documents_user_checksum_source_format_unique', 'career_imports_document_versions_unique',
        'candidate_facts_import_fact_key_unique', 'candidate_fact_evidence_fact_unique'
      ) order by conname
    `);
    expect(constraints).toHaveLength(4);
  });

  it("migrates one versioned profile per account with immutable fact revisions", async () => {
    expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
      "job_profiles", "profile_facts", "profile_fact_revisions", "candidate_fact_decisions",
    ]));
    const constraints = await migratedDatabase.execute(sql`
      select conname from pg_constraint where conname in (
        'job_profiles_user_unique', 'profile_fact_revisions_fact_revision_unique',
        'candidate_fact_decisions_candidate_fact_unique'
      ) order by conname
    `);
    expect(constraints).toHaveLength(3);
    expect(await listColumns(migratedDatabase)).toEqual(expect.arrayContaining([
      { table_name: "profile_fact_revisions", column_name: "profile_version", data_type: "integer" },
    ]));
  });

  it("migrates owner-bound career fact conflicts with resolution consistency", async () => {
    expect(await listPublicTables(migratedDatabase)).toContain("career_fact_conflicts");
    const constraints = await migratedDatabase.execute(sql`
      select conname from pg_constraint where conname in (
        'career_fact_conflicts_pair_unique', 'career_fact_conflicts_distinct_pair_check',
        'career_fact_conflicts_resolution_state_check', 'career_fact_conflicts_resolution_check',
        'career_fact_conflicts_profile_version_positive'
      ) order by conname
    `);
    expect(constraints).toHaveLength(5);
  });

  it("upgrades a 0006 database through the DOCX and conflict migrations", async () => {
    const upgradeContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
    const upgradeDatabase = createDatabase(upgradeContainer.getConnectionUri());
    const migrationSource = fileURLToPath(new URL("../migrations", import.meta.url));
    const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-migrations-"));
    try {
      await cp(migrationSource, migrationsFolder, { recursive: true });
      await Promise.all([
        unlink(join(migrationsFolder, "0007_docx_career_documents.sql")),
        unlink(join(migrationsFolder, "0008_career_fact_conflicts.sql")),
        unlink(join(migrationsFolder, "0009_fat_human_fly.sql")),
      ]);
      const journalPath = join(migrationsFolder, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ when: number }> };
      journal.entries = journal.entries.slice(0, 7);
      journal.entries[0]!.when = 1788100000000;
      journal.entries[1]!.when = 1788100010000;
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migrate(upgradeDatabase, { migrationsFolder });

      await migrateDatabase(upgradeDatabase);
      const appliedMigrations = await upgradeDatabase.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`);
      expect(appliedMigrations).toEqual(expect.arrayContaining([
        expect.objectContaining({ created_at: "1787848000000" }),
        expect.objectContaining({ created_at: "1787848500000" }),
        expect.objectContaining({ created_at: "1787849004209" }),
      ]));
      expect(appliedMigrations).toEqual(expect.arrayContaining([
        expect.objectContaining({ created_at: "1787800000000" }),
        expect.objectContaining({ created_at: "1787800010000" }),
      ]));
      const unrelatedLegacyHash = "f".repeat(64);
      await upgradeDatabase.execute(sql`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${unrelatedLegacyHash}, 1788100000000)
      `);
      await migrateDatabase(upgradeDatabase);
      const [unrelatedLedgerRow] = await upgradeDatabase.execute(sql`
        select created_at from drizzle.__drizzle_migrations where hash = ${unrelatedLegacyHash}
      `) as unknown as Array<{ created_at: string }>;
      expect(unrelatedLedgerRow).toEqual({ created_at: "1788100000000" });
      expect(await listPublicTables(upgradeDatabase)).toEqual(expect.arrayContaining([
        "career_fact_conflicts",
      ]));
      expect(await listColumns(upgradeDatabase)).toEqual(expect.arrayContaining([
        { table_name: "career_documents", column_name: "source_format", data_type: "character varying" },
      ]));
      const accountId = "ca10c84f-607a-4a7f-ac4c-63e214dcf1e0";
      const documentId = "77ccf17d-1b03-4a42-a979-22cce5ad9c5e";
      await upgradeDatabase.execute(sql`insert into job_accounts (id) values (${accountId})`);
      await upgradeDatabase.execute(sql`
        insert into career_documents (id, user_id, checksum_sha256, object_key, original_filename, source_format, media_type, byte_size)
        values (${documentId}, ${accountId}, ${"a".repeat(64)}, 'accounts/test/processing.txt', 'resume.docx', 'docx', 'text/plain', 1)
      `);
      await expect(upgradeDatabase.execute(sql`
        insert into protected_career_documents (id, user_id, processing_document_id, checksum_sha256, object_key, original_filename, media_type, byte_size)
        values ('64b07f8d-d5c6-44a0-bbde-0f66a4cfbf6b', ${accountId}, ${documentId}, ${"b".repeat(64)}, 'accounts/test/original.docx', 'resume.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1)
      `)).resolves.toBeDefined();
    } finally {
      await upgradeDatabase.$client.end();
      await upgradeContainer.stop();
      await rm(migrationsFolder, { recursive: true, force: true });
    }
  }, 60_000);

  it("enforces career import ownership and domain bounds", async () => {
    const accountId = "a4336773-4ece-464c-a4a9-4e884e461c55";
    const secondAccountId = "0e532866-ef87-4e6e-a155-c87580550450";
    const documentId = "7d688e0a-5fd1-4620-8f32-7f3c24bf83c3";
    const crossAccountDocumentId = "5a40f44f-3645-4834-9026-543e1af66ea5";
    const secondDocumentId = "cfaf70b9-bc5e-4a73-bf87-5f97d91a0027";
    const careerImportId = "5bbfc3df-20d2-40d5-9b6b-b9d876a6b26d";
    const factId = "c45ab1b3-48e5-4fe4-b41f-71c516f20e07";
    const checksum = "a".repeat(64);
    const objectKey = `accounts/${accountId}/career-documents/${documentId}/source.md`;
    const secondObjectKey = `accounts/${secondAccountId}/career-documents/${secondDocumentId}/source.md`;

    await migratedDatabase.execute(sql`insert into job_accounts (id) values (${accountId}), (${secondAccountId})`);
    await migratedDatabase.execute(sql`
      insert into career_documents (
        id, user_id, checksum_sha256, object_key, original_filename, media_type, byte_size
      ) values (
        ${documentId}, ${accountId}, ${checksum}, ${objectKey},
        'resume.md', 'text/markdown', 1
      ), (
        ${secondDocumentId}, ${secondAccountId}, ${checksum}, ${secondObjectKey},
        'resume.md', 'text/markdown', 1
      )
    `);
    await expect(migratedDatabase.execute(sql`
      insert into career_documents (
        id, user_id, checksum_sha256, object_key, original_filename, media_type, byte_size
      ) values (
        '3cb3f03a-62a6-47d4-b632-85bd72a44fb2', ${accountId}, ${checksum},
        'accounts/a4336773-4ece-464c-a4a9-4e884e461c55/career-documents/3cb3f03a-62a6-47d4-b632-85bd72a44fb2/source.md',
        'duplicate.md', 'text/markdown', 1
      )
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(migratedDatabase.execute(sql`
      insert into career_documents (
        id, user_id, checksum_sha256, object_key, original_filename, media_type, byte_size
      ) values (
        'c548803e-8d2f-4fa6-9077-75026ca81dac', ${accountId}, ${"b".repeat(64)},
        'accounts/a4336773-4ece-464c-a4a9-4e884e461c55/career-documents/c548803e-8d2f-4fa6-9077-75026ca81dac/source.md',
        'too-large.md', 'text/markdown', 524289
      )
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into career_documents (
        id, user_id, checksum_sha256, object_key, original_filename, media_type, byte_size
      ) values (
        '3bb4b697-5b76-4f1a-a54c-20dcc9ff232e', ${accountId}, 'not-a-sha256',
        'accounts/a4336773-4ece-464c-a4a9-4e884e461c55/career-documents/3bb4b697-5b76-4f1a-a54c-20dcc9ff232e/source.md',
        'invalid-checksum.md', 'text/markdown', 1
      )
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await migratedDatabase.execute(sql`
      insert into career_documents (
        id, user_id, checksum_sha256, object_key, original_filename, media_type, byte_size
      ) values (
        ${crossAccountDocumentId}, ${accountId}, ${"c".repeat(64)},
        'accounts/a4336773-4ece-464c-a4a9-4e884e461c55/career-documents/5a40f44f-3645-4834-9026-543e1af66ea5/source.md',
        'cross-account.md', 'text/markdown', 1
      )
    `);

    await migratedDatabase.execute(sql`
      insert into career_imports (
        id, user_id, career_document_id, status, parser_adapter, parser_version, prompt_version,
        output_schema_version, originating_request_id, queued_at
      ) values (
        ${careerImportId}, ${accountId}, ${documentId}, 'queued', 'fake', 'fake-career-parser-v1',
        'career-import-prompt-v1', 'career-facts-v1', 'f3e607c7-bf67-454c-929a-51c844f1cf35', now()
      )
    `);
    await expect(migratedDatabase.execute(sql`
      insert into career_imports (
        id, user_id, career_document_id, status, parser_adapter, parser_version, prompt_version,
        output_schema_version, originating_request_id, queued_at
      ) values (
        '61a8ba61-1f66-4df5-8e5d-3346fd2990de', ${secondAccountId}, ${crossAccountDocumentId}, 'queued', 'fake',
        'fake-career-parser-v1', 'career-import-prompt-v1', 'career-facts-v1',
        '5c1fc1d0-0a59-4e9f-a720-e1b9dbdab3ae', now()
      )
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into career_imports (
        id, user_id, career_document_id, status, parser_adapter, parser_version, prompt_version,
        output_schema_version, originating_request_id, queued_at
      ) values (
        '88a8f5b3-5a36-4d3c-8052-fda9bd6c0be3', ${secondAccountId}, ${secondDocumentId}, 'invalid', 'fake',
        'fake-career-parser-v1', 'career-import-prompt-v1', 'career-facts-v1',
        '8e434e80-d053-4aa5-83ec-540ba49b174d', now()
      )
    `)).rejects.toMatchObject({ cause: { code: "23514" } });

    await expect(migratedDatabase.execute(sql`
      insert into candidate_facts (
        id, user_id, career_import_id, career_document_id, fact_key, fact_type, fact_value,
        confidence_basis_points, confirmation_status
      ) values (
        '60488036-13b3-4857-88de-df89a6011a88', ${accountId}, ${careerImportId}, ${documentId},
        ${"c".repeat(64)}, 'skill', '{"name":"TypeScript"}'::jsonb, 10001, 'pending'
      )
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into candidate_facts (
        id, user_id, career_import_id, career_document_id, fact_key, fact_type, fact_value,
        confidence_basis_points, confirmation_status
      ) values (
        '18f91b3f-a57f-4dbf-a49b-bc570b2d5ae1', ${accountId}, ${careerImportId}, ${documentId},
        ${"f".repeat(64)}, 'invalid', '{"name":"TypeScript"}'::jsonb, 10000, 'pending'
      )
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await migratedDatabase.execute(sql`
      insert into candidate_facts (
        id, user_id, career_import_id, career_document_id, fact_key, fact_type, fact_value,
        confidence_basis_points, confirmation_status
      ) values (
        ${factId}, ${accountId}, ${careerImportId}, ${documentId}, ${"d".repeat(64)}, 'skill',
        '{"name":"TypeScript"}'::jsonb, 10000, 'pending'
      )
    `);
    const conflictPeerId = "f2b19e57-21a8-4959-b3c7-55a0c2281849";
    await migratedDatabase.execute(sql`
      insert into candidate_facts (id, user_id, career_import_id, career_document_id, fact_key, fact_type, fact_value, confidence_basis_points, confirmation_status)
      values (${conflictPeerId}, ${accountId}, ${careerImportId}, ${documentId}, ${"1".repeat(64)}, 'skill', '{"name":"Rust"}'::jsonb, 10000, 'pending')
    `);
    for (const [id, status, resolution, profileVersion, resolvedAt] of [
      ["47b19616-1c62-4b72-a2bf-5894b8b8a1de", "pending", "use_existing", null, null],
      ["00a1bbf1-cc4c-4cf3-9e2a-b722b4619a2a", "pending", null, 1, null],
      ["6d518015-72ed-4292-a619-df8d8a5c0868", "resolved", null, null, null],
      ["08fe381a-6c2a-458a-a3b2-36c73ae4b0a8", "resolved", "use_existing", 0, "now()"],
      ["89a434b8-5767-4fa1-8ea9-67b25b61c6d1", "resolved", "invalid", 1, "now()"],
    ] as const) {
      await expect(migratedDatabase.execute(sql`
        insert into career_fact_conflicts (id, user_id, existing_candidate_fact_id, incoming_candidate_fact_id, kind, status, resolution, profile_version, resolved_at)
        values (${id}, ${accountId}, ${factId}, ${conflictPeerId}, 'role', ${status}, ${resolution}, ${profileVersion}, ${resolvedAt === "now()" ? sql`now()` : null})
      `)).rejects.toMatchObject({ cause: { code: "23514" } });
    }
    await expect(migratedDatabase.execute(sql`
      insert into candidate_facts (
        id, user_id, career_import_id, career_document_id, fact_key, fact_type, fact_value,
        confidence_basis_points, confirmation_status
      ) values (
        '5fc5b95e-3a27-4cda-9929-7e7d78976b4a', ${secondAccountId}, ${careerImportId}, ${documentId},
        ${"9".repeat(64)}, 'skill', '{"name":"Cross-account"}'::jsonb, 10000, 'pending'
      )
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into candidate_fact_evidence (
        id, user_id, candidate_fact_id, career_document_id, locator_type, start_line, end_line,
        excerpt, excerpt_sha256
      ) values (
        '1d7ed7ea-806c-448d-aa0d-bbb9fb225f6a', ${accountId}, ${factId}, ${documentId},
        'markdown_lines', 2, 1, 'TypeScript', ${"e".repeat(64)}
      )
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into candidate_fact_evidence (
        id, user_id, candidate_fact_id, career_document_id, locator_type, start_line, end_line,
        excerpt, excerpt_sha256
      ) values (
        '264b7047-3cfe-452c-9f58-cc0250e53017', ${accountId}, ${factId}, ${documentId},
        'markdown_lines', 0, 1, 'TypeScript', ${"e".repeat(64)}
      )
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    const secondImportId = "dcb7a005-e127-4557-94e9-f709ee0e70c5";
    const secondFactId = "ab7b9ebd-8288-4f6b-9e85-fac2029e22e9";
    await migratedDatabase.execute(sql`
      insert into career_imports (
        id, user_id, career_document_id, status, parser_adapter, parser_version, prompt_version,
        output_schema_version, originating_request_id, queued_at
      ) values (
        ${secondImportId}, ${secondAccountId}, ${secondDocumentId}, 'queued', 'fake',
        'fake-career-parser-v1', 'career-import-prompt-v1', 'career-facts-v1',
        'c99825b1-f0d8-4a74-b5b3-e6497e96b685', now()
      )
    `);
    await migratedDatabase.execute(sql`
      insert into candidate_facts (
        id, user_id, career_import_id, career_document_id, fact_key, fact_type, fact_value,
        confidence_basis_points, confirmation_status
      ) values (
        ${secondFactId}, ${secondAccountId}, ${secondImportId}, ${secondDocumentId},
        ${"8".repeat(64)}, 'skill', '{"name":"Second account"}'::jsonb, 10000, 'pending'
      )
    `);
    await expect(migratedDatabase.execute(sql`
      insert into candidate_fact_evidence (
        id, user_id, candidate_fact_id, career_document_id, locator_type, start_line, end_line,
        excerpt, excerpt_sha256
      ) values (
        '05a47af4-834f-4dd1-90e0-49a20e22ffb1', ${accountId}, ${secondFactId}, ${documentId},
        'markdown_lines', 1, 1, '- Cross-account', ${"7".repeat(64)}
      )
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into career_documents (id, user_id, checksum_sha256, object_key, original_filename, source_format, media_type, byte_size)
      values ('7bc645bf-c1d9-4e1e-8ef8-a74c1389dbfe', ${accountId}, ${"6".repeat(64)}, 'accounts/x/processing.txt', 'resume.docx', 'docx', 'text/markdown', 1)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("migrates versioned account-owned 求职目标 with one active primary", async () => {
    const firstAccountId = "f7e06d1e-fd43-4053-8f75-9f9c20e7be8a";
    const secondAccountId = "0fdbdf60-ebc6-4d04-b0df-3d39ec41e3c8";
    const primaryTargetId = "e9ec8a65-aea8-454c-87c7-55a986d6eeb0";
    const inactiveTargetId = "779f905f-949a-4f26-baa5-4cf27e69c567";
    const secondaryTargetId = "4ad5b722-ac74-46bd-aeb3-7b6d3d5a8137";
    const constraintValue = '{"roleFamily":"AI 应用工程师","seniority":null,"locations":[],"workModes":[],"relocation":"unknown","salary":null,"industries":[],"dealBreakers":{"excludedCompanies":[],"excludedIndustries":[],"excludeOutsourcing":false,"excludeDispatch":false,"excludeHeadhunter":false,"other":[]}}';

    expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
      "job_targets", "job_target_revisions",
    ]));
    expect(await listColumns(migratedDatabase)).toEqual(expect.arrayContaining([
      { table_name: "job_targets", column_name: "version", data_type: "integer" },
      { table_name: "job_targets", column_name: "active_slot", data_type: "integer" },
      { table_name: "job_target_revisions", column_name: "version", data_type: "integer" },
      { table_name: "job_target_revisions", column_name: "constraints", data_type: "jsonb" },
    ]));

    const foreignKeys = await migratedDatabase.execute(sql`
      select conname from pg_constraint where conname in (
        'job_targets_user_id_id_unique', 'job_target_revisions_target_version_unique',
        'job_target_revisions_owner_target_fk'
      ) order by conname
    `);
    expect(foreignKeys).toHaveLength(3);

    await migratedDatabase.execute(sql`insert into job_accounts (id) values (${firstAccountId}), (${secondAccountId})`);
    await migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state)
      values (${primaryTargetId}, ${firstAccountId}, 1, 'primary', 'active')
    `);
    await expect(migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state)
      values ('0f9826b8-a9dc-43a3-b361-5df7b0e4f7e0', ${firstAccountId}, 1, 'primary', 'active')
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state, active_slot)
      values (${inactiveTargetId}, ${firstAccountId}, 1, 'primary', 'inactive', null),
             (${secondaryTargetId}, ${firstAccountId}, 1, 'secondary', 'active', 1)
    `);
    await migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state, active_slot)
      values ('9d741730-c501-44af-bdca-7b42ed19df5b', ${firstAccountId}, 1, 'secondary', 'active', 2)
    `);
    await expect(migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state, active_slot)
      values ('4bb2e0ba-1b88-4d8e-923a-6382ea5f47fa', ${firstAccountId}, 1, 'secondary', 'active', 1)
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state)
      values ('6fc74b2c-455b-469d-9c19-5dce5e4775c5', ${firstAccountId}, 1, 'secondary', 'active')
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state, active_slot)
      values ('fc2dadf5-f1be-416b-99c6-98bb6f9e7ca3', ${firstAccountId}, 1, 'secondary', 'active', 3)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });

    await migratedDatabase.execute(sql`
      insert into job_target_revisions (id, user_id, target_id, version, priority, state, constraints)
      values ('db2d5db1-f1a3-4252-ae4c-1ed6c48c8c13', ${firstAccountId}, ${primaryTargetId}, 1, 'primary', 'active', ${constraintValue}::jsonb)
    `);
    await expect(migratedDatabase.execute(sql`
      insert into job_target_revisions (id, user_id, target_id, version, priority, state, constraints)
      values ('764a9375-67fe-4313-9917-498a09dc693f', ${firstAccountId}, ${primaryTargetId}, 1, 'primary', 'active', ${constraintValue}::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(migratedDatabase.execute(sql`
      insert into job_target_revisions (id, user_id, target_id, version, priority, state, constraints)
      values ('886edc65-5034-4d81-8af5-c90fb73141e1', ${firstAccountId}, ${primaryTargetId}, 0, 'primary', 'active', ${constraintValue}::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into job_target_revisions (id, user_id, target_id, version, priority, state, constraints)
      values ('1d8f3f2e-b1e1-4748-8f59-73153449e1aa', ${secondAccountId}, ${primaryTargetId}, 2, 'primary', 'active', ${constraintValue}::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("migrates versioned account-owned job imports", async () => {
    expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
      "job_imports", "job_opportunities", "job_opportunity_sources", "job_source_postings", "job_source_posting_versions",
    ]));
    expect(await listConstraintNames(migratedDatabase)).toEqual(expect.arrayContaining([
      "job_source_postings_user_identity_unique",
      "job_source_posting_versions_posting_version_unique",
      "job_opportunities_user_dedup_unique",
      "job_opportunity_sources_opportunity_version_unique",
      "job_opportunity_sources_owner_opportunity_fk",
      "job_opportunity_sources_owner_posting_version_fk",
    ]));
    expect(await listColumns(migratedDatabase)).toEqual(expect.arrayContaining([
      { table_name: "job_imports", column_name: "claim_token", data_type: "uuid" },
      { table_name: "job_imports", column_name: "claim_expires_at", data_type: "timestamp with time zone" },
      { table_name: "job_imports", column_name: "requested_url", data_type: "character varying" },
      { table_name: "job_imports", column_name: "canonical_url", data_type: "character varying" },
      { table_name: "job_imports", column_name: "source_kind", data_type: "character varying" },
      { table_name: "job_source_postings", column_name: "is_official", data_type: "boolean" },
      { table_name: "job_source_posting_versions", column_name: "raw_content_sha256", data_type: "character varying" },
    ]));
  });

  it("migrates durable account-owned agent runs without requiring an import", async () => {
    expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
      "agent_runs", "agent_run_steps", "agent_run_events", "agent_run_job_results",
    ]));
    expect(await listConstraintNames(migratedDatabase)).toEqual(expect.arrayContaining([
      "agent_runs_user_idempotency_unique",
      "agent_run_steps_run_step_unique",
      "agent_run_events_run_sequence_unique",
      "agent_run_job_results_run_opportunity_source_unique",
      "job_opportunities_owner_import_fk",
      "job_opportunities_owner_posting_version_fk",
    ]));
    const [importId] = await migratedDatabase.execute(sql`
      select is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'job_opportunities' and column_name = 'import_id'
    `) as unknown as Array<{ is_nullable: string }>;
    expect(importId).toEqual({ is_nullable: "YES" });

    expect(await listConstraintNames(migratedDatabase)).toEqual(expect.arrayContaining([
      "agent_runs_owner_target_fk",
      "agent_run_steps_owner_run_fk",
      "agent_run_events_owner_run_fk",
      "agent_run_job_results_owner_run_fk",
      "agent_run_job_results_owner_opportunity_fk",
      "agent_run_job_results_owner_posting_version_fk",
      "agent_run_job_results_evidence_tuple_fk",
      "job_opportunity_sources_evidence_tuple_unique",
    ]));

    const firstAccountId = "29a65f3c-6e60-4d03-8098-6ef15f21e43e";
    const secondAccountId = "c0923c50-01ac-45bd-96f6-25c05e6531ec";
    const targetId = "0bd83c11-c3f1-420b-964b-eeed48f062b8";
    const runId = "8402621f-4f92-4d5f-8904-dbf65d1a2aa4";
    const firstPostingId = "acbbc261-72b2-48bc-9f41-029fd22cf2a7";
    const secondPostingId = "e6e4c08e-ab0d-40fb-9039-17236b685965";
    const firstVersionId = "0b363d9a-8f15-4f48-96ce-dff6023b7b93";
    const secondVersionId = "57ba64e3-c48d-47ae-9982-2c4f7c4e4d48";
    const firstOpportunityId = "8ba999fe-3db6-4ed1-bf96-4e9c7ce4bc38";
    const secondOpportunityId = "29d3d5a8-79f2-4136-83e1-6754f4fd9b6b";
    const checksum = "a".repeat(64);

    await migratedDatabase.execute(sql`insert into job_accounts (id) values (${firstAccountId}), (${secondAccountId})`);
    await migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state)
      values (${targetId}, ${firstAccountId}, 1, 'primary', 'active')
    `);
    await migratedDatabase.execute(sql`
      insert into agent_runs (
        id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot,
        workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step
      ) values (
        ${runId}, ${firstAccountId}, ${targetId}, '2f15fd9f-0398-4a5c-94e2-103167bcd1c2', 1,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'workflow-v1', 'fake-job-discovery-rules-v1', 'fake', 'fake-v1', 'result-v1', '[]'::jsonb, 'queued', 'queued'
      )
    `);
    await expect(migratedDatabase.execute(sql`
      insert into agent_runs (
        id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot,
        workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step
      ) values (
        'c1367bbf-f608-4be2-85ea-0742160a16d8', ${secondAccountId}, ${targetId},
        '5572512a-e2f2-43d6-8290-88d64f12ed46', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        'workflow-v1', 'fake-job-discovery-rules-v1', 'fake', 'fake-v1', 'result-v1', '[]'::jsonb, 'queued', 'queued'
      )
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_steps (id, user_id, run_id, step_key, ordinal)
      values ('0505954e-e2e9-4b8f-ae5f-b5a0ba6c9093', ${secondAccountId}, ${runId}, 'batch_search', 1)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });

    await migratedDatabase.execute(sql`
      insert into job_source_postings (id, user_id, source_type, source_identifier, source_identity)
      values (${firstPostingId}, ${firstAccountId}, 'fake', 'first-posting', '{}'::jsonb),
             (${secondPostingId}, ${secondAccountId}, 'fake', 'second-posting', '{}'::jsonb)
    `);
    await migratedDatabase.execute(sql`
      insert into job_source_posting_versions (
        id, user_id, source_posting_id, version, content_sha256, raw_content_sha256, raw_object_reference, retrieved_at
      ) values
        (${firstVersionId}, ${firstAccountId}, ${firstPostingId}, 1, ${checksum}, ${"b".repeat(64)}, '{}'::jsonb, now()),
        (${secondVersionId}, ${secondAccountId}, ${secondPostingId}, 1, ${"c".repeat(64)}, ${"d".repeat(64)}, '{}'::jsonb, now())
    `);
    await migratedDatabase.execute(sql`
      insert into job_opportunities (id, user_id, source_posting_version_id, dedup_key, normalized_data)
      values (${firstOpportunityId}, ${firstAccountId}, ${firstVersionId}, ${"e".repeat(64)}, '{}'::jsonb),
             (${secondOpportunityId}, ${secondAccountId}, ${secondVersionId}, ${"f".repeat(64)}, '{}'::jsonb)
    `);
    await migratedDatabase.execute(sql`
      insert into job_opportunity_sources (id, user_id, opportunity_id, source_posting_version_id)
      values ('2f6ab2d5-5cd1-45c6-920a-c0162593031a', ${firstAccountId}, ${firstOpportunityId}, ${firstVersionId})
    `);
    await migratedDatabase.execute(sql`
      insert into agent_run_job_results (id, user_id, run_id, opportunity_id, source_posting_version_id, ordinal)
      values ('18db43ed-b15d-4c2b-b659-979d75cdcbd9', ${firstAccountId}, ${runId}, ${firstOpportunityId}, ${firstVersionId}, 1)
    `);
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_job_results (id, user_id, run_id, opportunity_id, source_posting_version_id, ordinal)
      values ('6be339cd-57b6-4c0d-bc75-62bf15b2b6b5', ${firstAccountId}, ${runId}, ${secondOpportunityId}, ${firstVersionId}, 2)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_job_results (id, user_id, run_id, opportunity_id, source_posting_version_id, ordinal)
      values ('1eb77c10-d6e1-4f75-9e8c-a32db63967ee', ${firstAccountId}, ${runId}, ${firstOpportunityId}, ${secondVersionId}, 3)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("migrates agent run controls, usage ledger, and Inbox ownership constraints", async () => {
    expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
      "agent_run_control_commands", "agent_run_usage_entries", "agent_inbox_items", "agent_inbox_item_actions",
    ]));
    expect(await listConstraintNames(migratedDatabase)).toEqual(expect.arrayContaining([
      "agent_run_control_commands_user_run_command_unique",
      "agent_run_usage_entries_run_key_category_unique",
      "agent_inbox_items_run_event_kind_unique",
      "agent_inbox_item_actions_user_item_action_unique",
    ]));
    expect(await listColumns(migratedDatabase)).toEqual(expect.arrayContaining([
      { table_name: "agent_runs", column_name: "control_state", data_type: "character varying" },
      { table_name: "agent_runs", column_name: "usage_complete", data_type: "boolean" },
      { table_name: "agent_runs", column_name: "cancelled_at", data_type: "timestamp with time zone" },
    ]));

    const userId = "5bfd5c5e-dc14-4648-8f5e-a9cda8c86b89";
    const otherUserId = "55e88f9d-7609-443e-b6a9-db1b3a56d747";
    const targetId = "f40889d1-bf7f-4fa0-b9ce-a6651b6e1f23";
    const runId = "b1a4c066-d64c-4e27-9f4f-b102701adf30";
    await migratedDatabase.execute(sql`insert into job_accounts (id) values (${userId}), (${otherUserId})`);
    await migratedDatabase.execute(sql`insert into job_targets (id, user_id, version, priority, state) values (${targetId}, ${userId}, 1, 'primary', 'active')`);
    await migratedDatabase.execute(sql`
      insert into agent_runs (
        id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot,
        workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step
      ) values (
        ${runId}, ${userId}, ${targetId}, '7b8b0f5e-0e77-4e54-8501-d03987e4b76e', 1, '{}'::jsonb, '{}'::jsonb,
        '{"maxActiveDurationMs":60000}'::jsonb, 'job-discovery-workflow-v1', 'fake-job-discovery-rules-v1', 'fake',
        'fake-job-discovery-v1', 'job-discovery-result-v1', '["job_discovery.search_batch","job_discovery.get_detail"]'::jsonb, 'queued', 'queued'
      )
    `);
    for (const [index, eventType] of [
      "run.pause_requested",
      "run.paused",
      "run.resume_requested",
      "run.resumed",
      "run.cancel_requested",
      "run.cancelled",
      "run.budget_updated",
    ].entries()) {
      await expect(migratedDatabase.execute(sql`
        insert into agent_run_events (id, user_id, run_id, sequence, run_version, event_type, data)
        values (
          ${`933bfe5a-8154-4c67-9f51-00000000000${index + 1}`}, ${userId}, ${runId}, ${index + 1}, 1,
          ${eventType}, '{}'::jsonb
        )
      `)).resolves.toBeDefined();
    }
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_events (id, user_id, run_id, sequence, run_version, event_type, data)
      values ('933bfe5a-8154-4c67-9f51-000000000008', ${userId}, ${runId}, 8, 1, 'run.unknown', '{}'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_control_commands (user_id, run_id, command_id, action, applied, result_run_version, result_snapshot)
      values (${otherUserId}, ${runId}, '61fbc726-9ab7-4ea4-bfb8-701d4a31eb04', 'pause', true, 1,
        '{"runId":"b1a4c066-d64c-4e27-9f4f-b102701adf30","status":"queued","currentStep":"queued","controlState":"none","version":1}'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_control_commands (user_id, run_id, command_id, action, applied, result_run_version, result_snapshot)
      values (${userId}, ${runId}, '77c1a312-af11-4450-99a2-6712be94ea1f', 'pause', true, 1, '{}'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_control_commands (user_id, run_id, command_id, action, applied, result_run_version, result_snapshot)
      values (${userId}, ${runId}, 'f2c1b5b8-e8f0-4e9e-b99d-e92ebef62e88', 'pause', true, 1,
        '{"runId":"b1a4c066-d64c-4e27-9f4f-b102701adf30","status":"queued","currentStep":"queued","controlState":"none","version":1,"extra":true}'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_control_commands (user_id, run_id, command_id, action, applied, result_run_version, result_snapshot)
      values (${userId}, ${runId}, '7af22430-308f-4db1-b7cf-2d5b3e8daa15', 'pause', true, 2,
        '{"runId":"49a910ab-1d1f-4669-b4b4-9021b52ed88f","status":"queued","currentStep":"queued","controlState":"none","version":1}'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      update agent_runs
      set status = 'completed', current_step = 'completed', started_at = now(), completed_at = now(),
          usage_complete = true, termination_kind = 'cancelled_by_user'
      where id = ${runId}
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      update agent_runs
      set termination_kind = 'source_failed', failure_code = 'AGENT_RUN_ADAPTER_FAILED'
      where id = ${runId}
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      update agent_runs
      set status = 'completed', current_step = 'completed', started_at = now(), completed_at = now(),
          usage_complete = true, termination_kind = null, failure_code = null, termination_budget_dimension = null
      where id = ${runId}
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      update agent_runs
      set status = 'failed', current_step = 'failed', started_at = now(), failed_at = now(),
          usage_complete = true, termination_kind = 'source_failed', failure_code = null, termination_budget_dimension = null
      where id = ${runId}
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      update agent_runs
      set status = 'failed', current_step = 'failed', started_at = now(), failed_at = now(),
          usage_complete = true, termination_kind = 'budget_exhausted', failure_code = null, termination_budget_dimension = null
      where id = ${runId}
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      update agent_runs
      set status = 'completed', current_step = 'completed', started_at = now(), completed_at = now(),
          usage_complete = false, termination_kind = null, failure_code = null, termination_budget_dimension = null
      where id = ${runId}
    `)).resolves.toBeDefined();
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_usage_entries (user_id, run_id, usage_key, category, amount, attempt_count)
      values (${userId}, ${runId}, 'claim:1', 'tool_call', -1, 0)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into agent_runs (id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot, workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step)
      values ('6c6d14df-dedf-468e-a0b3-e4379f73ca01', ${userId}, ${targetId}, '03ea1134-1f6d-4b8f-a671-873a1cc48660', 1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'job-discovery-workflow-v1', 'fake-job-discovery-rules-v1', 'fake', 'fake-job-discovery-v1', 'job-discovery-result-v1', '[]'::jsonb, 'unknown', 'queued')
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_control_commands (user_id, run_id, command_id, action, applied, result_run_version, result_snapshot)
      values (${userId}, ${runId}, '87b056c2-42e1-4f34-8353-f430e80268a0', 'unknown', true, 1, '{}'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await migratedDatabase.execute(sql`
      insert into agent_run_usage_entries (user_id, run_id, usage_key, category, amount, attempt_count)
      values (${userId}, ${runId}, 'claim:1', 'tool_call', 1, 0)
    `);
    await expect(migratedDatabase.execute(sql`
      insert into agent_run_usage_entries (user_id, run_id, usage_key, category, amount, attempt_count)
      values (${userId}, ${runId}, 'claim:1', 'tool_call', 1, 0)
    `)).rejects.toMatchObject({ cause: { code: "23505" } });

    const claimRunId = "7be68e63-a4a2-476a-ac4b-6472d58498d2";
    const claimToken = "3fd44a07-cd0d-4d0e-9db2-af6989826d22";
    await migratedDatabase.execute(sql`
      insert into agent_runs (
        id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot,
        workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step
      ) values (
        ${claimRunId}, ${userId}, ${targetId}, 'dd3eb80c-98a9-4783-81e7-53e7d8d78b0e', 1, '{}'::jsonb, '{}'::jsonb,
        '{"maxActiveDurationMs":60000}'::jsonb, 'job-discovery-workflow-v1', 'fake-job-discovery-rules-v1', 'fake',
        'fake-job-discovery-v1', 'job-discovery-result-v1', '["job_discovery.search_batch","job_discovery.get_detail"]'::jsonb, 'queued', 'queued'
      )
    `);
    const partialClaims = [
      sql`update agent_runs set claim_token = ${claimToken} where id = ${claimRunId}`,
      sql`update agent_runs set claim_expires_at = now() + interval '30 seconds' where id = ${claimRunId}`,
      sql`update agent_runs set active_slice_started_at = now() where id = ${claimRunId}`,
      sql`update agent_runs set status = 'running', current_step = 'batch_search', started_at = now(), claim_token = ${claimToken}, claim_expires_at = now() + interval '30 seconds' where id = ${claimRunId}`,
      sql`update agent_runs set claim_token = ${claimToken}, active_slice_started_at = now() where id = ${claimRunId}`,
      sql`update agent_runs set claim_expires_at = now() + interval '30 seconds', active_slice_started_at = now() where id = ${claimRunId}`,
    ];
    for (const partialClaim of partialClaims) {
      await expect(migratedDatabase.execute(partialClaim)).rejects.toMatchObject({ cause: { code: "23514" } });
    }
    await expect(migratedDatabase.execute(sql`
      update agent_runs
      set status = 'running', current_step = 'batch_search', started_at = now(), claim_token = ${claimToken},
          claim_expires_at = now() + interval '30 seconds', active_slice_started_at = now()
      where id = ${claimRunId}
    `)).resolves.toBeDefined();
  });

  it("upgrades a #9-shaped agent run budget without inventing usage", async () => {
    const legacyContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
    const legacyDatabase = createDatabase(legacyContainer.getConnectionUri());
    const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-agent-run-legacy-"));
    try {
      const migrationSource = fileURLToPath(new URL("../migrations", import.meta.url));
      await cp(migrationSource, migrationsFolder, { recursive: true });
      await unlink(join(migrationsFolder, "0018_agent_run_control_budget_inbox.sql"));
      const journalPath = join(migrationsFolder, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, 18);
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migrate(legacyDatabase, { migrationsFolder });

      const userId = "ffd381dc-764b-481a-a6f1-ac7b88a5f2cf";
      const targetId = "32a8d3c7-cb50-47f2-b13c-67a4d09c41c9";
      const runId = "adc1750f-89dc-40b2-ad18-6de0938a698f";
      await legacyDatabase.execute(sql`insert into job_accounts (id) values (${userId})`);
      await legacyDatabase.execute(sql`insert into job_targets (id, user_id, version, priority, state) values (${targetId}, ${userId}, 1, 'primary', 'active')`);
      await legacyDatabase.execute(sql`
        insert into agent_runs (
          id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot,
          workflow_version, adapter, adapter_version, output_schema_version, status, current_step
        ) values (
          ${runId}, ${userId}, ${targetId}, '462eb676-60c6-48d7-9c7a-5d2797946909', 1, '{}'::jsonb, '{}'::jsonb,
          '{"maxDurationMs":60000,"maxAttempts":3}'::jsonb, 'job-discovery-workflow-v1', 'fake', 'fake-job-discovery-v1',
          'job-discovery-result-v1', 'queued', 'queued'
        )
      `);
      await migrateDatabase(legacyDatabase);
      const [upgraded] = await legacyDatabase.execute(sql`
        select budget_snapshot, usage_complete from agent_runs where id = ${runId}
      `) as unknown as Array<{ budget_snapshot: { maxActiveDurationMs: number; maxDurationMs?: number }; usage_complete: boolean }>;
      expect(upgraded).toEqual({ budget_snapshot: { maxActiveDurationMs: 60_000, maxAttempts: 3 }, usage_complete: false });
    } finally {
      await legacyDatabase.$client.end();
      await legacyContainer.stop();
      await rm(migrationsFolder, { recursive: true, force: true });
    }
  }, 60_000);

  it("migrates one versioned company Watchlist per owned job target", async () => {
    expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
      "company_watchlists", "company_watchlist_revisions",
    ]));
    expect(await listColumns(migratedDatabase)).toEqual(expect.arrayContaining([
      { table_name: "company_watchlists", column_name: "id", data_type: "uuid" },
      { table_name: "company_watchlists", column_name: "user_id", data_type: "uuid" },
      { table_name: "company_watchlists", column_name: "target_id", data_type: "uuid" },
      { table_name: "company_watchlists", column_name: "version", data_type: "integer" },
      { table_name: "company_watchlists", column_name: "created_at", data_type: "timestamp with time zone" },
      { table_name: "company_watchlists", column_name: "updated_at", data_type: "timestamp with time zone" },
      { table_name: "company_watchlist_revisions", column_name: "id", data_type: "uuid" },
      { table_name: "company_watchlist_revisions", column_name: "user_id", data_type: "uuid" },
      { table_name: "company_watchlist_revisions", column_name: "watchlist_id", data_type: "uuid" },
      { table_name: "company_watchlist_revisions", column_name: "target_id", data_type: "uuid" },
      { table_name: "company_watchlist_revisions", column_name: "version", data_type: "integer" },
      { table_name: "company_watchlist_revisions", column_name: "items", data_type: "jsonb" },
      { table_name: "company_watchlist_revisions", column_name: "created_at", data_type: "timestamp with time zone" },
    ]));
    expect(await listConstraintNames(migratedDatabase)).toEqual(expect.arrayContaining([
      "company_watchlists_user_target_unique",
      "company_watchlists_user_id_id_unique",
      "company_watchlists_user_watchlist_target_unique",
      "company_watchlists_owner_target_fk",
      "company_watchlists_version_positive",
      "company_watchlist_revisions_watchlist_version_unique",
      "company_watchlist_revisions_watchlist_target_fk",
      "company_watchlist_revisions_owner_target_fk",
      "company_watchlist_revisions_version_positive",
      "company_watchlist_revisions_items_array",
    ]));

    const firstUserId = "b4a8c44c-56f5-4420-8f58-bd3e7552e7f1";
    const secondUserId = "56ee9fe7-fd11-40a8-99ad-49d43c53f1d2";
    const targetId = "1e71e774-1e28-4f02-86d9-9d28b7626ac8";
    const unrelatedTargetId = "97d7d6a4-cec0-4476-9b1a-f70da8fdeae4";
    const watchlistId = "eb2a0489-c159-46a3-9465-5eb4e6c6b0a9";
    await migratedDatabase.execute(sql`insert into job_accounts (id) values (${firstUserId}), (${secondUserId})`);
    await migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state)
      values (${targetId}, ${firstUserId}, 1, 'primary', 'active')
    `);
    await migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state, active_slot)
      values (${unrelatedTargetId}, ${firstUserId}, 1, 'secondary', 'active', 1)
    `);
    await migratedDatabase.execute(sql`
      insert into company_watchlists (id, user_id, target_id, version)
      values (${watchlistId}, ${firstUserId}, ${targetId}, 1)
    `);
    await expect(migratedDatabase.execute(sql`
      insert into company_watchlists (id, user_id, target_id, version)
      values ('61ab659a-01a0-4d76-bc2e-2fe35deaf004', ${firstUserId}, ${targetId}, 1)
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(migratedDatabase.execute(sql`
      insert into company_watchlists (id, user_id, target_id, version)
      values ('a9c819a8-43cf-45ce-b68d-f4a490cd61d9', ${secondUserId}, ${targetId}, 1)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into company_watchlists (id, user_id, target_id, version)
      values ('fc18b30c-c9f4-4be9-8b2a-049765b910ce', ${firstUserId}, ${targetId}, 0)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await migratedDatabase.execute(sql`
      insert into company_watchlist_revisions (user_id, watchlist_id, target_id, version, items)
      values (${firstUserId}, ${watchlistId}, ${targetId}, 1, '[]'::jsonb)
    `);
    await expect(migratedDatabase.execute(sql`
      insert into company_watchlist_revisions (user_id, watchlist_id, target_id, version, items)
      values (${firstUserId}, ${watchlistId}, ${unrelatedTargetId}, 2, '[]'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into company_watchlist_revisions (user_id, watchlist_id, target_id, version, items)
      values (${firstUserId}, ${watchlistId}, ${targetId}, 2, '{}'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into company_watchlist_revisions (user_id, watchlist_id, target_id, version, items)
      values (${firstUserId}, ${watchlistId}, ${targetId}, 1, '[]'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(migratedDatabase.execute(sql`
      insert into company_watchlist_revisions (user_id, watchlist_id, target_id, version, items)
      values (${firstUserId}, ${watchlistId}, ${targetId}, 0, '[]'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(migratedDatabase.execute(sql`
      insert into company_watchlist_revisions (user_id, watchlist_id, target_id, version, items)
      values (${secondUserId}, ${watchlistId}, ${targetId}, 2, '[]'::jsonb)
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("migrates owned daily schedules, occurrence ledger, and lifecycle availability", async () => {
    expect(await listPublicTables(migratedDatabase)).toEqual(expect.arrayContaining([
      "job_discovery_schedules", "job_discovery_schedule_occurrences",
    ]));
    expect(await listConstraintNames(migratedDatabase)).toEqual(expect.arrayContaining([
      "job_discovery_schedules_user_target_unique",
      "job_discovery_schedules_user_schedule_target_unique",
      "job_discovery_schedules_owner_target_fk",
      "job_discovery_schedules_version_positive",
      "job_discovery_schedules_state_check",
      "job_discovery_schedules_daily_time_check",
      "job_discovery_schedules_time_zone_check",
      "job_discovery_schedule_occurrences_schedule_time_unique",
      "job_discovery_schedule_occurrences_owner_schedule_fk",
      "job_discovery_schedule_occurrences_owner_run_fk",
      "job_discovery_schedule_occurrences_status_check",
      "job_discovery_schedule_occurrences_skip_reason_check",
      "job_discovery_schedule_occurrences_outcome_check",
      "job_source_postings_availability_check",
      "job_source_posting_versions_availability_check",
      "job_opportunities_availability_check",
    ]));
    expect(await listColumns(migratedDatabase)).toEqual(expect.arrayContaining([
      { table_name: "job_discovery_schedules", column_name: "daily_time", data_type: "character varying" },
      { table_name: "job_discovery_schedules", column_name: "time_zone", data_type: "character varying" },
      { table_name: "job_discovery_schedules", column_name: "next_run_at", data_type: "timestamp with time zone" },
      { table_name: "job_discovery_schedule_occurrences", column_name: "scheduled_for", data_type: "timestamp with time zone" },
      { table_name: "job_discovery_schedule_occurrences", column_name: "skip_reason", data_type: "character varying" },
      { table_name: "job_source_postings", column_name: "availability", data_type: "character varying" },
      { table_name: "job_source_postings", column_name: "availability_updated_at", data_type: "timestamp with time zone" },
      { table_name: "job_source_posting_versions", column_name: "availability", data_type: "character varying" },
      { table_name: "job_opportunities", column_name: "availability", data_type: "character varying" },
      { table_name: "job_opportunities", column_name: "availability_updated_at", data_type: "timestamp with time zone" },
    ]));

    const userId = "429ab3b5-3c62-4e21-aa78-00222a75d2cd";
    const otherUserId = "de9e73e0-75c7-427c-98cc-251c4710053c";
    const targetId = "9c472d0c-3d3a-41f8-89eb-a060c42c0e5e";
    const scheduleId = "b0da74f1-a86c-4677-8a7a-fb74ab0080c6";
    const runId = "aeacbdd8-0fdb-4b43-85f9-15dce9bb7cd9";
    await migratedDatabase.execute(sql`insert into job_accounts (id) values (${userId}), (${otherUserId})`);
    await migratedDatabase.execute(sql`
      insert into job_targets (id, user_id, version, priority, state)
      values (${targetId}, ${userId}, 1, 'primary', 'active')
    `);
    await migratedDatabase.execute(sql`
      insert into job_discovery_schedules (id, user_id, target_id, version, state, daily_time, time_zone)
      values (${scheduleId}, ${userId}, ${targetId}, 1, 'enabled', '09:30', 'Asia/Shanghai')
    `);
    await expect(migratedDatabase.execute(sql`
      insert into job_discovery_schedules (id, user_id, target_id, version, state, daily_time, time_zone)
      values ('6a4a9dd9-2093-4564-8f9c-8f8bc1f17cd0', ${userId}, ${targetId}, 1, 'enabled', '09:30', 'Asia/Shanghai')
    `)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(migratedDatabase.execute(sql`
      insert into job_discovery_schedules (id, user_id, target_id, version, state, daily_time, time_zone)
      values ('ed6e5cbc-1c3d-4051-97f7-f3d7096d1b7c', ${userId}, ${targetId}, 0, 'enabled', '24:00', 'UTC')
    `)).rejects.toMatchObject({ cause: { code: "23514" } });
    await migratedDatabase.execute(sql`
      insert into agent_runs (
        id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot,
        workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step
      ) values (
        ${runId}, ${userId}, ${targetId}, '6e8a1a25-3164-49cd-8747-8f81f1ebf8e5', 1,
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'workflow-v1', 'fake-job-discovery-rules-v1', 'fake', 'fake-v1', 'result-v1', '[]'::jsonb, 'queued', 'queued'
      )
    `);
    await migratedDatabase.execute(sql`
      insert into job_discovery_schedule_occurrences (
        id, user_id, schedule_id, target_id, scheduled_for, status, run_id, skip_reason
      ) values (
        'c2d6e6ba-ef51-4f5f-ae34-bc5fbc823bb4', ${userId}, ${scheduleId}, ${targetId}, now(), 'dispatched', ${runId}, null
      )
    `);
    await expect(migratedDatabase.execute(sql`
      insert into job_discovery_schedule_occurrences (
        id, user_id, schedule_id, target_id, scheduled_for, status, run_id, skip_reason
      ) values (
        'e9ab0917-4a19-4483-a9b7-e97aa9cc7478', ${otherUserId}, ${scheduleId}, ${targetId}, now() + interval '1 day', 'dispatched', ${runId}, null
      )
    `)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(migratedDatabase.execute(sql`
      insert into job_discovery_schedule_occurrences (
        id, user_id, schedule_id, target_id, scheduled_for, status, run_id, skip_reason
      ) values (
        'dceff33a-259a-4b9c-bc81-966866e45fbb', ${userId}, ${scheduleId}, ${targetId}, now() + interval '2 days', 'skipped', ${runId}, 'NO_SUPPORTED_SOURCE'
      )
    `)).rejects.toMatchObject({ cause: { code: "23514" } });

    const indexes = await migratedDatabase.execute(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and indexname in (
        'job_discovery_schedules_due_idx', 'job_discovery_schedule_occurrences_pending_idx',
        'job_source_postings_availability_idx', 'job_source_posting_versions_availability_idx',
        'job_opportunities_availability_idx'
      ) order by indexname
    `);
    expect(indexes).toHaveLength(5);
  });

  it("upgrades a 0020 snapshot with open lifecycle defaults without changing stored run JSON", async () => {
    const legacyContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
    const legacyDatabase = createDatabase(legacyContainer.getConnectionUri());
    const migrationsFolder = await mkdtemp(join(tmpdir(), "job-copilot-0020-"));
    try {
      const migrationSource = fileURLToPath(new URL("../migrations", import.meta.url));
      await cp(migrationSource, migrationsFolder, { recursive: true });
      await unlink(join(migrationsFolder, "0021_scheduled_public_job_discovery.sql"));
      const journalPath = join(migrationsFolder, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, 21);
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      await migrate(legacyDatabase, { migrationsFolder });

      const userId = "3e2acbfd-5f0b-40b5-9f8d-ec6a2cda1099";
      const targetId = "69a17980-6900-4e37-8a80-e3d69566caec";
      const runId = "93d6b42f-818d-4a79-8e46-3bcb76d4de80";
      const postingId = "c138c93c-d6f3-4bbe-bcb9-28b4fc2ee589";
      const versionId = "5e0a176b-b445-4b8e-bb39-61f496f22329";
      const opportunityId = "e5ef2ec4-37c1-43d5-a3b6-1a5e414841d6";
      await legacyDatabase.execute(sql`insert into job_accounts (id) values (${userId})`);
      await legacyDatabase.execute(sql`insert into job_targets (id, user_id, version, priority, state) values (${targetId}, ${userId}, 1, 'primary', 'active')`);
      await legacyDatabase.execute(sql`
        insert into agent_runs (id, user_id, target_id, idempotency_key, target_version, target_snapshot, source_scope, budget_snapshot, workflow_version, rule_version, adapter, adapter_version, output_schema_version, tool_allowlist, status, current_step)
        values (${runId}, ${userId}, ${targetId}, 'cc5035d8-eddb-4058-95f1-330ec3d4114e', 1, '{}'::jsonb, '{"kind":"company_watchlist","adapter":"fake"}'::jsonb, '{}'::jsonb, 'workflow-v1', 'fake-job-discovery-rules-v1', 'fake', 'fake-v1', 'result-v1', '[]'::jsonb, 'queued', 'queued')
      `);
      await legacyDatabase.execute(sql`insert into job_source_postings (id, user_id, source_type, source_identifier, source_identity) values (${postingId}, ${userId}, 'fake', 'legacy-posting', '{}'::jsonb)`);
      await legacyDatabase.execute(sql`
        insert into job_source_posting_versions (id, user_id, source_posting_id, version, content_sha256, raw_content_sha256, raw_object_reference, retrieved_at)
        values (${versionId}, ${userId}, ${postingId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, '{}'::jsonb, now())
      `);
      await legacyDatabase.execute(sql`insert into job_opportunities (id, user_id, source_posting_version_id, dedup_key, normalized_data) values (${opportunityId}, ${userId}, ${versionId}, ${"c".repeat(64)}, '{}'::jsonb)`);
      await migrateDatabase(legacyDatabase);
      const [upgraded] = await legacyDatabase.execute(sql`
        select p.availability as posting_availability, p.availability_updated_at is not null as posting_time,
               v.availability as version_availability, o.availability as opportunity_availability,
               o.availability_updated_at is not null as opportunity_time, r.source_scope
        from job_source_postings p
        join job_source_posting_versions v on v.id = ${versionId}
        join job_opportunities o on o.id = ${opportunityId}
        join agent_runs r on r.id = ${runId}
        where p.id = ${postingId}
      `) as unknown as Array<Record<string, unknown>>;
      expect(upgraded).toEqual({
        posting_availability: "open", posting_time: true, version_availability: "open",
        opportunity_availability: "open", opportunity_time: true,
        source_scope: { kind: "company_watchlist", adapter: "fake" },
      });
    } finally {
      await legacyDatabase.$client.end();
      await legacyContainer.stop();
      await rm(migrationsFolder, { recursive: true, force: true });
    }
  }, 60_000);
});
