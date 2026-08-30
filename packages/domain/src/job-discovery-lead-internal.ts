import { jobDiscoveryAttributions, jobDiscoveryLeads } from "@job-copilot/database";
import { AnySearchLeadSchema, DiscoveryAttributionSchema } from "@job-copilot/contracts/job-discovery";
import { z } from "zod";

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

export function parseLeadInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new JobDiscoveryLeadError("JOB_DISCOVERY_LEAD_INVALID_INPUT");
  return parsed.data;
}

export function leadFact(row: typeof jobDiscoveryLeads.$inferSelect) {
  return AnySearchLeadSchema.parse({
    leadId: row.id, ownerId: row.userId, runId: row.runId, targetId: row.targetId, provider: row.provider,
    normalizedUrl: row.normalizedUrl, stableFingerprint: row.stableFingerprint, queryId: row.queryId,
    queryKind: row.queryKind, queryFingerprint: row.queryFingerprint, expiresAt: row.expiresAt.toISOString(),
    state: row.state, sourcePostingVersionId: row.sourcePostingVersionId, rejectionCode: row.rejectionCode,
  });
}

export function attributionFact(row: typeof jobDiscoveryAttributions.$inferSelect) {
  return DiscoveryAttributionSchema.parse({
    attributionId: row.id, ownerId: row.userId, runId: row.runId, leadId: row.leadId, queryId: row.queryId,
    provider: row.provider, sourcePostingVersionId: row.sourcePostingVersionId,
  });
}
