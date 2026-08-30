import type { Metadata } from "next";
import { notFound, unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { CompanyWatchlistView } from "@/components/workbench/company-watchlist-view";
import { getCompanyWatchlist } from "@/lib/server/company-watchlists";
import { getSourceHealth } from "@/lib/server/source-health";

export const metadata: Metadata = {
  title: "目标公司 Watchlist | AI Job Search Copilot",
};

const TargetIdSchema = z.uuid();

export default async function WatchlistPage({ params }: { params: Promise<{ targetId: string }> }) {
  const { targetId } = await params;
  if (!TargetIdSchema.safeParse(targetId).success) notFound();
  let overview;
  try {
    const [watchlist, sourceHealth] = await Promise.all([getCompanyWatchlist(targetId), getSourceHealth(targetId)]);
    overview = { watchlist, sourceHealth };
  } catch (error) {
    unstable_rethrow(error);
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
  return <CompanyWatchlistView initialOverview={overview.watchlist} initialSourceHealth={overview.sourceHealth} />;
}
