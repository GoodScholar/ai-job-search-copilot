import { and, count, desc, eq, inArray, notExists, or } from "drizzle-orm";
import { WorkbenchHomeSchema, type WorkbenchHome } from "@job-copilot/contracts/workbench";
import { CompanyWatchlistItemSchema } from "@job-copilot/contracts/company-watchlists";
import { classifyGreenhousePublicSource } from "@job-copilot/contracts/job-discovery-schedules";
import { agentInboxItems, agentRuns, candidateFactDecisions, candidateFacts, companyWatchlistRevisions, companyWatchlists, jobAccounts, jobSourceHealthChecks, recommendationListItems, recommendationLists, type Database } from "@job-copilot/database";
import type { FirstRecommendationJourneyReader } from "./first-recommendation-journey";

export class DomainError extends Error {
  constructor(public readonly code: "ACCOUNT_NOT_FOUND") {
    super(code);
  }
}

export type GetWorkbenchHome = (input: { userId: string }) => Promise<WorkbenchHome>;

function shanghaiDate(clock: () => Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(clock())
    .reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function countFromDatabase(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label}计数无效`);
  return result;
}

async function countLatestEnabledSourceFailures(db: Database, userId: string): Promise<number> {
  const watchlists = await db.select({ targetId: companyWatchlists.targetId, items: companyWatchlistRevisions.items })
    .from(companyWatchlists)
    .innerJoin(companyWatchlistRevisions, and(
      eq(companyWatchlistRevisions.userId, companyWatchlists.userId),
      eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id),
      eq(companyWatchlistRevisions.version, companyWatchlists.version),
    ))
    .where(eq(companyWatchlists.userId, userId));
  const enabledSources = watchlists.flatMap(({ targetId, items }) => CompanyWatchlistItemSchema.array().parse(items)
    .filter((item) => item.state === "enabled")
    .flatMap((item) => {
      const source = classifyGreenhousePublicSource({ itemId: item.itemId, canonicalCompanyName: item.canonicalCompanyName, careersUrl: item.careersUrl, allowedDomains: item.allowedDomains });
      return source.kind === "supported" ? [{ targetId, watchlistItemId: item.itemId, sourceId: source.source.sourceId }] : [];
    }));
  if (enabledSources.length === 0) return 0;

  const sourceWhere = or(...enabledSources.map((source) => and(
    eq(jobSourceHealthChecks.targetId, source.targetId),
    eq(jobSourceHealthChecks.watchlistItemId, source.watchlistItemId),
    eq(jobSourceHealthChecks.sourceId, source.sourceId),
  )));
  const latest = await db.selectDistinctOn(
    [jobSourceHealthChecks.targetId, jobSourceHealthChecks.watchlistItemId, jobSourceHealthChecks.sourceId],
    { status: jobSourceHealthChecks.status },
  ).from(jobSourceHealthChecks)
    .where(and(eq(jobSourceHealthChecks.userId, userId), sourceWhere))
    .orderBy(
      jobSourceHealthChecks.targetId,
      jobSourceHealthChecks.watchlistItemId,
      jobSourceHealthChecks.sourceId,
      desc(jobSourceHealthChecks.checkedAt),
      desc(jobSourceHealthChecks.id),
    );
  return countFromDatabase(latest.filter(({ status }) => status === "parser_degraded" || status === "rate_limited" || status === "hard_failed").length, "来源失败");
}

async function countTodayRecommendationItems(db: Database, userId: string, localDate: string): Promise<number> {
  const latestLists = await db.selectDistinctOn(
    [recommendationLists.targetId],
    { id: recommendationLists.id },
  ).from(recommendationLists)
    .where(and(eq(recommendationLists.userId, userId), eq(recommendationLists.localDate, localDate)))
    .orderBy(recommendationLists.targetId, desc(recommendationLists.sequence), desc(recommendationLists.id));
  if (latestLists.length === 0) return 0;
  const [items] = await db.select({ count: count() }).from(recommendationListItems).where(and(
    eq(recommendationListItems.userId, userId),
    inArray(recommendationListItems.recommendationListId, latestLists.map(({ id }) => id)),
  ));
  return countFromDatabase(items?.count ?? 0, "今日推荐");
}

export function createWorkbenchHome(input: { db: Database; clock: () => Date; firstRecommendationJourney: FirstRecommendationJourneyReader }): GetWorkbenchHome {
  return async ({ userId }) => {
    const [account] = await input.db.select({ userId: jobAccounts.id })
      .from(jobAccounts)
      .where(and(eq(jobAccounts.id, userId), eq(jobAccounts.status, "active")));

    if (!account) {
      throw new DomainError("ACCOUNT_NOT_FOUND");
    }

    const [facts, activeRuns, failedRuns, recommendations, pendingInbox, sourceFailures, firstRecommendationJourney] = await Promise.all([
      input.db.select({ count: count() }).from(candidateFacts).where(and(
        eq(candidateFacts.userId, userId),
        notExists(input.db.select({ id: candidateFactDecisions.id }).from(candidateFactDecisions).where(and(
          eq(candidateFactDecisions.userId, userId),
          eq(candidateFactDecisions.candidateFactId, candidateFacts.id),
        ))),
      )),
      input.db.select({ count: count() }).from(agentRuns).where(and(eq(agentRuns.userId, userId), inArray(agentRuns.status, ["queued", "running", "paused"]))),
      input.db.select({ count: count() }).from(agentRuns).where(and(eq(agentRuns.userId, userId), eq(agentRuns.status, "failed"))),
      countTodayRecommendationItems(input.db, userId, shanghaiDate(input.clock)),
      input.db.select({ count: count() }).from(agentInboxItems).where(and(eq(agentInboxItems.userId, userId), inArray(agentInboxItems.status, ["unread", "read"]))),
      countLatestEnabledSourceFailures(input.db, userId),
      input.firstRecommendationJourney.get({ userId }).catch(() => null),
    ]);
    return WorkbenchHomeSchema.parse({
      account,
      summary: {
        todayRecommendations: recommendations,
        pendingFacts: countFromDatabase(facts[0]?.count ?? 0, "待确认候选事实"),
        activeAgentRuns: countFromDatabase(activeRuns[0]?.count ?? 0, "活跃 Agent Run"),
        failedAgentRuns: countFromDatabase(failedRuns[0]?.count ?? 0, "失败 Agent Run"),
        sourceFailures,
        pendingDecisions: countFromDatabase(pendingInbox[0]?.count ?? 0, "待处理 Inbox"),
        applications: 0,
        applicationsAvailable: false,
      },
      firstRecommendationJourney,
    });
  };
}
