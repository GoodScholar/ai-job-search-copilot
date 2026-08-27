import { and, count, eq } from "drizzle-orm";
import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import { candidateFacts, jobAccounts, type Database } from "@job-copilot/database";

export class DomainError extends Error {
  constructor(public readonly code: "ACCOUNT_NOT_FOUND") {
    super(code);
  }
}

export type GetWorkbenchHome = (input: { userId: string }) => Promise<WorkbenchHome>;

export function createWorkbenchHome(input: { db: Database }): GetWorkbenchHome {
  return async ({ userId }) => {
    const [account] = await input.db.select({ userId: jobAccounts.id })
      .from(jobAccounts)
      .where(and(eq(jobAccounts.id, userId), eq(jobAccounts.status, "active")));

    if (!account) {
      throw new DomainError("ACCOUNT_NOT_FOUND");
    }

    const [facts] = await input.db.select({ count: count() }).from(candidateFacts).where(and(
      eq(candidateFacts.userId, userId),
      eq(candidateFacts.confirmationStatus, "pending"),
    ));
    const pendingFacts = Number(facts?.count ?? 0);
    if (!Number.isSafeInteger(pendingFacts)) {
      throw new Error("待确认候选事实计数超出安全范围");
    }

    return {
      account,
      summary: { recommendations: 0, pendingFacts, runningAgentRuns: 0, applications: 0 },
    };
  };
}
