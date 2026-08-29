import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  agentRunEvents,
  agentRunJobResults,
  agentRunSteps,
  agentRunUsageEntries,
  agentRuns,
  jobOpportunities,
  jobOpportunitySources,
  jobSourcePostings,
  jobSourcePostingVersions,
  type Database,
} from "@job-copilot/database";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { agentRunUsageSnapshot, appendBudgetFacts, settleActiveSlice } from "./agent-run-lifecycle";
import { discoveryNormalizedData, persistJobOpportunity } from "./job-opportunity-persistence";

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
  await db.insert(agentRunEvents).values({ id: input.id(), userId: input.userId, runId: input.runId, sequence: (latest?.sequence ?? 0) + 1, runVersion: input.version, eventType: input.eventType, data: input.data, createdAt: input.now });
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
    .orderBy(desc(jobOpportunitySources.createdAt)).limit(1);
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
    rawObjectReference: { objectKey: input.stored.objectKey }, retrievedAt: input.now, availability, createdAt: input.now,
  }).returning();
  if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
  return { sourcePostingId: posting.id, sourcePostingVersionId: created.id, isOfficial: posting.isOfficial, sourceVersionCreated: true };
}

async function closeMissingSourcePostings(db: any, input: { id: () => string; userId: string; sourceType: string; scan: { sourceId: string; observedDetailIds: string[]; complete: boolean }; now: Date }) {
  if (!input.scan.complete) return [] as string[];
  const postings = await db.select().from(jobSourcePostings).where(and(
    eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.sourceType, input.sourceType), eq(jobSourcePostings.sourceId, input.scan.sourceId),
  ));
  const observed = new Set(input.scan.observedDetailIds);
  const impacted = new Set<string>();
  for (const posting of postings) {
    const identity = posting.sourceIdentity as { detailId?: string };
    if (!identity.detailId || posting.availability === "closed") continue;
    const availability: Availability | null = observed.has(identity.detailId)
      ? (posting.availability === "open" && posting.applicationDeadline && posting.applicationDeadline.getTime() <= input.now.getTime() ? "expired" : null)
      : "closed";
    if (!availability) continue;
    const latest = await latestSourceVersion(db, input.userId, posting.id);
    if (!latest) continue;
    const [closed] = await db.insert(jobSourcePostingVersions).values({
      id: input.id(), userId: input.userId, sourcePostingId: posting.id, version: latest.version + 1,
      contentSha256: latest.contentSha256, rawContentSha256: latest.rawContentSha256,
      rawObjectReference: latest.rawObjectReference, retrievedAt: input.now, availability, createdAt: input.now,
    }).returning();
    if (!closed) throw new Error("AGENT_RUN_PERSIST_FAILED");
    await db.update(jobSourcePostings).set({ availability, availabilityUpdatedAt: input.now, updatedAt: input.now })
      .where(and(eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.id, posting.id)));
    const rows = await db.select({ opportunityId: jobOpportunitySources.opportunityId }).from(jobOpportunitySources)
      .innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, jobOpportunitySources.userId), eq(jobSourcePostingVersions.id, jobOpportunitySources.sourcePostingVersionId)))
      .where(and(eq(jobOpportunitySources.userId, input.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id)));
    rows.forEach((row: { opportunityId: string }) => impacted.add(row.opportunityId));
  }
  return [...impacted];
}

