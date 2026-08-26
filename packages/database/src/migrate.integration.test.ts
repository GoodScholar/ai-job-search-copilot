import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
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
});
