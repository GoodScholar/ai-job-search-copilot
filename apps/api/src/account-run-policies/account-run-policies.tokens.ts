import type { createAccountRunPolicies } from "@job-copilot/domain/account-run-policies";
import type { createAccountRunControl } from "@job-copilot/domain/account-run-control";
export const ACCOUNT_RUN_POLICIES = Symbol("ACCOUNT_RUN_POLICIES");
export type AccountRunPolicies = ReturnType<typeof createAccountRunPolicies>;
export const ACCOUNT_RUN_CONTROL = Symbol("ACCOUNT_RUN_CONTROL");
export type AccountRunControl = ReturnType<typeof createAccountRunControl>;
