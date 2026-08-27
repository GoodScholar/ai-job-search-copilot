import { sql } from "drizzle-orm";

/** 同一求职账户的画像和导入写入必须在一个事务序列中观察。 */
export async function acquireAccountAdvisoryLock(
  transaction: { execute(query: ReturnType<typeof sql>): Promise<unknown> },
  userId: string,
): Promise<void> {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
}
