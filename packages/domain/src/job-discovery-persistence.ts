import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import {
  agentRunEvents,
  jobDiscoveryRunResults,
  agentRunJobResults,
  agentRunSteps,
  agentRunUsageEntries,
  agentRuns,
  agentInboxItems,
  jobDiscoverySourceIssues,
  jobSourceHealthChecks,
  jobOpportunities,
  jobOpportunitySources,
  jobSourcePostings,
  jobSourcePostingVersions,
  type Database,
} from "@job-copilot/database";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { readAccountRunControlInTransaction } from "./account-run-admission";
import { effectiveAgentRunBudget, type AgentRunBudget } from "./effective-agent-run-budget";
import { agentRunUsageSnapshot, appendBudgetFacts, settleActiveSlice } from "./agent-run-lifecycle";
import { discoveryNormalizedData, persistJobOpportunity } from "./job-opportunity-persistence";
import { deriveSourceHealthTerminal } from "./source-health-terminal";
import type { SourceHealthTerminal } from "./source-health-terminal";
import { GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION, JobSourceHealthCheckSchema, PublicAgentRunSourceScopeSchema, PublicSourceHealthAgentRunSourceScopeSchema, type JobSourceHealthCheck } from "@job-copilot/contracts/agent-runs";
import { LayeredPublicJobDiscoverySourceScopeSchema } from "@job-copilot/contracts/job-discovery";
import { systemAccountRunPolicy } from "@job-copilot/contracts/account-run-policies";
import { SourceCapabilityRejectionReasonCodeSchema } from "@job-copilot/contracts/source-capabilities";
import { SourceExecutionActionSchema, type SourceExecutionAction } from "./source-capabilities";
import { narrowGreenhouseSourceScope } from "./agent-run-source-scope";
import { z } from "zod";

/** Reads the immutable result tuples owned by one completed discovery root. */
export async function readDiscoveryResultCandidatesInTransaction(transaction: any, input: { userId: string; targetId: string; rootRunId: string }) {
  const [root] = await transaction.select({ id: agentRuns.id, workflowVersion: agentRuns.workflowVersion }).from(agentRuns).where(and(
    eq(agentRuns.userId, input.userId), eq(agentRuns.targetId, input.targetId), eq(agentRuns.id, input.rootRunId),
  )).limit(1);
  if (!root) throw new Error("DISCOVERY_ROOT_NOT_FOUND");
  const rows = root.workflowVersion === "layered-public-job-discovery-v1"
    ? await transaction.select({ opportunityId: jobOpportunitySources.opportunityId, sourcePostingVersionId: jobDiscoveryRunResults.sourcePostingVersionId, ordinal: jobDiscoveryRunResults.ordinal })
      .from(jobDiscoveryRunResults).innerJoin(jobOpportunitySources, and(
        eq(jobOpportunitySources.userId, jobDiscoveryRunResults.userId), eq(jobOpportunitySources.sourcePostingVersionId, jobDiscoveryRunResults.sourcePostingVersionId),
      )).where(and(eq(jobDiscoveryRunResults.userId, input.userId), eq(jobDiscoveryRunResults.runId, root.id)))
      .orderBy(asc(jobDiscoveryRunResults.ordinal), asc(jobDiscoveryRunResults.sourcePostingVersionId), asc(jobOpportunitySources.opportunityId))
    : await transaction.select({ opportunityId: agentRunJobResults.opportunityId, sourcePostingVersionId: agentRunJobResults.sourcePostingVersionId, ordinal: agentRunJobResults.ordinal })
      .from(agentRunJobResults).where(and(eq(agentRunJobResults.userId, input.userId), eq(agentRunJobResults.runId, root.id)))
      .orderBy(asc(agentRunJobResults.ordinal), asc(agentRunJobResults.sourcePostingVersionId), asc(agentRunJobResults.opportunityId));
  const seen = new Set<string>();
  return rows.flatMap((row: { opportunityId: string; sourcePostingVersionId: string }) => {
    if (seen.has(row.opportunityId)) return [];
    seen.add(row.opportunityId);
    return [{ opportunityId: row.opportunityId, sourcePostingVersionId: row.sourcePostingVersionId }];
  });
}

const PersistedCapabilityIssueSchema = z.object({
  provider: z.literal("greenhouse"),
  code: SourceCapabilityRejectionReasonCodeSchema,
  sourceId: z.string().trim().min(1).max(256),
  action: SourceExecutionActionSchema,
  affectedCount: z.literal(1),
}).strict();
const currentTrustedSourceLimit = systemAccountRunPolicy().system.hardLimits.discovery.trustedSourceLimit;

export type DiscoveryDetail = {
  sourceId: string;
  detailId: string;
  company: string | null;
  title: string | null;
  location: string | null;
  postedAt: string | null;
  deadline: string | null;
  sourceType: string;
  isOfficial: boolean;
  rawPayload: Record<string, unknown>;
};

export type StoredDiscoveryObject = {
  sourceId: string;
  detailId: string;
  objectKey: string;
  rawContentSha256: string;
};

export type ClaimedAgentRun = typeof agentRuns.$inferSelect & { claimToken: string };
type Availability = "open" | "closed" | "expired";

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item)]));
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

export function discoverySourceIdentifier(sourceId: string, detailId: string): string {
  return sha256({ sourceId, detailId });
}

function contentSha256(detail: DiscoveryDetail): string {
  return sha256({
    sourceId: detail.sourceId, detailId: detail.detailId, company: detail.company, title: detail.title,
    location: detail.location, postedAt: detail.postedAt, deadline: detail.deadline,
    sourceType: detail.sourceType, isOfficial: detail.isOfficial,
  });
}

