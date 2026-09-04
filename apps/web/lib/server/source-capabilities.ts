import "server-only";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

export async function getSourceCapabilities(targetId: string) {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(`/login?returnTo=${encodeURIComponent(`/profile/targets/${targetId}/watchlist`)}`);
  try { return await api.getSourceCapabilities(sessionToken, targetId); }
  catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect(`/login?returnTo=${encodeURIComponent(`/profile/targets/${targetId}/watchlist`)}`);
    throw error;
  }
}
