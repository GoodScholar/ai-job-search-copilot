import "server-only";

import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2F";

async function sessionToken() {
  const token = await readSessionToken();
  if (!token) redirect(loginLocation);
  return token;
}

async function ownerBound<T>(read: (token: string) => Promise<T>): Promise<T> {
  try {
    return await read(await sessionToken());
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect(loginLocation);
    throw error;
  }
}

export async function getRecommendationRunPreparation() {
  return ownerBound((token) => api.getRecommendationRunPreparation(token));
}

export async function getLatestRecommendationRun() {
  return ownerBound((token) => api.getLatestRecommendationRun(token));
}

export async function getLatestPublishedRecommendationRun() {
  return ownerBound((token) => api.getLatestPublishedRecommendationRun(token));
}

/** 仅对当前会话读取逻辑推荐运行；owner-hidden 404 安全投影为空。 */
export async function getRecommendationRun(runId: string) {
  try {
    return await api.getRecommendationRun(await sessionToken(), runId);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error) {
      if (error.status === 401) redirect(loginLocation);
      if (error.status === 404) return null;
    }
    throw error;
  }
}
