import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Database } from "./client";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const legacyJournalEntries = {
  // 0000_identity_audit
  identityAudit: { oldCreatedAt: 1788100000000, createdAt: 1787800000000, hash: "88366b9f1b71cec39fea4384be15a38a114ad1c76f856e57f2d20fc36a3b1d53" },
  // 0001_allow_unattributed_audit_events
  allowUnattributedAuditEvents: { oldCreatedAt: 1788100010000, createdAt: 1787800010000, hash: "b4db65f38f4932c6a0b66a4dc06bedcf42c4a563ee6454bd8ac9c6b838d2d521" },
} as const;

async function normalizeLegacyMigrationLedger(database: Database): Promise<void> {
  const result = await database.execute(sql`select to_regclass('drizzle.__drizzle_migrations') as migration_table`);
  const [migrationTable] = result as unknown as Array<{ migration_table: string | null }>;
  if (!migrationTable?.migration_table) return;

  // 已发布 journal 曾给 0000/0001 写入错误的未来时间；仅按其 tag 对应的 hash
  // 与时间戳成对修正 ledger 行，使已升级数据库能继续由 Drizzle 按时间顺序迁移。
  const { identityAudit, allowUnattributedAuditEvents } = legacyJournalEntries;
  await database.execute(sql`
    update drizzle.__drizzle_migrations
    set created_at = case
      when created_at = ${identityAudit.oldCreatedAt} and hash = ${identityAudit.hash} then ${identityAudit.createdAt}::bigint
      when created_at = ${allowUnattributedAuditEvents.oldCreatedAt} and hash = ${allowUnattributedAuditEvents.hash} then ${allowUnattributedAuditEvents.createdAt}::bigint
    end
    where (created_at = ${identityAudit.oldCreatedAt} and hash = ${identityAudit.hash})
      or (created_at = ${allowUnattributedAuditEvents.oldCreatedAt} and hash = ${allowUnattributedAuditEvents.hash})
  `);
}

export async function migrateDatabase(database: Database): Promise<void> {
  await normalizeLegacyMigrationLedger(database);
  await migrate(database, { migrationsFolder });
}
