import { sql } from "drizzle-orm";

type TransactionExecutor = { execute(query: ReturnType<typeof sql.raw>): Promise<unknown> };

/** 在同一 PostgreSQL 事务内绑定一个绝对 deadline，防止多条语句累计超时。 */
export async function applyTransactionDeadline(
  transaction: TransactionExecutor,
  input: { clock: () => Date; deadline: Date },
): Promise<void> {
  const transactionTimeout = Math.max(1, Math.floor(input.deadline.getTime() - input.clock().getTime()));
  // 锁和单语句先于 PostgreSQL 17 的终止式 transaction_timeout 失败，使调用方得到可报告的 SQL 错误。
  const queryTimeout = Math.max(1, transactionTimeout - 10);
  await transaction.execute(sql.raw(`set local transaction_timeout = ${transactionTimeout}`));
  await transaction.execute(sql.raw(`set local statement_timeout = ${queryTimeout}`));
  await transaction.execute(sql.raw(`set local lock_timeout = ${queryTimeout}`));
}
