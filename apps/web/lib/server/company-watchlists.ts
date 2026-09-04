import "server-only";

import type { CompanyWatchlistOverview } from "@job-copilot/contracts/company-watchlists";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

function loginLocation(targetId: string): string {
  return `/login?returnTo=${encodeURIComponent(`/profile/targets/${targetId}/watchlist`)}`;
}

export async function getCompanyWatchlist(targetId: string): Promise<CompanyWatchlistOverview> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation(targetId));

  try {
    return await api.getCompanyWatchlist(sessionToken, targetId);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
      redirect(loginLocation(targetId));
    }
    throw error;
  }
}