function detailAvailability(detail: DiscoveryDetail, now: Date): Availability {
  return detail.deadline && new Date(detail.deadline).getTime() <= now.getTime() ? "expired" : "open";
}

async function appendEvent(db: any, input: { id: () => string; userId: string; runId: string; version: number; eventType: string; data: Record<string, unknown>; now: Date }) {
  const [latest] = await db.select({ sequence: agentRunEvents.sequence }).from(agentRunEvents)
    .where(and(eq(agentRunEvents.userId, input.userId), eq(agentRunEvents.runId, input.runId)))
    .orderBy(desc(agentRunEvents.sequence)).limit(1);
  const sequence = (latest?.sequence ?? 0) + 1;
  await db.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: input.runId, sequence, runVersion: input.version, eventType: input.eventType, data: input.data, createdAt: input.now });
  return sequence;
}

async function latestSourceVersion(db: any, userId: string, sourcePostingId: string) {
  const [latest] = await db.select().from(jobSourcePostingVersions).where(and(
    eq(jobSourcePostingVersions.userId, userId), eq(jobSourcePostingVersions.sourcePostingId, sourcePostingId),
  )).orderBy(desc(jobSourcePostingVersions.version)).limit(1);
  return latest;
}

async function existingOpportunityForPosting(db: any, input: { userId: string; sourcePostingId: string }) {
  const [evidence] = await db.select({ opportunityId: jobOpportunitySources.opportunityId }).from(jobOpportunitySources)
    .innerJoin(jobSourcePostingVersions, and(
      eq(jobSourcePostingVersions.userId, jobOpportunitySources.userId),
      eq(jobSourcePostingVersions.id, jobOpportunitySources.sourcePostingVersionId),
    ))
    .where(and(eq(jobOpportunitySources.userId, input.userId), eq(jobSourcePostingVersions.sourcePostingId, input.sourcePostingId)))
    .orderBy(desc(jobOpportunitySources.createdAt), desc(jobOpportunitySources.id)).limit(1);
  return evidence?.opportunityId;
}

async function persistDiscoverySource(db: any, input: { id: () => string; userId: string; detail: DiscoveryDetail; stored: StoredDiscoveryObject; now: Date }) {
  const sourceIdentifier = discoverySourceIdentifier(input.detail.sourceId, input.detail.detailId);
  let [posting] = await db.select().from(jobSourcePostings).where(and(
    eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.sourceType, input.detail.sourceType), eq(jobSourcePostings.sourceIdentifier, sourceIdentifier),
  ));
  const availability = detailAvailability(input.detail, input.now);
  if (!posting) {
    const [created] = await db.insert(jobSourcePostings).values({
      id: input.id(), userId: input.userId, sourceType: input.detail.sourceType, sourceIdentifier,
      sourceId: input.detail.sourceId, sourceIdentity: { sourceId: input.detail.sourceId, detailId: input.detail.detailId },
      applicationDeadline: input.detail.deadline ? new Date(input.detail.deadline) : null, isOfficial: input.detail.isOfficial,
      availability, availabilityUpdatedAt: input.now, createdAt: input.now, updatedAt: input.now,
    }).returning();
    if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
    posting = created;
  } else if (
    posting.availability !== availability
    || (input.detail.isOfficial && !posting.isOfficial)
    || posting.sourceId !== input.detail.sourceId
    || posting.applicationDeadline?.getTime() !== (input.detail.deadline ? new Date(input.detail.deadline).getTime() : undefined)
  ) {
    const [updated] = await db.update(jobSourcePostings).set({
      availability, availabilityUpdatedAt: posting.availability === availability ? posting.availabilityUpdatedAt : input.now,
      sourceId: input.detail.sourceId, applicationDeadline: input.detail.deadline ? new Date(input.detail.deadline) : null,
      isOfficial: posting.isOfficial || input.detail.isOfficial, updatedAt: input.now,
    }).where(and(eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.id, posting.id))).returning();
    if (!updated) throw new Error("AGENT_RUN_PERSIST_FAILED");
    posting = updated;
  }

  const latest = await latestSourceVersion(db, input.userId, posting.id);
  const normalizedHash = contentSha256(input.detail);
  const unchanged = latest
    && latest.contentSha256 === normalizedHash
    && latest.rawContentSha256 === input.stored.rawContentSha256
    && latest.availability === availability;
  if (unchanged) return { sourcePostingId: posting.id, sourcePostingVersionId: latest.id, isOfficial: posting.isOfficial, sourceVersionCreated: false };
  const [created] = await db.insert(jobSourcePostingVersions).values({
    id: input.id(), userId: input.userId, sourcePostingId: posting.id, version: (latest?.version ?? 0) + 1,
    contentSha256: normalizedHash, rawContentSha256: input.stored.rawContentSha256,
      rawObjectReference: { objectKey: input.stored.objectKey }, normalizedData: discoveryNormalizedData(input.detail), retrievedAt: input.now, availability, createdAt: input.now,
  }).returning();
  if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
  return { sourcePostingId: posting.id, sourcePostingVersionId: created.id, isOfficial: posting.isOfficial, sourceVersionCreated: true };
}

