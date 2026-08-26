import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export function migrateDatabase(database: Database): Promise<void> {
  return migrate(database, { migrationsFolder });
}
