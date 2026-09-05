import { and, desc, eq } from "drizzle-orm";
import { accountRunPolicies, accountRunPolicyRevisions, type Database } from "@job-copilot/database";
import { AccountRunPolicyCommandSchema, AccountRunPolicyHistorySchema, AccountRunPolicyResponseSchema, AccountRunPolicyRevisionSchema, effectiveAccountRunPolicy, systemAccountRunPolicy, type AccountRunPolicyResponse, type AccountRunPolicySettings } from "@job-copilot/contracts/account-run-policies";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export class AccountRunPolicyError extends Error { constructor(public readonly code: "ACCOUNT_RUN_POLICY_VERSION_CONFLICT") { super(code); } }
type Dependencies = { db: Database; id: () => string; clock: () => Date };
type PolicyDatabase = Pick<Database, "select" | "insert">;
type StoredRevision = { revisionNumber: number; settings: unknown; createdAt: Date };
function revision(row: StoredRevision) { return AccountRunPolicyRevisionSchema.parse({ revisionNumber: row.revisionNumber, isSystemBaseline: row.revisionNumber === 0, settings: row.settings, createdAt: row.createdAt.toISOString() }); }
async function current(db: PolicyDatabase, userId: string): Promise<StoredRevision | undefined> {
  const [row] = await db.select({ revisionNumber: accountRunPolicies.currentRevisionNumber, settings: accountRunPolicyRevisions.settings, createdAt: accountRunPolicyRevisions.createdAt }).from(accountRunPolicies).innerJoin(accountRunPolicyRevisions, and(eq(accountRunPolicyRevisions.userId, accountRunPolicies.userId), eq(accountRunPolicyRevisions.revisionNumber, accountRunPolicies.currentRevisionNumber))).where(eq(accountRunPolicies.userId, userId));
  return row;
}
async function ensureBaseline(db: PolicyDatabase, userId: string, id: () => string, clock: () => Date): Promise<StoredRevision> {
  const existing = await current(db, userId); if (existing) return existing;
  const now = clock(); const settings = systemAccountRunPolicy().system.defaults;
  await db.insert(accountRunPolicyRevisions).values({ id: id(), userId, revisionNumber: 0, settings, createdAt: now }).onConflictDoNothing();
  await db.insert(accountRunPolicies).values({ userId, currentRevisionNumber: 0, version: 0, updatedAt: now }).onConflictDoNothing();
  const created = await current(db, userId); if (!created) throw new Error("ACCOUNT_RUN_POLICY_ACCOUNT_NOT_FOUND"); return created;
}
function response(row: StoredRevision): AccountRunPolicyResponse { const saved = revision(row); const system = systemAccountRunPolicy().system; return AccountRunPolicyResponseSchema.parse({ revision: saved, system, userSettings: saved.revisionNumber === 0 ? null : saved.settings, effective: effectiveAccountRunPolicy(saved.settings) }); }
export async function resolveEffectiveAccountRunPolicy(db: PolicyDatabase, userId: string, context: { id: () => string; clock: () => Date } = { id: () => crypto.randomUUID(), clock: () => new Date() }): Promise<{ revisionNumber: number; effective: AccountRunPolicySettings }> { const stored = await ensureBaseline(db, userId, context.id, context.clock); const value = response(stored); return { revisionNumber: value.revision.revisionNumber, effective: value.effective }; }
export function createAccountRunPolicies(deps: Dependencies): { get(input: { userId: string }): Promise<AccountRunPolicyResponse>; save(input: { userId: string; command: unknown }): Promise<AccountRunPolicyResponse>; history(input: { userId: string }): Promise<ReturnType<typeof AccountRunPolicyHistorySchema.parse>>; getRevision(input: { userId: string; revisionNumber: number }): Promise<AccountRunPolicyResponse | null>; } {
  const read = async (userId: string, action: (tx: any) => Promise<any>) => deps.db.transaction(async (tx) => { await acquireAccountAdvisoryLock(tx, userId); await ensureBaseline(tx, userId, deps.id, deps.clock); return action(tx); });
  return {
    async get({ userId }) { return read(userId, async (tx) => response((await current(tx, userId))!)); },
    async save(input) { const command = AccountRunPolicyCommandSchema.parse(input.command); return read(input.userId, async (tx) => { const existing = (await current(tx, input.userId))!; if (existing.revisionNumber !== command.expectedVersion) throw new AccountRunPolicyError("ACCOUNT_RUN_POLICY_VERSION_CONFLICT"); const revisionNumber = existing.revisionNumber + 1; const now = deps.clock(); await tx.insert(accountRunPolicyRevisions).values({ id: deps.id(), userId: input.userId, revisionNumber, settings: command.settings, createdAt: now }); await tx.update(accountRunPolicies).set({ currentRevisionNumber: revisionNumber, version: revisionNumber, updatedAt: now }).where(and(eq(accountRunPolicies.userId, input.userId), eq(accountRunPolicies.version, existing.revisionNumber))); return response((await current(tx, input.userId))!); }); },
    async getRevision({ userId, revisionNumber }) { return read(userId, async (tx) => { const [stored] = await tx.select({ revisionNumber: accountRunPolicyRevisions.revisionNumber, settings: accountRunPolicyRevisions.settings, createdAt: accountRunPolicyRevisions.createdAt }).from(accountRunPolicyRevisions).where(and(eq(accountRunPolicyRevisions.userId, userId), eq(accountRunPolicyRevisions.revisionNumber, revisionNumber))); return stored ? response(stored) : null; }); },
    async history({ userId }) { return read(userId, async (tx) => { const revisions = await tx.select({ revisionNumber: accountRunPolicyRevisions.revisionNumber, settings: accountRunPolicyRevisions.settings, createdAt: accountRunPolicyRevisions.createdAt }).from(accountRunPolicyRevisions).where(eq(accountRunPolicyRevisions.userId, userId)).orderBy(desc(accountRunPolicyRevisions.revisionNumber)).limit(100); return AccountRunPolicyHistorySchema.parse({ revisions: revisions.map(revision) }); }); },
  };
}
export type AccountRunPolicyService = ReturnType<typeof createAccountRunPolicies>;
export type EffectiveAccountRunPolicy = { revisionNumber: number; settings: AccountRunPolicySettings };
