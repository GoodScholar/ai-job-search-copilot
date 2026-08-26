import { and, eq } from "drizzle-orm";
import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import { jobAccounts, type Database } from "@job-copilot/database";

export class DomainError extends Error {
  constructor(public readonly code: "ACCOUNT_NOT_FOUND") {
    super(code);
  }
}

export async function getWorkbenchHome(input: {
  db: Database;
  userId: string;
}): Promise<WorkbenchHome> {
  const [account] = await input.db.select({ userId: jobAccounts.id })
    .from(jobAccounts)
    .where(and(eq(jobAccounts.id, input.userId), eq(jobAccounts.status, "active")));

  if (!account) {
    throw new DomainError("ACCOUNT_NOT_FOUND");
  }

  return {
    account,
    summary: { recommendations: 0, pendingFacts: 0, runningAgentRuns: 0, applications: 0 },
  };
}
