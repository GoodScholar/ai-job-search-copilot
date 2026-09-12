import { eq } from "drizzle-orm";
import { accountRunPolicies, type Database } from "@job-copilot/database";

export type AccountRunAdmissionControl = {
  stoppedAt: Date | null;
  controlVersion: number;
  scheduleResumeAfter: Date | null;
};

export function accountRunAdmissionReason(
  control: AccountRunAdmissionControl,
  scheduledFor?: Date,
): "ACCOUNT_RUN_STOPPED" | "ACCOUNT_RUN_SCHEDULE_SKIPPED" | null {
  if (control.stoppedAt !== null) return "ACCOUNT_RUN_STOPPED";
  if (scheduledFor && control.scheduleResumeAfter && scheduledFor <= control.scheduleResumeAfter) return "ACCOUNT_RUN_SCHEDULE_SKIPPED";
  return null;
}

export class AccountRunAdmissionError extends Error {
  constructor(public readonly code: "ACCOUNT_RUN_STOPPED" | "ACCOUNT_RUN_SCHEDULE_SKIPPED") { super(code); }
}

export async function readAccountRunControlInTransaction(tx: Pick<Database, "select">, userId: string): Promise<AccountRunAdmissionControl> {
  const [row] = await tx.select({ stoppedAt: accountRunPolicies.stoppedAt, controlVersion: accountRunPolicies.controlVersion, scheduleResumeAfter: accountRunPolicies.scheduleResumeAfter })
    .from(accountRunPolicies).where(eq(accountRunPolicies.userId, userId));
  return row ?? { stoppedAt: null, controlVersion: 0, scheduleResumeAfter: null };
}