async function recomputeOpportunityAvailability(db: any, input: { userId: string; opportunityIds: Iterable<string>; now: Date }) {
  for (const opportunityId of new Set(input.opportunityIds)) {
    const sources = await db.select({ sourcePostingId: jobSourcePostingVersions.sourcePostingId }).from(jobOpportunitySources)
      .innerJoin(jobSourcePostingVersions, and(eq(jobSourcePostingVersions.userId, jobOpportunitySources.userId), eq(jobSourcePostingVersions.id, jobOpportunitySources.sourcePostingVersionId)))
      .where(and(eq(jobOpportunitySources.userId, input.userId), eq(jobOpportunitySources.opportunityId, opportunityId)));
    const sourcePostingIds = new Set<string>((sources as Array<{ sourcePostingId: string }>).map((source) => source.sourcePostingId));
    const latest = await Promise.all([...sourcePostingIds].map((sourcePostingId) => latestSourceVersion(db, input.userId, sourcePostingId)));
    const current = latest.filter(Boolean) as Array<typeof jobSourcePostingVersions.$inferSelect>;
    const availability: Availability = current.some((version) => version.availability === "open") ? "open"
      : current.some((version) => version.availability === "expired") ? "expired" : "closed";
    const officialOpen = await Promise.all(current.filter((version) => version.availability === "open").map(async (version) => {
      const [posting] = await db.select({ isOfficial: jobSourcePostings.isOfficial }).from(jobSourcePostings).where(and(eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.id, version.sourcePostingId)));
      return posting?.isOfficial ? version : undefined;
    }));
    const evidence = officialOpen.filter(Boolean).sort((left, right) => right!.createdAt.getTime() - left!.createdAt.getTime())[0];
    const [opportunity] = await db.select().from(jobOpportunities).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, opportunityId)));
    if (!opportunity) continue;
    await db.update(jobOpportunities).set({
      availability,
      availabilityUpdatedAt: opportunity.availability === availability ? opportunity.availabilityUpdatedAt : input.now,
      sourcePostingVersionId: evidence?.id ?? opportunity.sourcePostingVersionId,
      updatedAt: input.now,
    }).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, opportunityId)));
  }
}

