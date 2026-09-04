import { GREENHOUSE_JOB_DISCOVERY_ADAPTER, GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION } from "@job-copilot/contracts/agent-runs";
import { classifyGreenhousePublicSource } from "@job-copilot/contracts/job-discovery-schedules";
import { SourceCapabilityProjectionOverviewSchema, declareFormalBetaSourceCapabilities, type SourceCapabilityProjectionOverview } from "@job-copilot/contracts/source-capabilities";
import type { Database } from "@job-copilot/database";
import { createCompanyWatchlistQueries } from "./company-watchlists";

/** 服务端唯一将 owner-bound Watchlist 投影为来源能力声明的查询边界。 */
export function createSourceCapabilityProjectionQueries(deps: { db: Database }): {
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
            declaration: declareFormalBetaSourceCapabilities({ sourceId: classified.source.sourceId, adapter: GREENHOUSE_JOB_DISCOVERY_ADAPTER, adapterVersion: GREENHOUSE_SOURCE_HEALTH_ADAPTER_VERSION }),
          }];
        }),
      });
    },
  };
}

export type SourceCapabilityProjectionQueries = ReturnType<typeof createSourceCapabilityProjectionQueries>;
