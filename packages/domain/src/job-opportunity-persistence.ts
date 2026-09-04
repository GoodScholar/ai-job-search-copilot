import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { jobOpportunities, jobOpportunitySources } from "@job-copilot/database";

type Discovery = { sourceId: string; detailId: string; company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; sourceType: string; isOfficial: boolean; rawPayload: Record<string, unknown> };
type PersistenceDb = any;

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function opportunityKey(input: { company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; description: string | null; dedupIdentity?: string }) {
  const legacy = [input.company, input.title, input.location, input.postedAt, input.deadline, input.description === null ? null : sha256(input.description)];
  // 未传入时必须保持既有 six-field key，避免 v1-v3/import 幂等键发生迁移。
  return input.dedupIdentity === undefined
    ? sha256(JSON.stringify(legacy))
    : sha256(JSON.stringify(["public-job-opportunity-v1", ...legacy, input.dedupIdentity]));
}

/** 发现结果的可展示规范化字段；原始对象与对象存储路径不进入业务数据。 */
export function discoveryNormalizedData(detail: Discovery) {
  return { sourceId: detail.sourceId, detailId: detail.detailId, company: detail.company, title: detail.title, location: detail.location, postedAt: detail.postedAt, deadline: detail.deadline, sourceType: detail.sourceType, isOfficial: detail.isOfficial };
}

async function resolveCurrentOpportunity(db: PersistenceDb, userId: string, opportunity: { id: string; canonicalOpportunityId: string | null }) {
  const [resolved] = await db.execute(sql`
    with recursive chain as (
      select id, canonical_opportunity_id, array[id]::uuid[] as path, false as has_cycle
      from job_opportunities
      where user_id = ${userId}::uuid and id = ${opportunity.id}::uuid
      union all
      select next.id, next.canonical_opportunity_id, chain.path || next.id, next.id = any(chain.path)
      from chain
      join job_opportunities as next
        on next.user_id = ${userId}::uuid and next.id = chain.canonical_opportunity_id
      where chain.canonical_opportunity_id is not null and not chain.has_cycle
    )
    select id as "id", canonical_opportunity_id as "canonicalOpportunityId",
      case when has_cycle then 'cycle'
        when canonical_opportunity_id is null then 'root'
        else 'missing' end as "status"
    from chain
    order by cardinality(path) desc
    limit 1
  `) as Array<{ id: string; canonicalOpportunityId: string | null; status: "root" | "cycle" | "missing" }>;
  if (!resolved || resolved.status !== "root") throw new Error("AGENT_RUN_PERSIST_FAILED");
  return resolved;
}

/** 仅负责机会 dedup/upsert 与来源证据链接；来源 posting/version 的生命周期由调用方维护。 */
export async function persistJobOpportunity(db: PersistenceDb, input: {
  id: () => string; userId: string; importId: string | null; sourcePostingVersionId: string; isOfficial: boolean;
  existingOpportunityId?: string;
  company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; description: string | null; normalizedData: Record<string, unknown>; now: Date;
  /** 已验证来源可提供不可逆身份摘要，避免缺少可展示字段的公开页面相互合并。 */
  dedupIdentity?: string;
}): Promise<{ opportunityId: string }> {
  const dedupKey = opportunityKey(input);
  let [opportunity] = input.existingOpportunityId
    ? await db.select({ id: jobOpportunities.id, canonicalOpportunityId: jobOpportunities.canonicalOpportunityId }).from(jobOpportunities).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.existingOpportunityId)))
    : await db.select({ id: jobOpportunities.id, canonicalOpportunityId: jobOpportunities.canonicalOpportunityId }).from(jobOpportunities).where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.dedupKey, dedupKey)));
  if (opportunity) opportunity = await resolveCurrentOpportunity(db, input.userId, opportunity);
  if (!opportunity) {
    const [created] = await db.insert(jobOpportunities).values({ id: input.id(), userId: input.userId, importId: input.importId, sourcePostingVersionId: input.sourcePostingVersionId, dedupKey, company: input.company, title: input.title, location: input.location, postedAt: input.postedAt ? new Date(input.postedAt) : null, deadline: input.deadline ? new Date(input.deadline) : null, description: input.description, normalizedData: input.normalizedData, createdAt: input.now, updatedAt: input.now }).returning({ id: jobOpportunities.id });
    if (!created) throw new Error("AGENT_RUN_PERSIST_FAILED");
    opportunity = created;
  } else {
    // An earlier official source may already have advanced this normalized
    // identity. Attach the new source version to that canonical opportunity
    // instead of attempting a conflicting dedup-key update.
    if (input.isOfficial) {
      const [canonical] = await db.select({ id: jobOpportunities.id }).from(jobOpportunities).where(and(
        eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.dedupKey, dedupKey), isNull(jobOpportunities.canonicalOpportunityId),
      ));
      if (canonical && canonical.id !== opportunity.id) {
        await db.update(jobOpportunities).set({ canonicalOpportunityId: canonical.id, updatedAt: input.now }).where(and(
          eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, opportunity.id), isNull(jobOpportunities.canonicalOpportunityId),
        ));
        opportunity = canonical;
      }
    }
    if (input.isOfficial || input.dedupIdentity !== undefined) {
      const [current] = await db.select({ sourcePostingVersionId: jobOpportunities.sourcePostingVersionId }).from(jobOpportunities)
        .where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, opportunity.id)));
      if (current?.sourcePostingVersionId !== input.sourcePostingVersionId) {
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
    }
  }
  await db.insert(jobOpportunitySources).values({ id: input.id(), userId: input.userId, opportunityId: opportunity.id, sourcePostingVersionId: input.sourcePostingVersionId, createdAt: input.now }).onConflictDoNothing();
  return { opportunityId: opportunity.id };
}