async function closeMissingSourcePostings(db: any, input: { id: () => string; userId: string; sourceType: string; scan: { sourceId: string; observedDetailIds: string[]; complete: boolean }; now: Date }): Promise<string[]> {
  if (!input.scan.complete) return [] as string[];
  const postings = await db.select().from(jobSourcePostings).where(and(
    eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.sourceType, input.sourceType), eq(jobSourcePostings.sourceId, input.scan.sourceId),
  ));
  const observed = new Set(input.scan.observedDetailIds);
  const candidates: Array<{ posting: typeof jobSourcePostings.$inferSelect; availability: Availability }> = [];
  for (const posting of postings) {
    const identity = posting.sourceIdentity as { detailId?: string };
    if (!identity.detailId || posting.availability === "closed") continue;
    const availability: Availability | null = observed.has(identity.detailId)
      ? (posting.availability === "open" && posting.applicationDeadline && posting.applicationDeadline.getTime() <= input.now.getTime() ? "expired" : null)
      : "closed";
    if (availability) candidates.push({ posting, availability });
  }
  if (candidates.length === 0) return [] as string[];
  const postingIds = candidates.map((candidate) => candidate.posting.id);
  const versions = await db.execute(sql`
    select distinct on (source_posting_id)
      id, source_posting_id as "sourcePostingId", version,
      content_sha256 as "contentSha256", raw_content_sha256 as "rawContentSha256",
      raw_object_reference as "rawObjectReference", normalized_data as "normalizedData"
    from job_source_posting_versions
    where user_id = ${input.userId}::uuid and source_posting_id in (
      select value::uuid from jsonb_array_elements_text(${JSON.stringify(postingIds)}::jsonb)
    )
    order by source_posting_id, version desc
  `) as Array<{ id: string; sourcePostingId: string; version: number; contentSha256: string; rawContentSha256: string; rawObjectReference: Record<string, unknown>; normalizedData: Record<string, unknown> }>;
  const latestByPosting = new Map(versions.map((version) => [version.sourcePostingId, version]));
  const inserts = candidates.flatMap(({ posting, availability }) => {
    const latest = latestByPosting.get(posting.id);
    return latest ? [{ id: input.id(), userId: input.userId, sourcePostingId: posting.id, version: latest.version + 1, contentSha256: latest.contentSha256, rawContentSha256: latest.rawContentSha256, rawObjectReference: latest.rawObjectReference, normalizedData: latest.normalizedData, retrievedAt: input.now, availability, createdAt: input.now }] : [];
  });
  if (inserts.length !== candidates.length) throw new Error("AGENT_RUN_PERSIST_FAILED");
  const createdVersions = await db.execute(sql`
    insert into job_source_posting_versions (
      id, user_id, source_posting_id, version, content_sha256, raw_content_sha256,
      raw_object_reference, normalized_data, retrieved_at, availability, created_at
    )
    select r.id::uuid, ${input.userId}::uuid, r.source_posting_id::uuid, r.version,
      r.content_sha256, r.raw_content_sha256, r.raw_object_reference, r.normalized_data,
      r.retrieved_at::timestamptz, r.availability::varchar, r.created_at::timestamptz
    from jsonb_to_recordset(${JSON.stringify(inserts.map((item) => ({
      id: item.id, source_posting_id: item.sourcePostingId, version: item.version,
      content_sha256: item.contentSha256, raw_content_sha256: item.rawContentSha256,
      raw_object_reference: item.rawObjectReference, normalized_data: item.normalizedData, retrieved_at: item.retrievedAt.toISOString(),
      availability: item.availability, created_at: item.createdAt.toISOString(),
    }))) }::jsonb) as r(
      id text, source_posting_id text, version integer, content_sha256 text,
      raw_content_sha256 text, raw_object_reference jsonb, normalized_data jsonb, retrieved_at text,
      availability text, created_at text
    )
    returning id, source_posting_id as "sourcePostingId"
  `) as Array<{ id: string; sourcePostingId: string }>;
  await db.execute(sql`
    update job_source_postings as posting
    set availability = updates.availability::varchar,
      availability_updated_at = ${input.now.toISOString()}::timestamptz,
      updated_at = ${input.now.toISOString()}::timestamptz
    from jsonb_to_recordset(${JSON.stringify(candidates.map(({ posting, availability }) => ({ id: posting.id, availability })))}::jsonb)
      as updates(id text, availability text)
    where posting.user_id = ${input.userId}::uuid and posting.id = updates.id::uuid
  `);
  const rows = await db.execute(sql`
    select evidence.opportunity_id as "opportunityId", version.source_posting_id as "sourcePostingId"
    from job_opportunity_sources as evidence
    join job_source_posting_versions as version
      on version.user_id = evidence.user_id and version.id = evidence.source_posting_version_id
    where evidence.user_id = ${input.userId}::uuid
      and version.source_posting_id in (
        select value::uuid from jsonb_array_elements_text(${JSON.stringify(postingIds)}::jsonb)
      )
  `) as Array<{ opportunityId: string; sourcePostingId: string }>;
  const lifecycleVersionByPosting = new Map(createdVersions.map((version) => [version.sourcePostingId, version.id]));
  const lifecycleEvidence = rows.flatMap((row) => {
    const sourcePostingVersionId = lifecycleVersionByPosting.get(row.sourcePostingId);
    return sourcePostingVersionId ? [{ id: input.id(), userId: input.userId, opportunityId: row.opportunityId, sourcePostingVersionId, createdAt: input.now }] : [];
  });
  if (lifecycleEvidence.length > 0) await db.execute(sql`
    insert into job_opportunity_sources (id, user_id, opportunity_id, source_posting_version_id, created_at)
    select r.id::uuid, ${input.userId}::uuid, r.opportunity_id::uuid,
      r.source_posting_version_id::uuid, r.created_at::timestamptz
    from jsonb_to_recordset(${JSON.stringify(lifecycleEvidence.map((item) => ({
      id: item.id, opportunity_id: item.opportunityId,
      source_posting_version_id: item.sourcePostingVersionId, created_at: item.createdAt.toISOString(),
    }))) }::jsonb) as r(id text, opportunity_id text, source_posting_version_id text, created_at text)
    on conflict do nothing
  `);
  const impacted = new Set(rows.map((row) => row.opportunityId));
  return [...impacted];
}

