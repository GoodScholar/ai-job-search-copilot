import type { createAccountRunPolicies } from "@job-copilot/domain/account-run-policies";
export const ACCOUNT_RUN_POLICIES = Symbol("ACCOUNT_RUN_POLICIES");
export type AccountRunPolicies = ReturnType<typeof createAccountRunPolicies>;
