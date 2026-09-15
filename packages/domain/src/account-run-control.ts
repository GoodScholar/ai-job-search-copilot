import { and, eq, inArray } from "drizzle-orm";
import { accountRunControlCommands, accountRunPolicies, agentRuns, jobDiscoveryScheduleOccurrences, jobDiscoverySchedules, type Database } from "@job-copilot/database";
import { AccountRunControlCommandSchema, AccountRunControlResponseSchema, AccountRunControlStateSchema, type AccountRunControlCommand, type AccountRunControlResponse, type AccountRunControlState } from "@job-copilot/contracts/account-run-policies";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { AuditTrail } from "./audit-trail";
import { ensureAccountRunPolicyBaselineInTransaction } from "./account-run-policies";
import { applyAgentRunControlInTransaction } from "./agent-run-control";
export { accountRunAdmissionReason, AccountRunAdmissionError, readAccountRunControlInTransaction } from "./account-run-admission";
import { readAccountRunControlInTransaction, type AccountRunAdmissionControl } from "./account-run-admission";

export class AccountRunControlError extends Error { constructor(public readonly code: "ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT" | "ACCOUNT_RUN_CONTROL_VERSION_CONFLICT") { super(code); } }
export type AccountRunControlRow = AccountRunAdmissionControl;
type Dependencies = { db: Database; auditTrail: AuditTrail; id: () => string; clock: () => Date };
function state(row: AccountRunControlRow): AccountRunControlState { return AccountRunControlStateSchema.parse({ stoppedAt: row.stoppedAt?.toISOString() ?? null, controlVersion: row.controlVersion, scheduleResumeAfter: row.scheduleResumeAfter?.toISOString() ?? null }); }
export function createAccountRunControl(deps: Dependencies): { get(input: { userId: string }): Promise<AccountRunControlState>; control(input: { userId: string; requestId: string; command: AccountRunControlCommand }): Promise<AccountRunControlResponse>; } {
  return {
    async get({ userId }) { return state(await readAccountRunControlInTransaction(deps.db, userId)); },
    async control(input) {
      const command = AccountRunControlCommandSchema.parse(input.command);
      try {
        return await deps.db.transaction(async (tx) => {
        await acquireAccountAdvisoryLock(tx, input.userId);
        const [prior] = await tx.select().from(accountRunControlCommands).where(and(eq(accountRunControlCommands.userId, input.userId), eq(accountRunControlCommands.commandId, command.commandId)));
        if (prior) {
          if (prior.action !== command.action || prior.expectedVersion !== command.expectedVersion) throw new AccountRunControlError("ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT");
          return AccountRunControlResponseSchema.parse(prior.resultSnapshot);
        }
        await ensureAccountRunPolicyBaselineInTransaction(tx, { userId: input.userId, id: deps.id, clock: deps.clock });
        const current = await readAccountRunControlInTransaction(tx, input.userId);
        if (current.controlVersion !== command.expectedVersion) throw new AccountRunControlError("ACCOUNT_RUN_CONTROL_VERSION_CONFLICT");
        const now = deps.clock(); const applies = command.action === "stop" ? current.stoppedAt === null : current.stoppedAt !== null;
        const next: AccountRunControlRow = applies ? command.action === "stop" ? { ...current, stoppedAt: now, controlVersion: current.controlVersion + 1 } : { stoppedAt: null, controlVersion: current.controlVersion + 1, scheduleResumeAfter: current.scheduleResumeAfter && current.scheduleResumeAfter > now ? current.scheduleResumeAfter : now } : current;
        const response = AccountRunControlResponseSchema.parse({ applied: applies, state: state(next) });
        if (applies) {
          await tx.update(accountRunPolicies).set({ stoppedAt: next.stoppedAt, controlVersion: next.controlVersion, scheduleResumeAfter: next.scheduleResumeAfter, updatedAt: now }).where(eq(accountRunPolicies.userId, input.userId));
          if (command.action === "stop") {
            const runs = await tx.select({ id: agentRuns.id, controlState: agentRuns.controlState }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), inArray(agentRuns.status, ["queued", "running"])));
            for (const run of runs) if (run.controlState !== "cancel_requested") await applyAgentRunControlInTransaction(tx, { userId: input.userId, requestId: input.requestId, runId: run.id, command: { commandId: command.commandId, action: "cancel" } }, deps);
            await tx.update(jobDiscoverySchedules).set({ state: "disabled", nextRunAt: null, updatedAt: now }).where(and(eq(jobDiscoverySchedules.userId, input.userId), eq(jobDiscoverySchedules.state, "enabled")));
            await tx.update(jobDiscoveryScheduleOccurrences).set({ status: "skipped", runId: null, skipReason: "ACCOUNT_RUN_STOPPED" }).where(and(eq(jobDiscoveryScheduleOccurrences.userId, input.userId), eq(jobDiscoveryScheduleOccurrences.status, "pending")));
          }
          const audit = deps.auditTrail.bind(tx);
          if (command.action === "stop") await audit.append({ userId: input.userId, actorUserId: input.userId, eventType: "account.run_stopped", occurredAt: now, requestId: input.requestId, outcome: "success", reasonCode: "ACCOUNT_RUN_STOPPED", resourceType: "account_run_control", resourceId: input.userId, metadata: { commandId: command.commandId, controlVersion: next.controlVersion, action: "stop" } });
          else await audit.append({ userId: input.userId, actorUserId: input.userId, eventType: "account.run_stop_released", occurredAt: now, requestId: input.requestId, outcome: "success", reasonCode: "ACCOUNT_RUN_STOP_RELEASED", resourceType: "account_run_control", resourceId: input.userId, metadata: { commandId: command.commandId, controlVersion: next.controlVersion, action: "release" } });
        }
        await tx.insert(accountRunControlCommands).values({ userId: input.userId, commandId: command.commandId, action: command.action, expectedVersion: command.expectedVersion, applied: response.applied, resultSnapshot: response, createdAt: now });
          return response;
        });
      } catch (error) {
        if (error instanceof AccountRunControlError) {
          try {
            await deps.auditTrail.append({ userId: input.userId, actorUserId: input.userId, eventType: "account.run_control_rejected", occurredAt: deps.clock(), requestId: input.requestId, outcome: "failure", reasonCode: error.code, resourceType: "account_run_control", resourceId: input.userId, metadata: { commandId: command.commandId, action: command.action, expectedVersion: command.expectedVersion } });
          } catch { /* 基础数据库不可用时无法在同一持久化边界记录拒绝审计。 */ }
        }
        throw error;
      }
    },
  };
}
