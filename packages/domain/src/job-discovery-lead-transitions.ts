import { and, eq, gt } from "drizzle-orm";
import { jobDiscoveryAttributions, jobDiscoveryLeads, jobSourcePostingVersions, type Database } from "@job-copilot/database";
import { z } from "zod";
import { attributionFact, JobDiscoveryLeadError, leadFact, parseLeadInput } from "./job-discovery-lead-internal";

const rejectionCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u);
const RejectInputSchema = z.object({ userId: z.uuid(), leadId: z.uuid(), rejectionCode, now: z.date() }).strict();
const VerifyInputSchema = z.object({ userId: z.uuid(), leadId: z.uuid(), sourcePostingVersionId: z.uuid(), now: z.date() }).strict();
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function attributionInsertError(error: unknown): JobDiscoveryLeadError | null {
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : null;
  if (cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505"
    && (cause as { constraint_name?: unknown }).constraint_name === "job_discovery_attributions_pkey") {
    return new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_ATTRIBUTION_CONFLICT");
  }
  return null;
}

export function createJobDiscoveryLeadTransitions({ db, id }: { db: Database; id: () => string }) {
  async function transitionVerify(transaction: Transaction, input: z.infer<typeof VerifyInputSchema>) {
    const [version] = await transaction.select({ id: jobSourcePostingVersions.id }).from(jobSourcePostingVersions).where(and(
      eq(jobSourcePostingVersions.userId, input.userId), eq(jobSourcePostingVersions.id, input.sourcePostingVersionId),
    )).limit(1);
    if (!version) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_VERSION_NOT_FOUND");
    const [updated] = await transaction.update(jobDiscoveryLeads).set({
      state: "verified", sourcePostingVersionId: input.sourcePostingVersionId, updatedAt: input.now,
    }).where(and(
      eq(jobDiscoveryLeads.userId, input.userId), eq(jobDiscoveryLeads.id, input.leadId),
      eq(jobDiscoveryLeads.state, "pending"), gt(jobDiscoveryLeads.expiresAt, input.now),
    )).returning();
    const lead = updated ?? (await transaction.select().from(jobDiscoveryLeads).where(and(
      eq(jobDiscoveryLeads.userId, input.userId), eq(jobDiscoveryLeads.id, input.leadId),
    )).limit(1))[0];
    if (!lead) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_NOT_FOUND");
    if (input.now.getTime() >= lead.expiresAt.getTime() && lead.state === "pending") throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_EXPIRED");
    if (lead.state === "rejected" || lead.state === "pending") throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_STATE_CONFLICT");
    if (lead.sourcePostingVersionId !== input.sourcePostingVersionId) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_ATTRIBUTION_CONFLICT");
    try {
      await transaction.insert(jobDiscoveryAttributions).values({
        id: id(), userId: input.userId, runId: lead.runId, leadId: lead.id, queryId: lead.queryId,
        provider: "anysearch", sourcePostingVersionId: input.sourcePostingVersionId, createdAt: input.now,
      }).onConflictDoNothing({ target: jobDiscoveryAttributions.leadId });
    } catch (error) {
      const mapped = attributionInsertError(error);
      if (mapped) throw mapped;
      throw error;
    }
    const [attribution] = await transaction.select().from(jobDiscoveryAttributions).where(and(
      eq(jobDiscoveryAttributions.userId, input.userId), eq(jobDiscoveryAttributions.leadId, input.leadId),
    )).limit(1);
    if (!attribution || attribution.runId !== lead.runId || attribution.queryId !== lead.queryId
      || attribution.provider !== lead.provider || attribution.sourcePostingVersionId !== lead.sourcePostingVersionId) {
      throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_ATTRIBUTION_CONFLICT");
    }
    return { lead: leadFact(lead), attribution: attributionFact(attribution) };
  }

  return {
    async verifyAndAttribute(input: unknown) {
      const value = parseLeadInput(VerifyInputSchema, input);
      return db.transaction((transaction) => transitionVerify(transaction, value));
    },
    async reject(input: unknown) {
      const value = parseLeadInput(RejectInputSchema, input);
      const [updated] = await db.update(jobDiscoveryLeads).set({ state: "rejected", rejectionCode: value.rejectionCode, updatedAt: value.now }).where(and(
        eq(jobDiscoveryLeads.userId, value.userId), eq(jobDiscoveryLeads.id, value.leadId), eq(jobDiscoveryLeads.state, "pending"), gt(jobDiscoveryLeads.expiresAt, value.now),
      )).returning();
      if (updated) return leadFact(updated);
      const [lead] = await db.select().from(jobDiscoveryLeads).where(and(eq(jobDiscoveryLeads.userId, value.userId), eq(jobDiscoveryLeads.id, value.leadId))).limit(1);
      if (!lead) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_NOT_FOUND");
      if (lead.state === "rejected") {
        if (lead.rejectionCode === value.rejectionCode) return leadFact(lead);
        throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_REJECTION_CONFLICT");
      }
      if (value.now.getTime() >= lead.expiresAt.getTime()) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_EXPIRED");
      throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_STATE_CONFLICT");
    },
    async verifyAndAttributeInTransaction(input: unknown, transaction: Transaction) {
      return transitionVerify(transaction, parseLeadInput(VerifyInputSchema, input));
    },
  };
}
