import { CompanyWatchlistItemSchema } from "@job-copilot/contracts/company-watchlists";
import { classifyGreenhousePublicSource, type GreenhousePublicSource } from "@job-copilot/contracts/job-discovery-schedules";

export type PublicJobDiscoverySourceAnalysis =
  | { status: "policy_required" }
  | { status: "unsupported" }
  | { status: "executable"; sources: GreenhousePublicSource[] };

/** The one public-source policy projection shared by scheduling and scheduled runs. */
export function analyzePublicJobDiscoverySources(watchlist: { items: unknown } | undefined): PublicJobDiscoverySourceAnalysis {
  const items = (watchlist ? CompanyWatchlistItemSchema.array().parse(watchlist.items) : [])
    .filter((item) => item.state === "enabled")
    .sort((left, right) => left.position - right.position);
  const classifications = items.map((item) => classifyGreenhousePublicSource({
    itemId: item.itemId, canonicalCompanyName: item.canonicalCompanyName, careersUrl: item.careersUrl, allowedDomains: item.allowedDomains,
  }));
  if (classifications.some((result) => result.kind === "policy_required")) return { status: "policy_required" };
  const sources = new Map<string, GreenhousePublicSource>();
  for (const result of classifications) if (result.kind === "supported" && !sources.has(result.source.sourceId)) sources.set(result.source.sourceId, result.source);
  return sources.size > 0 ? { status: "executable", sources: [...sources.values()] } : { status: "unsupported" };
}
