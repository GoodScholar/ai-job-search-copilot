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
      insert into job_targets (id, user_id, version, priority, state)
      values (${inactiveTargetId}, ${firstAccountId}, 1, 'primary', 'inactive'),
             (${secondaryTargetId}, ${firstAccountId}, 1, 'secondary', 'active')
    `);

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
});
