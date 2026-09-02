import "server-only";

import type { CalibrationProposal, RecommendationList, RecommendationListHistoryPage } from "@job-copilot/contracts/recommendations";
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

export async function getRecommendationHistoryPage(targetId: string): Promise<RecommendationListHistoryPage> {
  const session = await readSessionToken();
  if (!session) return { items: [], nextCursor: null };
  return api.getRecommendationHistoryPage(session, targetId);
}

export async function getCalibrationProposals(targetId: string): Promise<CalibrationProposal[]> {
  const session = await readSessionToken();
  if (!session) return [];
  return api.getCalibrationProposals(session, targetId);
}
