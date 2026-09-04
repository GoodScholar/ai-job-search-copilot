import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { CompanyWatchlistView } from "@/components/workbench/company-watchlist-view";
import { getCompanyWatchlist } from "@/lib/server/company-watchlists";
import { getSourceHealth } from "@/lib/server/source-health";
import { getSourceCapabilities } from "@/lib/server/source-capabilities";

export const metadata: Metadata = {
  title: "目标公司 Watchlist | AI Job Search Copilot",
};

const TargetIdSchema = z.uuid();

export default async function WatchlistPage({ params }: { params: Promise<{ targetId: string }> }) {
  const { targetId } = await params;
  if (!TargetIdSchema.safeParse(targetId).success) notFound();
  const [watchlistResult, sourceHealthResult, sourceCapabilitiesResult] = await Promise.allSettled([getCompanyWatchlist(targetId), getSourceHealth(targetId), getSourceCapabilities(targetId)]);
  for (const result of [watchlistResult, sourceHealthResult, sourceCapabilitiesResult]) {
    if (result.status === "rejected") unstable_rethrow(result.reason);
  }
  if (watchlistResult.status === "rejected") {
    return (
      <main className="container workbench-main">
        <section aria-labelledby="company-watchlist-error-title" className="workbench-error" role="status">
          <p className="workbench-kicker">目标公司 Watchlist · 暂未读取</p>
          <h1 id="company-watchlist-error-title">无法读取目标公司 Watchlist</h1>
          <p>暂时无法读取目标公司 Watchlist。请稍后重新尝试。</p>
          <a href={`/profile/targets/${targetId}/watchlist`}>重新尝试</a>
        </section>
      </main>
    );
  }
  const sourceHealth = sourceHealthResult.status === "fulfilled" ? sourceHealthResult.value : undefined;
  const sourceCapabilities = sourceCapabilitiesResult.status === "fulfilled" ? sourceCapabilitiesResult.value : undefined;
  const healthMatchesWatchlist = sourceHealth?.targetId === watchlistResult.value.target.targetId && sourceHealth.watchlistVersion === watchlistResult.value.version;
  const capabilitiesMatchWatchlist = sourceCapabilities?.targetId === watchlistResult.value.target.targetId && sourceCapabilities.watchlistVersion === watchlistResult.value.version;
  return <CompanyWatchlistView initialCapabilityRefreshFailed={!capabilitiesMatchWatchlist} initialHealthRefreshFailed={!healthMatchesWatchlist} initialOverview={watchlistResult.value} initialSourceCapabilities={capabilitiesMatchWatchlist ? sourceCapabilities : undefined} initialSourceHealth={healthMatchesWatchlist ? sourceHealth : undefined} />;
}