async function recomputeOpportunityAvailability(db: any, input: { userId: string; opportunityIds: Iterable<string>; now: Date }) {
  const opportunityIds = [...new Set(input.opportunityIds)];
  if (opportunityIds.length === 0) return new Set<string>();
  const updated = await db.execute(sql`
    with target as (
      select value::uuid as id
      from jsonb_array_elements_text(${JSON.stringify(opportunityIds)}::jsonb)
    ), linked_sources as (
      select distinct evidence.opportunity_id, posting.id as source_posting_id, posting.is_official
      from target
      join job_opportunity_sources as evidence on evidence.opportunity_id = target.id and evidence.user_id = ${input.userId}::uuid
      join job_source_posting_versions as evidence_version on evidence_version.id = evidence.source_posting_version_id and evidence_version.user_id = evidence.user_id
      join job_source_postings as posting on posting.id = evidence_version.source_posting_id and posting.user_id = evidence.user_id
    ), latest as (
      select distinct on (version.source_posting_id) version.source_posting_id, version.id, version.availability, version.created_at
      from job_source_posting_versions as version
      join (select distinct source_posting_id from linked_sources) as source on source.source_posting_id = version.source_posting_id
      where version.user_id = ${input.userId}::uuid
      order by version.source_posting_id, version.version desc
    ), updates as (
      select linked_sources.opportunity_id as id,
        case when bool_or(latest.availability = 'open') then 'open'
          when bool_or(latest.availability = 'expired') then 'expired' else 'closed' end as availability,
        (array_agg(latest.id order by latest.created_at desc, latest.id desc) filter (where linked_sources.is_official and latest.availability = 'open'))[1] as current_evidence_id
      from linked_sources join latest on latest.source_posting_id = linked_sources.source_posting_id
      group by linked_sources.opportunity_id
    )
    update job_opportunities as opportunity
    set availability = updates.availability::varchar,
      availability_updated_at = case when opportunity.availability is distinct from updates.availability
        then ${input.now.toISOString()}::timestamptz else opportunity.availability_updated_at end,
      source_posting_version_id = coalesce(updates.current_evidence_id, opportunity.source_posting_version_id),
      updated_at = ${input.now.toISOString()}::timestamptz
    from updates
    where opportunity.user_id = ${input.userId}::uuid and opportunity.id = updates.id
    returning opportunity.id, opportunity.availability
  `) as Array<{ id: string; availability: Availability }>;
  return new Set(updated.filter((opportunity) => opportunity.availability === "open").map((opportunity) => opportunity.id));
}

