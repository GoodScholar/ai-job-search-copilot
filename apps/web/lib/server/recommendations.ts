import "server-only";

import type { RecommendationList, RecommendationListHistory } from "@job-copilot/contracts/recommendations";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

export async function getLatestRecommendations(targetId: string): Promise<RecommendationList | null> {
  const session = await readSessionToken();
  if (!session) return null;
  try { return await api.getLatestRecommendations(session, targetId); } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return null;
    throw error;
  }
}

export async function getRecommendationHistory(targetId: string): Promise<RecommendationListHistory> {
  const session = await readSessionToken();
  if (!session) return [];
  return api.getRecommendationHistory(session, targetId);
}
