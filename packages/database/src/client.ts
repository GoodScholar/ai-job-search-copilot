import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema> & { $client: Sql };

export type DatabaseTestObserver = { onQuery(query: string, params: unknown[]): void };

/** `observer` is test-only instrumentation; production receives no logger by default. */
export function createDatabase(url: string, options: { observer?: DatabaseTestObserver } = {}): Database {
  return drizzle({ client: postgres(url), schema, logger: options.observer ? { logQuery: (query, params) => options.observer?.onQuery(query, params) } : false });
}
