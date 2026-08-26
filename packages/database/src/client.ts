import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema> & { $client: Sql };

export function createDatabase(url: string): Database {
  return drizzle({ client: postgres(url), schema });
}
