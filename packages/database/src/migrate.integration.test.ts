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
});
