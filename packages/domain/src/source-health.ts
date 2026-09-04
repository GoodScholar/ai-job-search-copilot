import { and, desc, eq, inArray } from "drizzle-orm";
import { jobSourceHealthChecks, type Database } from "@job-copilot/database";
import { JobSourceHealthOverviewSchema, type JobSourceHealthOverview } from "@job-copilot/contracts/agent-runs";
import { classifyGreenhousePublicSource } from "@job-copilot/contracts/job-discovery-schedules";
import { createCompanyWatchlistQueries } from "./company-watchlists";

export function createSourceHealthQueries(deps: { db: Database }): {
  get(input: { userId: string; targetId: string }): Promise<JobSourceHealthOverview>;
} {
  return {
    async get({ userId, targetId }) {
      const watchlist = await createCompanyWatchlistQueries({ db: deps.db }).get({ userId, targetId });
      const sources = watchlist.items.flatMap((item) => {
        const classified = classifyGreenhousePublicSource({ itemId: item.itemId, canonicalCompanyName: item.canonicalCompanyName, careersUrl: item.careersUrl, allowedDomains: item.allowedDomains });
        return classified.kind === "supported" ? [{ item, sourceId: classified.source.sourceId }] : [];
      });
      const checks = sources.length === 0 ? [] : await deps.db.select().from(jobSourceHealthChecks).where(and(
        eq(jobSourceHealthChecks.userId, userId), eq(jobSourceHealthChecks.targetId, targetId),
        inArray(jobSourceHealthChecks.watchlistItemId, sources.map(({ item }) => item.itemId)),
        inArray(jobSourceHealthChecks.sourceId, sources.map(({ sourceId }) => sourceId)),
      )).orderBy(desc(jobSourceHealthChecks.checkedAt), desc(jobSourceHealthChecks.id));
      const latest = new Map<string, typeof checks[number]>();
      for (const check of checks) {
        const key = `${check.watchlistItemId}:${check.sourceId}`;
        if (!latest.has(key)) latest.set(key, check);
      }
      return JobSourceHealthOverviewSchema.parse({
        targetId, watchlistVersion: watchlist.version,
        sources: sources.map(({ item, sourceId }) => {
          const check = latest.get(`${item.itemId}:${sourceId}`);
          if (item.state === "disabled") return { watchlistItemId: item.itemId, sourceId, name: item.canonicalCompanyName, state: "disabled", status: "disabled", runId: null, reasonCodes: [], impact: { scope: "none", affectedCount: null }, lastCheckedAt: null, suggestedAction: "reenable_source" };
          if (!check) return { watchlistItemId: item.itemId, sourceId, name: item.canonicalCompanyName, state: "enabled", status: null, runId: null, reasonCodes: [], impact: { scope: "none", affectedCount: null }, lastCheckedAt: null, suggestedAction: "wait_for_next_run" };
          return { watchlistItemId: item.itemId, sourceId, name: item.canonicalCompanyName, state: "enabled", status: check.status, runId: check.runId, reasonCodes: check.reasonCodes, impact: { scope: check.impactScope, affectedCount: check.impactAffectedCount }, lastCheckedAt: check.checkedAt.toISOString(), suggestedAction: check.status === "healthy" ? "none" : check.status === "zero_valid_results" ? "wait_for_next_run" : check.status === "rate_limited" ? "retry_later" : "retry_or_disable" };
        }),
      });
    },
  };
}

export type SourceHealthQueries = ReturnType<typeof createSourceHealthQueries>;