export function createJobDiscoveryPersistence(deps: { db: Database; id: () => string; auditTrail: AuditTrail }) {
  return {
    async persistSuccessfulDiscovery(input: {
      run: ClaimedAgentRun;
      details: DiscoveryDetail[];
      scans: Array<{ sourceId: string; observedDetailIds: string[]; complete: boolean }>;
      storedObjects: StoredDiscoveryObject[];
      now: Date;
      /** Processor-only seam: caller has already started the bounded account transaction. */
      transaction?: any;
    }): Promise<{ resultCount: number; cleanupObjectKeys: string[]; completed: boolean }> {
      const objectBySource = new Map(input.storedObjects.map((item) => [`${item.sourceId}:${item.detailId}`, item]));
      const persist = async (transaction: any) => {
        await acquireAccountAdvisoryLock(transaction, input.run.userId);
        const [run] = await transaction.select().from(agentRuns).where(and(
          eq(agentRuns.userId, input.run.userId), eq(agentRuns.id, input.run.id), eq(agentRuns.status, "running"),
          eq(agentRuns.claimToken, input.run.claimToken), eq(agentRuns.controlState, "none"),
        ));
        if (!run || !run.claimToken) return { resultCount: 0, cleanupObjectKeys: input.storedObjects.map((item) => item.objectKey), completed: false };
        if (input.scans.length > 0) {
          const observed = new Map(input.scans.map((scan) => [scan.sourceId, new Set(scan.observedDetailIds)]));
          if (input.details.some((detail) => !observed.get(detail.sourceId)?.has(detail.detailId))) throw new Error("AGENT_RUN_PERSIST_FAILED");
        }
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
        await recomputeOpportunityAvailability(transaction, { userId: run.userId, opportunityIds, now: input.now });
        let resultCount = 0;
        for (const result of resultRows) {
          // reconciliation can close an item selected earlier in this batch; only
          // the final, transaction-visible opportunity state may produce a result.
          const [opportunity] = await transaction.select({ availability: jobOpportunities.availability }).from(jobOpportunities)
            .where(and(eq(jobOpportunities.userId, run.userId), eq(jobOpportunities.id, result.opportunityId)));
          if (opportunity?.availability !== "open") continue;
          const inserted = await transaction.insert(agentRunJobResults).values({ id: deps.id(), userId: run.userId, runId: run.id, opportunityId: result.opportunityId, sourcePostingVersionId: result.sourcePostingVersionId, ordinal: resultCount + 1, createdAt: input.now }).onConflictDoNothing().returning({ id: agentRunJobResults.id });
          if (!inserted[0]) continue;
          resultCount += 1;
          await transaction.insert(agentRunUsageEntries).values({ id: deps.id(), userId: run.userId, runId: run.id, usageKey: `${run.claimToken}:result:${result.sourcePostingVersionId}`, category: "result", amount: 1, stepKey: "persist_results", attemptCount: run.attemptCount, createdAt: input.now }).onConflictDoNothing();
        }
        const elapsed = await settleActiveSlice(transaction, { id: deps.id, userId: run.userId, run, now: input.now });
        const activeDurationMs = run.activeDurationMs + elapsed;
        const budgetChanged = elapsed > 0 || resultCount > 0;
        const budgetVersion = budgetChanged ? run.version + 1 : run.version;
        if (budgetChanged) {
          const usage = agentRunUsageSnapshot(run, { activeDurationMs, resultCount: run.resultCount + resultCount });
          await transaction.update(agentRuns).set({ activeDurationMs, resultCount: run.resultCount + resultCount, version: budgetVersion, updatedAt: input.now }).where(and(eq(agentRuns.userId, run.userId), eq(agentRuns.id, run.id), eq(agentRuns.claimToken, run.claimToken)));
          await appendBudgetFacts(transaction, { id: deps.id, auditTrail: deps.auditTrail, userId: run.userId, requestId: run.id, runId: run.id, version: budgetVersion, currentStep: "persist_results", usage, consumed: { activeDurationMs: elapsed, toolCalls: 0, sourceRequests: 0, modelCalls: 0 }, now: input.now });
        }
        const stepVersion = budgetVersion + 1;
        await transaction.update(agentRunSteps).set({ status: "completed", completedAt: input.now }).where(and(eq(agentRunSteps.userId, run.userId), eq(agentRunSteps.runId, run.id), eq(agentRunSteps.stepKey, "persist_results")));
        await transaction.update(agentRuns).set({ currentStep: "persist_results", version: stepVersion, updatedAt: input.now }).where(and(eq(agentRuns.userId, run.userId), eq(agentRuns.id, run.id), eq(agentRuns.claimToken, run.claimToken), eq(agentRuns.controlState, "none")));
        await appendEvent(transaction, { id: deps.id, userId: run.userId, runId: run.id, version: stepVersion, eventType: "step.completed", data: { eventType: "step.completed", status: "running", currentStep: "persist_results", stepKey: "persist_results", attemptCount: run.attemptCount }, now: input.now });
        const terminalVersion = stepVersion + 1;
        await transaction.update(agentRuns).set({ status: "completed", currentStep: "completed", claimToken: null, claimExpiresAt: null, activeSliceStartedAt: null, activeDurationMs, completedAt: input.now, failureCode: null, terminationKind: "completed", terminationBudgetDimension: null, resultCount: run.resultCount + resultCount, version: terminalVersion, updatedAt: input.now }).where(and(eq(agentRuns.userId, run.userId), eq(agentRuns.id, run.id), eq(agentRuns.claimToken, run.claimToken), eq(agentRuns.controlState, "none")));
        await appendEvent(transaction, { id: deps.id, userId: run.userId, runId: run.id, version: terminalVersion, eventType: "run.completed", data: { eventType: "run.completed", status: "completed", currentStep: "completed", attemptCount: run.attemptCount, resultCount: run.resultCount + resultCount }, now: input.now });
        await deps.auditTrail.bind(transaction).append({ userId: run.userId, actorUserId: run.userId, eventType: "agent.run_completed", occurredAt: input.now, requestId: run.id, outcome: "success", reasonCode: "AGENT_RUN_COMPLETED", resourceType: "agent_run", resourceId: run.id, metadata: { runId: run.id, targetId: run.targetId, attemptCount: run.attemptCount, resultCount: run.resultCount + resultCount } });
        return { resultCount, cleanupObjectKeys, completed: true };
      };
      return input.transaction
        ? persist(input.transaction)
        : deps.db.transaction(persist) as Promise<{ resultCount: number; cleanupObjectKeys: string[]; completed: boolean }>;
    },
  };
}