export function createJobDiscoveryPersistence(deps: { db: Database; id: () => string; auditTrail: AuditTrail }) {
  return {
    /** v4 trusted wrapper only: claim-bound source/version/opportunity persistence, never run lifecycle or result facts. */
    async persistTrustedLayeredDiscovery(input: {
      userId: string;
      runId: string;
      claimToken: string;
      sourceId: string;
      details: DiscoveryDetail[];
      storedObjects: StoredDiscoveryObject[];
      now: Date;
    }): Promise<{ sourcePostingVersionIds: string[]; cleanupObjectKeys: string[] }> {
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        if ((await readAccountRunControlInTransaction(transaction, input.userId)).stoppedAt !== null) {
          const error = Object.assign(new Error("JOB_DISCOVERY_CLAIM_STALE"), { code: "JOB_DISCOVERY_CLAIM_STALE" });
          throw error;
        }
        const [run] = await transaction.select().from(agentRuns).where(and(
          eq(agentRuns.userId, input.userId), eq(agentRuns.id, input.runId), eq(agentRuns.status, "running"),
          eq(agentRuns.controlState, "none"), eq(agentRuns.claimToken, input.claimToken), gt(agentRuns.claimExpiresAt, sql`current_timestamp`),
        )).limit(1);
        if (!run) {
          const error = Object.assign(new Error("JOB_DISCOVERY_CLAIM_STALE"), { code: "JOB_DISCOVERY_CLAIM_STALE" });
          throw error;
        }
        if (run.workflowVersion !== "layered-public-job-discovery-v1") throw new Error("AGENT_RUN_PERSIST_FAILED");
        const sourceScope = LayeredPublicJobDiscoverySourceScopeSchema.parse(run.sourceScope);
        if (!sourceScope.trustedSources.some(({ source }) => source.sourceId === input.sourceId)
          || input.details.some((detail) => detail.sourceId !== input.sourceId || detail.sourceType !== "company_careers" || !detail.isOfficial)) {
          throw new Error("AGENT_RUN_PERSIST_FAILED");
        }
        const storedByDetail = new Map(input.storedObjects.map((stored) => [`${stored.sourceId}:${stored.detailId}`, stored]));
        if (storedByDetail.size !== input.details.length || input.details.some((detail) => !storedByDetail.has(`${detail.sourceId}:${detail.detailId}`))) {
          throw new Error("AGENT_RUN_PERSIST_FAILED");
        }
        const sourcePostingVersionIds: string[] = [];
        const cleanupObjectKeys: string[] = [];
        for (const detail of input.details) {
          const stored = storedByDetail.get(`${detail.sourceId}:${detail.detailId}`)!;
          const source = await persistDiscoverySource(transaction, { id: deps.id, userId: input.userId, detail, stored, now: input.now });
          if (!source.sourceVersionCreated) cleanupObjectKeys.push(stored.objectKey);
          const existingOpportunityId = await existingOpportunityForPosting(transaction, { userId: input.userId, sourcePostingId: source.sourcePostingId });
          await persistJobOpportunity(transaction, {
            id: deps.id, userId: input.userId, importId: null, sourcePostingVersionId: source.sourcePostingVersionId,
            existingOpportunityId, isOfficial: source.isOfficial, company: detail.company, title: detail.title,
            location: detail.location, postedAt: detail.postedAt, deadline: detail.deadline, description: null,
            normalizedData: discoveryNormalizedData(detail), now: input.now,
          });
          sourcePostingVersionIds.push(source.sourcePostingVersionId);
        }
        return { sourcePostingVersionIds: [...new Set(sourcePostingVersionIds)], cleanupObjectKeys };
      });
    },
    async persistSuccessfulDiscovery(input: {
      run: ClaimedAgentRun;
      details: DiscoveryDetail[];
      scans: Array<{ sourceId: string; observedDetailIds: string[]; complete: boolean }>;
      storedObjects: StoredDiscoveryObject[];
      sourceChecks?: JobSourceHealthCheck[];
      sourceIssues?: Array<{ provider: "greenhouse"; code: "SOURCE_CAPABILITY_UNSUPPORTED" | "SOURCE_CAPABILITY_DECLARATION_MISMATCH"; sourceId: string; action: SourceExecutionAction; affectedCount: 1 }>;
      terminal?: SourceHealthTerminal;
      now: Date;
      /** Processor-only seam: caller has already started the bounded account transaction. */
      transaction?: any;
      /** Runs in the same PostgreSQL transaction, after successful discovery becomes terminal. */
      afterCompleted?: (input: { transaction: any; userId: string; targetId: string; discoveryRunId: string }) => Promise<void>;
    }): Promise<{ resultCount: number; cleanupObjectKeys: string[]; completed: boolean }> {
      const objectBySource = new Map(input.storedObjects.map((item) => [`${item.sourceId}:${item.detailId}`, item]));
      const persist = async (transaction: any) => {
        await acquireAccountAdvisoryLock(transaction, input.run.userId);
        if ((await readAccountRunControlInTransaction(transaction, input.run.userId)).stoppedAt !== null) return { resultCount: 0, cleanupObjectKeys: input.storedObjects.map((item) => item.objectKey), completed: false };
        const [run] = await transaction.select().from(agentRuns).where(and(
          eq(agentRuns.userId, input.run.userId), eq(agentRuns.id, input.run.id), eq(agentRuns.status, "running"),
          eq(agentRuns.claimToken, input.run.claimToken), eq(agentRuns.controlState, "none"),
        ));
        if (!run || !run.claimToken) return { resultCount: 0, cleanupObjectKeys: input.storedObjects.map((item) => item.objectKey), completed: false };
        if (run.adapter === "greenhouse") {
          // The persistence seam independently protects lifecycle facts from
          // malformed adapter output; upstream schema parsing is not authority.
          if (input.scans.length === 0 && (input.sourceIssues?.length ?? 0) === 0) throw new Error("AGENT_RUN_PERSIST_FAILED");
          const sourceIds = new Set<string>();
          const observed = new Map<string, Set<string>>();
          for (const scan of input.scans) {
            if (sourceIds.has(scan.sourceId) || new Set(scan.observedDetailIds).size !== scan.observedDetailIds.length) throw new Error("AGENT_RUN_PERSIST_FAILED");
            sourceIds.add(scan.sourceId);
            observed.set(scan.sourceId, new Set(scan.observedDetailIds));
          }
          if (run.workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION || run.workflowVersion === "job-discovery-workflow-v2") {
            const frozenSources = (run.workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION
              ? PublicSourceHealthAgentRunSourceScopeSchema.parse(narrowGreenhouseSourceScope(run.sourceScope, currentTrustedSourceLimit))
              : PublicAgentRunSourceScopeSchema.parse(narrowGreenhouseSourceScope(run.sourceScope, currentTrustedSourceLimit))).sources;
            const frozenSourceIds = new Set(frozenSources.map((source) => source.sourceId));
            if ([...sourceIds].some((sourceId) => !frozenSourceIds.has(sourceId))
              || (sourceIds.size !== frozenSourceIds.size && (input.sourceIssues?.length ?? 0) === 0)) {
              throw new Error("AGENT_RUN_PERSIST_FAILED");
            }
          }
          if (input.details.some((detail) => !observed.get(detail.sourceId)?.has(detail.detailId))) throw new Error("AGENT_RUN_PERSIST_FAILED");
        }
        const sourceChecks = input.sourceChecks?.map((inputCheck) => {
          const check = JobSourceHealthCheckSchema.parse(inputCheck);
          return { ...check, reasonCodes: [...check.reasonCodes].sort() };
        }) ?? [];
        if (sourceChecks.some((check) => check.runId !== run.id || check.targetId !== run.targetId) || new Set(sourceChecks.map((check) => check.sourceId)).size !== sourceChecks.length) throw new Error("AGENT_RUN_PERSIST_FAILED");
        if (run.workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION) {
          const frozenSources = PublicSourceHealthAgentRunSourceScopeSchema.parse(narrowGreenhouseSourceScope(run.sourceScope, currentTrustedSourceLimit)).sources;
          const sourceById = new Map(frozenSources.map((source) => [source.sourceId, source.watchlistItemId]));
          let validIssues: Array<z.infer<typeof PersistedCapabilityIssueSchema>>;
          try { validIssues = (input.sourceIssues ?? []).map((issue) => PersistedCapabilityIssueSchema.parse(issue)); }
          catch { throw new Error("AGENT_RUN_PERSIST_FAILED"); }
          const denied = new Map(validIssues.map((issue) => [issue.sourceId, issue]));
          if (denied.size !== validIssues.length
            || validIssues.some((issue) => !sourceById.has(issue.sourceId))
            || sourceChecks.some((check) => sourceById.get(check.sourceId) !== check.watchlistItemId || denied.has(check.sourceId))
            || sourceChecks.length + denied.size !== sourceById.size) {
            throw new Error("AGENT_RUN_PERSIST_FAILED");
          }
          const scansBySource = new Map(input.scans.map((scan) => [scan.sourceId, scan]));
          if (scansBySource.size !== sourceChecks.length || [...scansBySource.keys()].some((sourceId) => !sourceChecks.some((check) => check.sourceId === sourceId)) || sourceChecks.some((check) => {
            const scan = scansBySource.get(check.sourceId);
            const completed = check.status === "healthy" || check.status === "zero_valid_results";
            return !scan || check.observedPostingCount !== scan.observedDetailIds.length || scan.complete !== completed;
          })) throw new Error("AGENT_RUN_PERSIST_FAILED");
        } else if (sourceChecks.length > 0) {
          throw new Error("AGENT_RUN_PERSIST_FAILED");
        }
        const terminal = run.workflowVersion === GREENHOUSE_SOURCE_HEALTH_WORKFLOW_VERSION
          ? (() => {
              const derivedBase = deriveSourceHealthTerminal(sourceChecks);
              const derived = input.sourceIssues?.length && derivedBase !== "source_failed" ? "completed_with_source_issues" : derivedBase;
              if (input.terminal !== undefined && input.terminal !== derived) throw new Error("AGENT_RUN_PERSIST_FAILED");
              return derived;
          })()
          : input.terminal ?? "completed";
        const persistedCheckIds = new Map<string, string>();
        if (sourceChecks.length > 0) {
          const inserted = await transaction.insert(jobSourceHealthChecks).values(sourceChecks.map((check) => ({
          id: check.checkId, userId: run.userId, runId: check.runId, targetId: check.targetId, watchlistItemId: check.watchlistItemId,
          sourceId: check.sourceId, status: check.status, reasonCodes: check.reasonCodes, impactScope: check.impact.scope,
          impactAffectedCount: check.impact.affectedCount, observedPostingCount: check.observedPostingCount,
          selectedDetailCount: check.selectedDetailCount, validDetailCount: check.validDetailCount,
          requestAttemptCount: check.requestAttemptCount, checkedAt: new Date(check.checkedAt),
          }))).onConflictDoNothing().returning({ sourceId: jobSourceHealthChecks.sourceId, id: jobSourceHealthChecks.id });
          inserted.forEach((item: { sourceId: string; id: string }) => persistedCheckIds.set(item.sourceId, item.id));
          const insertedSourceIds = new Set<string>(persistedCheckIds.keys());
          for (const check of sourceChecks.filter((item) => !insertedSourceIds.has(item.sourceId))) {
            const [existing] = await transaction.select().from(jobSourceHealthChecks).where(and(
              eq(jobSourceHealthChecks.userId, run.userId), eq(jobSourceHealthChecks.runId, check.runId), eq(jobSourceHealthChecks.sourceId, check.sourceId),
            ));
            const same = existing
              && existing.targetId === check.targetId
              && existing.watchlistItemId === check.watchlistItemId
              && existing.status === check.status
              && JSON.stringify(stableJson(existing.reasonCodes)) === JSON.stringify(check.reasonCodes)
              && existing.impactScope === check.impact.scope
              && existing.impactAffectedCount === check.impact.affectedCount
              && existing.observedPostingCount === check.observedPostingCount
              && existing.selectedDetailCount === check.selectedDetailCount
              && existing.validDetailCount === check.validDetailCount
              && existing.requestAttemptCount === check.requestAttemptCount
              && existing.checkedAt.toISOString() === new Date(check.checkedAt).toISOString();
            if (!same) throw new Error("AGENT_RUN_PERSIST_FAILED");
            persistedCheckIds.set(check.sourceId, existing.id);
          }
          for (const check of sourceChecks) {
            if (!persistedCheckIds.has(check.sourceId)) throw new Error("AGENT_RUN_PERSIST_FAILED");
          }
        }
        const sourceIssues = new Map<string, { provider: "greenhouse"; code: "SOURCE_CAPABILITY_UNSUPPORTED" | "SOURCE_CAPABILITY_DECLARATION_MISMATCH"; affectedCount: number }>();
        for (const issue of input.sourceIssues ?? []) {
          const key = `${issue.provider}:${issue.code}`;
          const existing = sourceIssues.get(key);
          sourceIssues.set(key, { provider: issue.provider, code: issue.code, affectedCount: Math.min(10, (existing?.affectedCount ?? 0) + issue.affectedCount) });
        }
        for (const issue of sourceIssues.values()) await transaction.insert(jobDiscoverySourceIssues).values({ id: deps.id(), userId: run.userId, runId: run.id, provider: issue.provider, code: issue.code, affectedCount: issue.affectedCount, createdAt: input.now }).onConflictDoUpdate({
          target: [jobDiscoverySourceIssues.userId, jobDiscoverySourceIssues.runId, jobDiscoverySourceIssues.provider, jobDiscoverySourceIssues.code],
          set: { affectedCount: sql`greatest(${jobDiscoverySourceIssues.affectedCount}, excluded.affected_count)` },
        });
        const cleanupObjectKeys: string[] = [];
        const opportunityIds = new Set<string>();
        const resultRows: Array<{ opportunityId: string; sourcePostingVersionId: string }> = [];
        for (const detail of input.details) {
          const stored = objectBySource.get(`${detail.sourceId}:${detail.detailId}`);
          if (!stored) throw new Error("AGENT_RUN_PERSIST_FAILED");
          const source = await persistDiscoverySource(transaction, { id: deps.id, userId: run.userId, detail, stored, now: input.now });
          if (!source.sourceVersionCreated) cleanupObjectKeys.push(stored.objectKey);
          const existingOpportunityId = await existingOpportunityForPosting(transaction, { userId: run.userId, sourcePostingId: source.sourcePostingId });
          const evidence = await persistJobOpportunity(transaction, {
            id: deps.id, userId: run.userId, importId: null, sourcePostingVersionId: source.sourcePostingVersionId,
            existingOpportunityId, isOfficial: source.isOfficial, company: detail.company, title: detail.title,
            location: detail.location, postedAt: detail.postedAt, deadline: detail.deadline, description: null,
            normalizedData: discoveryNormalizedData(detail), now: input.now,
          });
          opportunityIds.add(evidence.opportunityId);
          if (detailAvailability(detail, input.now) === "open") resultRows.push({ opportunityId: evidence.opportunityId, sourcePostingVersionId: source.sourcePostingVersionId });
        }
        // Scan records carry no source type. The immutable, claimed execution
        // spec is the only authority for translating a public adapter to it.
        const sourceType = run.adapter === "greenhouse" ? "company_careers" : undefined;
        if (sourceType) for (const scan of input.scans) (await closeMissingSourcePostings(transaction, { id: deps.id, userId: run.userId, sourceType, scan, now: input.now })).forEach((opportunityId) => opportunityIds.add(opportunityId));
        const openOpportunityIds = await recomputeOpportunityAvailability(transaction, { userId: run.userId, opportunityIds, now: input.now });
        let resultCount = 0;
        const existingResults = await transaction.select({ ordinal: agentRunJobResults.ordinal }).from(agentRunJobResults)
          .where(and(eq(agentRunJobResults.userId, run.userId), eq(agentRunJobResults.runId, run.id)))
          .orderBy(desc(agentRunJobResults.ordinal));
        const maxResults = effectiveAgentRunBudget(run.workflowVersion, run.budgetSnapshot as AgentRunBudget).maxResults;
        let nextOrdinal = (existingResults[0]?.ordinal ?? 0) + 1;
        let remainingResults = Math.max(0, maxResults - existingResults.length);
        for (const result of resultRows) {
          // reconciliation can close an item selected earlier in this batch; only
          // the final, transaction-visible availability may produce a result.
          if (!openOpportunityIds.has(result.opportunityId) || remainingResults === 0) continue;
          const inserted = await transaction.insert(agentRunJobResults).values({ id: deps.id(), userId: run.userId, runId: run.id, opportunityId: result.opportunityId, sourcePostingVersionId: result.sourcePostingVersionId, ordinal: nextOrdinal, createdAt: input.now }).onConflictDoNothing().returning({ id: agentRunJobResults.id });
          if (!inserted[0]) continue;
          resultCount += 1;
          remainingResults -= 1;
          nextOrdinal += 1;
          await transaction.insert(agentRunUsageEntries).values({ id: deps.id(), userId: run.userId, runId: run.id, usageKey: `${run.claimToken}:result:${result.sourcePostingVersionId}`, category: "result", amount: 1, stepKey: "persist_results", attemptCount: run.attemptCount, createdAt: input.now }).onConflictDoNothing();
        }
        const elapsed = await settleActiveSlice(transaction, { id: deps.id, userId: run.userId, run, now: input.now });
        const activeDurationMs = run.activeDurationMs + elapsed;
        const budgetChanged = elapsed > 0 || resultCount > 0;
        const budgetVersion = budgetChanged ? run.version + 1 : run.version;
        if (budgetChanged) {
          const usage = agentRunUsageSnapshot(run, { activeDurationMs, resultCount: existingResults.length + resultCount });
          await transaction.update(agentRuns).set({ activeDurationMs, resultCount: existingResults.length + resultCount, version: budgetVersion, updatedAt: input.now }).where(and(eq(agentRuns.userId, run.userId), eq(agentRuns.id, run.id), eq(agentRuns.claimToken, run.claimToken)));
          await appendBudgetFacts(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: run.userId, requestId: run.id, runId: run.id, version: budgetVersion, currentStep: "persist_results", usage, consumed: { activeDurationMs: elapsed, toolCalls: 0, sourceRequests: 0, modelCalls: 0 }, now: input.now });
        }
        const stepVersion = budgetVersion + 1;
        await transaction.update(agentRunSteps).set({ status: "completed", completedAt: input.now }).where(and(eq(agentRunSteps.userId, run.userId), eq(agentRunSteps.runId, run.id), eq(agentRunSteps.stepKey, "persist_results")));
        await transaction.update(agentRuns).set({ currentStep: "persist_results", version: stepVersion, updatedAt: input.now }).where(and(eq(agentRuns.userId, run.userId), eq(agentRuns.id, run.id), eq(agentRuns.claimToken, run.claimToken), eq(agentRuns.controlState, "none")));
        await appendEvent(transaction, { id: deps.id, userId: run.userId, runId: run.id, version: stepVersion, eventType: "step.completed", data: { eventType: "step.completed", status: "running", currentStep: "persist_results", stepKey: "persist_results", attemptCount: run.attemptCount }, now: input.now });
        if (terminal !== "source_failed" && run.runPurpose === "recommendation") await input.afterCompleted?.({ transaction, userId: run.userId, targetId: run.targetId, discoveryRunId: run.id });
        const terminalVersion = stepVersion + 1;
        const failed = terminal === "source_failed";
        await transaction.update(agentRuns).set({ status: failed ? "failed" : "completed", currentStep: failed ? "failed" : "completed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, activeDurationMs, ...(failed ? { failedAt: input.now, failureCode: "AGENT_RUN_ADAPTER_FAILED", terminationKind: "source_failed" } : { completedAt: input.now, failureCode: null, terminationKind: terminal }), terminationBudgetDimension: null, resultCount: existingResults.length + resultCount, version: terminalVersion, updatedAt: input.now }).where(and(eq(agentRuns.userId, run.userId), eq(agentRuns.id, run.id), eq(agentRuns.claimToken, run.claimToken), eq(agentRuns.controlState, "none")));
        const terminalSequence = await appendEvent(transaction, {
          id: deps.id, userId: run.userId, runId: run.id, version: terminalVersion,
          eventType: failed ? "run.failed" : "run.completed",
          data: failed
            ? { eventType: "run.failed", status: "failed", currentStep: "failed", attemptCount: run.attemptCount, failureCode: "AGENT_RUN_ADAPTER_FAILED" }
            : { eventType: "run.completed", status: "completed", currentStep: "completed", attemptCount: run.attemptCount, resultCount: existingResults.length + resultCount },
          now: input.now,
        });
        if (failed) await deps.auditTrail.bind(transaction).append({ userId: run.userId, actorUserId: run.userId, eventType: "agent.run_failed", occurredAt: input.now, requestId: run.id, outcome: "failure", reasonCode: "AGENT_RUN_ADAPTER_FAILED", resourceType: "agent_run", resourceId: run.id, metadata: { runId: run.id, targetId: run.targetId, attemptCount: run.attemptCount, failureCode: "AGENT_RUN_ADAPTER_FAILED" } });
        else await deps.auditTrail.bind(transaction).append({ userId: run.userId, actorUserId: run.userId, eventType: "agent.run_completed", occurredAt: input.now, requestId: run.id, outcome: "success", reasonCode: "AGENT_RUN_COMPLETED", resourceType: "agent_run", resourceId: run.id, metadata: { runId: run.id, targetId: run.targetId, attemptCount: run.attemptCount, resultCount: existingResults.length + resultCount } });
        for (const check of sourceChecks.filter((item) => item.status === "parser_degraded" || item.status === "rate_limited" || item.status === "hard_failed")) {
          const [item] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: run.userId, runId: run.id, triggerEventSequence: null, watchlistItemId: check.watchlistItemId, sourceHealthCheckId: persistedCheckIds.get(check.sourceId)!, kind: "source_attention", status: "unread", reasonCode: "SOURCE_HEALTH_ATTENTION", budgetDimension: null, createdAt: input.now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
          if (item) await deps.auditTrail.bind(transaction).append({ userId: run.userId, actorUserId: run.userId, eventType: "agent.inbox_opened", occurredAt: input.now, requestId: run.id, outcome: "success", reasonCode: "SOURCE_HEALTH_ATTENTION", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: run.id, kind: "source_attention", reasonCode: "SOURCE_HEALTH_ATTENTION", budgetDimension: null } });
        }
        if ((input.sourceIssues?.length ?? 0) > 0) {
          const [existing] = await transaction.select({ id: agentInboxItems.id }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, run.userId), eq(agentInboxItems.runId, run.id), eq(agentInboxItems.kind, "discovery_attention"))).limit(1);
          if (!existing) {
            const [item] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: run.userId, runId: run.id, triggerEventSequence: terminalSequence, kind: "discovery_attention", status: "unread", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null, createdAt: input.now }).returning({ id: agentInboxItems.id });
            if (item) await deps.auditTrail.bind(transaction).append({ userId: run.userId, actorUserId: run.userId, eventType: "agent.inbox_opened", occurredAt: input.now, requestId: run.id, outcome: "success", reasonCode: "DISCOVERY_ATTENTION", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: run.id, kind: "discovery_attention", reasonCode: "DISCOVERY_ATTENTION", budgetDimension: null } });
          }
        }
        if (failed) {
          const [item] = await transaction.insert(agentInboxItems).values({ id: deps.id(), userId: run.userId, runId: run.id, triggerEventSequence: terminalSequence, kind: "run_failed", status: "unread", reasonCode: "AGENT_RUN_ADAPTER_FAILED", budgetDimension: null, createdAt: input.now }).onConflictDoNothing().returning({ id: agentInboxItems.id });
          if (item) await deps.auditTrail.bind(transaction).append({ userId: run.userId, actorUserId: run.userId, eventType: "agent.inbox_opened", occurredAt: input.now, requestId: run.id, outcome: "success", reasonCode: "AGENT_RUN_ADAPTER_FAILED", resourceType: "agent_inbox_item", resourceId: item.id, metadata: { runId: run.id, kind: "run_failed", reasonCode: "AGENT_RUN_ADAPTER_FAILED", budgetDimension: null } });
        }
        if (!failed && run.runPurpose !== "recommendation") await input.afterCompleted?.({ transaction, userId: run.userId, targetId: run.targetId, discoveryRunId: run.id });
        return { resultCount, cleanupObjectKeys, completed: true };
      };
      return input.transaction
        ? persist(input.transaction)
        : deps.db.transaction(persist) as Promise<{ resultCount: number; cleanupObjectKeys: string[]; completed: boolean }>;
    },
  };
}
