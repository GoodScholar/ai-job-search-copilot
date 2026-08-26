import { and, eq } from "drizzle-orm";
import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import { jobAccounts, type Database } from "@job-copilot/database";

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

    return {
      account,
      summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
    };
  };
}
