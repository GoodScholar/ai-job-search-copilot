import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentRunJobResults, jobOpportunities, jobOpportunitySources } from "@job-copilot/database";

type Discovery = { sourceId: string; detailId: string; company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; sourceType: string; isOfficial: boolean; rawPayload: Record<string, unknown> };
type PersistenceDb = any;

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function opportunityKey(input: { company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; description: string | null }) {
  return sha256(JSON.stringify([input.company, input.title, input.location, input.postedAt, input.deadline, input.description === null ? null : sha256(input.description)]));
}

/** 发现结果的可展示规范化字段；原始对象与对象存储路径不进入业务数据。 */
export function discoveryNormalizedData(detail: Discovery) {
  return { sourceId: detail.sourceId, detailId: detail.detailId, company: detail.company, title: detail.title, location: detail.location, postedAt: detail.postedAt, deadline: detail.deadline, sourceType: detail.sourceType, isOfficial: detail.isOfficial };
}

/** Consolidate a superseded dedup identity without dropping source evidence or historical run results. */
async function mergeOpportunity(db: PersistenceDb, input: { id: () => string; userId: string; supersededId: string; canonicalId: string; now: Date }) {
  const evidence = await db.select({ sourcePostingVersionId: jobOpportunitySources.sourcePostingVersionId }).from(jobOpportunitySources)
    .where(and(eq(jobOpportunitySources.userId, input.userId), eq(jobOpportunitySources.opportunityId, input.supersededId)));
  if (evidence.length > 0) await db.insert(jobOpportunitySources).values(evidence.map((row: { sourcePostingVersionId: string }) => ({
    id: input.id(), userId: input.userId, opportunityId: input.canonicalId, sourcePostingVersionId: row.sourcePostingVersionId, createdAt: input.now,
  }))).onConflictDoNothing();
  // The new evidence rows must exist before this update because results carry
  // an owner/evidence composite foreign key.
  await db.update(agentRunJobResults).set({ opportunityId: input.canonicalId }).where(and(
    eq(agentRunJobResults.userId, input.userId), eq(agentRunJobResults.opportunityId, input.supersededId),
  ));
  await db.delete(jobOpportunitySources).where(and(eq(jobOpportunitySources.userId, input.userId), eq(jobOpportunitySources.opportunityId, input.supersededId)));
  await db.delete(jobOpportunities).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.supersededId)));
}

/** 仅负责机会 dedup/upsert 与来源证据链接；来源 posting/version 的生命周期由调用方维护。 */
export async function persistJobOpportunity(db: PersistenceDb, input: {
  id: () => string; userId: string; importId: string | null; sourcePostingVersionId: string; isOfficial: boolean;
  existingOpportunityId?: string;
  company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; description: string | null; normalizedData: Record<string, unknown>; now: Date;
}): Promise<{ opportunityId: string }> {
  const dedupKey = opportunityKey(input);
  let [opportunity] = input.existingOpportunityId
    ? await db.select({ id: jobOpportunities.id }).from(jobOpportunities).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.existingOpportunityId)))
    : await db.select({ id: jobOpportunities.id }).from(jobOpportunities).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.dedupKey, dedupKey)));
  if (!opportunity) {
    const [created] = await db.insert(jobOpportunities).values({ id: input.id(), userId: input.userId, importId: input.importId, sourcePostingVersionId: input.sourcePostingVersionId, dedupKey, company: input.company, title: input.title, location: input.location, postedAt: input.postedAt ? new Date(input.postedAt) : null, deadline: input.deadline ? new Date(input.deadline) : null, description: input.description, normalizedData: input.normalizedData, createdAt: input.now, updatedAt: input.now }).returning({ id: jobOpportunities.id });
    if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
    opportunity = created;
  } else if (input.isOfficial) {
    // An earlier official source may already have advanced this normalized
    // identity. Attach the new source version to that canonical opportunity
    // instead of attempting a conflicting dedup-key update.
    const [canonical] = await db.select({ id: jobOpportunities.id }).from(jobOpportunities).where(and(
      eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.dedupKey, dedupKey),
    ));
    if (canonical && canonical.id !== opportunity.id) {
      await mergeOpportunity(db, { id: input.id, userId: input.userId, supersededId: opportunity.id, canonicalId: canonical.id, now: input.now });
      opportunity = canonical;
    }
    await db.update(jobOpportunities).set({
      sourcePostingVersionId: input.sourcePostingVersionId,
      dedupKey,
      company: input.company,
      title: input.title,
      location: input.location,
      postedAt: input.postedAt ? new Date(input.postedAt) : null,
      deadline: input.deadline ? new Date(input.deadline) : null,
      description: input.description,
      normalizedData: input.normalizedData,
      updatedAt: input.now,
    }).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, opportunity.id)));
  }
  await db.insert(jobOpportunitySources).values({ id: input.id(), userId: input.userId, opportunityId: opportunity.id, sourcePostingVersionId: input.sourcePostingVersionId, createdAt: input.now }).onConflictDoNothing();
  return { opportunityId: opportunity.id };
}
