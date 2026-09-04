import { classifyGreenhousePublicSource } from "@job-copilot/contracts/job-discovery-schedules";
import { SourceCapabilityProjectionOverviewSchema, type SourceCapabilityProjectionOverview } from "@job-copilot/contracts/source-capabilities";
import type { Database } from "@job-copilot/database";
import { createCompanyWatchlistQueries } from "./company-watchlists";
import type { SourceCapabilityAdapter } from "./source-capabilities";

/** 服务端唯一将 owner-bound Watchlist 投影为来源能力声明的查询边界。 */
export function createSourceCapabilityProjectionQueries(deps: { db: Database; capabilityAdapter: SourceCapabilityAdapter }): {
  get(input: { userId: string; targetId: string }): Promise<SourceCapabilityProjectionOverview>;
} {
  return {
    async get({ userId, targetId }) {
      const watchlist = await createCompanyWatchlistQueries({ db: deps.db }).get({ userId, targetId });
      return SourceCapabilityProjectionOverviewSchema.parse({
        targetId,
        watchlistVersion: watchlist.version,
        sources: watchlist.items.flatMap((item) => {
          const classified = classifyGreenhousePublicSource({ itemId: item.itemId, canonicalCompanyName: item.canonicalCompanyName, careersUrl: item.careersUrl, allowedDomains: item.allowedDomains });
          if (classified.kind !== "supported") return [];
          return [{
            watchlistItemId: item.itemId,
            name: item.canonicalCompanyName,
            state: item.state,
            declaration: deps.capabilityAdapter.declareCapabilities({ sourceId: classified.source.sourceId }),
          }];
        }),
      });
    },
  };
}

export type SourceCapabilityProjectionQueries = ReturnType<typeof createSourceCapabilityProjectionQueries>;
