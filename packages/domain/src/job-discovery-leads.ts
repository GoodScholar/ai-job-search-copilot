import { and, eq, gt, sql } from "drizzle-orm";
import { agentRuns, jobDiscoveryAttributions, jobDiscoveryLeads, type Database } from "@job-copilot/database";
import { PublicJobDiscoveryQueryKindSchema, SafeNormalizedPublicJobUrlSchema } from "@job-copilot/contracts/job-discovery";
import { z } from "zod";
import { attributionFact, JobDiscoveryLeadError, leadFact, parseLeadInput } from "./job-discovery-lead-internal";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export { JobDiscoveryLeadError } from "./job-discovery-lead-internal";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);

const RecordPendingInputSchema = z.object({
  userId: z.uuid(),
  runId: z.uuid(),
  targetId: z.uuid(),
  queryId: z.uuid(),
  queryKind: PublicJobDiscoveryQueryKindSchema,
  queryFingerprint: fingerprint,
  normalizedUrl: SafeNormalizedPublicJobUrlSchema,
  stableFingerprint: fingerprint,
  now: z.date(),
}).strict();
const RecordPendingForClaimInputSchema = RecordPendingInputSchema.extend({ claimToken: z.uuid() }).strict();
const GetLeadInputSchema = z.object({ userId: z.uuid(), leadId: z.uuid(), now: z.date() }).strict();
const GetAttributionInputSchema = z.object({ userId: z.uuid(), leadId: z.uuid() }).strict();

function expiresInThirtyDays(now: Date): Date {
  return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
}

function databaseConstraint(error: unknown) {
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : null;
  if (!cause || typeof cause !== "object") return null;
  const value = cause as { code?: unknown; constraint_name?: unknown };
  return typeof value.code === "string" && typeof value.constraint_name === "string"
    ? { code: value.code, name: value.constraint_name }
    : null;
}

function recordPendingDatabaseError(error: unknown) {
  const constraint = databaseConstraint(error);
  if (constraint?.code === "23503" && constraint.name === "job_discovery_leads_owner_run_target_fk") {
    return new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_RUN_NOT_FOUND");
  }
  if (constraint?.code === "23505" && ["job_discovery_leads_pkey", "job_discovery_leads_user_id_id_unique"].includes(constraint.name)) {
    return new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_ID_CONFLICT");
  }
  return null;
}

function matchesRecordPendingFacts(row: typeof jobDiscoveryLeads.$inferSelect, input: z.infer<typeof RecordPendingInputSchema>) {
  return row.targetId === input.targetId
    && row.queryId === input.queryId
    && row.queryKind === input.queryKind
    && row.queryFingerprint === input.queryFingerprint
    && row.normalizedUrl === input.normalizedUrl;
}

function projectLead(row: typeof jobDiscoveryLeads.$inferSelect, now: Date) {
  return { ...leadFact(row), expired: now.getTime() >= row.expiresAt.getTime() };
}

type Dependencies = { db: Database; id: () => string };

export function createJobDiscoveryLeadRepository({ db, id }: Dependencies) {
  async function assertClaim(transaction: Parameters<Parameters<Database["transaction"]>[0]>[0], input: { userId: string; runId: string; claimToken: string }) {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const [run] = await transaction.select({ id: agentRuns.id }).from(agentRuns).where(and(
      eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"), eq(agentRuns.controlState, "none"), eq(agentRuns.claimToken, input.claimToken), gt(agentRuns.claimExpiresAt, sql`current_timestamp`),
    )).limit(1);
    if (!run) throw new JobDiscoveryLeadError("JOB_DISCOVERY_CLAIM_STALE");
  }
  async function loadLead(userId: string, leadId: string) {
    const [lead] = await db.select().from(jobDiscoveryLeads).where(and(
      eq(jobDiscoveryLeads.userId, userId), eq(jobDiscoveryLeads.id, leadId),
    )).limit(1);
    return lead ?? null;
  }

  async function loadAttribution(userId: string, leadId: string) {
    const [attribution] = await db.select().from(jobDiscoveryAttributions).where(and(
      eq(jobDiscoveryAttributions.userId, userId), eq(jobDiscoveryAttributions.leadId, leadId),
    )).limit(1);
    return attribution ?? null;
  }

  async function recordPending(input: unknown, schema: typeof RecordPendingInputSchema | typeof RecordPendingForClaimInputSchema, claimBound: boolean) {
      const value = parseLeadInput(schema, input) as z.infer<typeof RecordPendingForClaimInputSchema>;
      const expiresAt = expiresInThirtyDays(value.now);
      try {
        await db.transaction(async (transaction) => {
          if (claimBound) await assertClaim(transaction, value);
          await transaction.insert(jobDiscoveryLeads).values({
          id: id(), userId: value.userId, runId: value.runId, targetId: value.targetId,
          provider: "anysearch", queryId: value.queryId, queryKind: value.queryKind,
          queryFingerprint: value.queryFingerprint, normalizedUrl: value.normalizedUrl,
          stableFingerprint: value.stableFingerprint, expiresAt, state: "pending",
          sourcePostingVersionId: null, rejectionCode: null, createdAt: value.now, updatedAt: value.now,
          }).onConflictDoNothing({ target: [jobDiscoveryLeads.userId, jobDiscoveryLeads.runId, jobDiscoveryLeads.provider, jobDiscoveryLeads.stableFingerprint] });
        });
      } catch (error) {
        const mapped = recordPendingDatabaseError(error);
        if (mapped) throw mapped;
        throw error;
      }
      const [lead] = await db.select().from(jobDiscoveryLeads).where(and(
        eq(jobDiscoveryLeads.userId, value.userId), eq(jobDiscoveryLeads.runId, value.runId),
        eq(jobDiscoveryLeads.provider, "anysearch"), eq(jobDiscoveryLeads.stableFingerprint, value.stableFingerprint),
      )).limit(1);
      if (!lead) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_STATE_CONFLICT");
      if (!matchesRecordPendingFacts(lead, value)) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_IDENTITY_CONFLICT");
      return leadFact(lead);
  }

  return {
    async recordPending(input: unknown) { return recordPending(input, RecordPendingInputSchema, false); },
    async recordPendingForClaim(input: unknown) { return recordPending(input, RecordPendingForClaimInputSchema, true); },
    async getLead(input: unknown) {
      const value = parseLeadInput(GetLeadInputSchema, input);
      const lead = await loadLead(value.userId, value.leadId);
      return lead ? projectLead(lead, value.now) : null;
    },

    async getAttribution(input: unknown) {
      const value = parseLeadInput(GetAttributionInputSchema, input);
      const attribution = await loadAttribution(value.userId, value.leadId);
      return attribution ? attributionFact(attribution) : null;
    },
  };

}
