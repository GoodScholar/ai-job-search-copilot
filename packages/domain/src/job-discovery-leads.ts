import { and, eq, gt } from "drizzle-orm";
import { jobDiscoveryAttributions, jobDiscoveryLeads, type Database } from "@job-copilot/database";
import {
  AnySearchLeadSchema,
  DiscoveryAttributionSchema,
  PublicJobDiscoveryQueryKindSchema,
  SafeNormalizedPublicJobUrlSchema,
} from "@job-copilot/contracts/job-discovery";
import { z } from "zod";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const rejectionCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u);

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
const GetLeadInputSchema = z.object({ userId: z.uuid(), leadId: z.uuid(), now: z.date() }).strict();
const GetAttributionInputSchema = z.object({ userId: z.uuid(), leadId: z.uuid() }).strict();

export class JobDiscoveryLeadError extends Error {
  constructor(public readonly code:
    | "JOB_DISCOVERY_LEAD_INVALID_INPUT"
    | "JOB_DISCOVERY_LEAD_NOT_FOUND"
    | "JOB_DISCOVERY_LEAD_EXPIRED"
    | "JOB_DISCOVERY_LEAD_STATE_CONFLICT"
    | "JOB_DISCOVERY_LEAD_REJECTION_CONFLICT"
    | "JOB_DISCOVERY_LEAD_VERSION_NOT_FOUND"
    | "JOB_DISCOVERY_LEAD_ATTRIBUTION_CONFLICT"
    | "JOB_DISCOVERY_LEAD_IDENTITY_CONFLICT"
    | "JOB_DISCOVERY_LEAD_RUN_NOT_FOUND"
    | "JOB_DISCOVERY_LEAD_ID_CONFLICT") {
    super(code);
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_INVALID_INPUT");
  return parsed.data;
}

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

function leadFact(row: typeof jobDiscoveryLeads.$inferSelect) {
  return AnySearchLeadSchema.parse({
    leadId: row.id,
    ownerId: row.userId,
    runId: row.runId,
    targetId: row.targetId,
    provider: row.provider,
    normalizedUrl: row.normalizedUrl,
    stableFingerprint: row.stableFingerprint,
    queryId: row.queryId,
    queryKind: row.queryKind,
    queryFingerprint: row.queryFingerprint,
    expiresAt: row.expiresAt.toISOString(),
    state: row.state,
    sourcePostingVersionId: row.sourcePostingVersionId,
    rejectionCode: row.rejectionCode,
  });
}

function attributionFact(row: typeof jobDiscoveryAttributions.$inferSelect) {
  return DiscoveryAttributionSchema.parse({
    attributionId: row.id,
    ownerId: row.userId,
    runId: row.runId,
    leadId: row.leadId,
    queryId: row.queryId,
    provider: row.provider,
    sourcePostingVersionId: row.sourcePostingVersionId,
  });
}

function projectLead(row: typeof jobDiscoveryLeads.$inferSelect, now: Date) {
  return { ...leadFact(row), expired: now.getTime() >= row.expiresAt.getTime() };
}

type Dependencies = { db: Database; id: () => string };

export function createJobDiscoveryLeadRepository({ db, id }: Dependencies) {
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

  return {
    async recordPending(input: unknown) {
      const value = parseOrThrow(RecordPendingInputSchema, input);
      const expiresAt = expiresInThirtyDays(value.now);
      try {
        await db.insert(jobDiscoveryLeads).values({
          id: id(), userId: value.userId, runId: value.runId, targetId: value.targetId,
          provider: "anysearch", queryId: value.queryId, queryKind: value.queryKind,
          queryFingerprint: value.queryFingerprint, normalizedUrl: value.normalizedUrl,
          stableFingerprint: value.stableFingerprint, expiresAt, state: "pending",
          sourcePostingVersionId: null, rejectionCode: null, createdAt: value.now, updatedAt: value.now,
        }).onConflictDoNothing({ target: [jobDiscoveryLeads.userId, jobDiscoveryLeads.runId, jobDiscoveryLeads.provider, jobDiscoveryLeads.stableFingerprint] });
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
    },

    async getLead(input: unknown) {
      const value = parseOrThrow(GetLeadInputSchema, input);
      const lead = await loadLead(value.userId, value.leadId);
      return lead ? projectLead(lead, value.now) : null;
    },

    async getAttribution(input: unknown) {
      const value = parseOrThrow(GetAttributionInputSchema, input);
      const attribution = await loadAttribution(value.userId, value.leadId);
      return attribution ? attributionFact(attribution) : null;
    },
  };

}
