import "server-only";

import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2F";

export async function getLatestAgentRun() {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation);

  try {
    return await api.getLatestAgentRun(sessionToken);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
      redirect(loginLocation);
    }
    throw error;
  }
}

/** 指定运行只按当前会话 owner-bound API 读取；404（含跨 owner 隐藏）安全投影为空。 */
export async function getAgentRun(runId: string) {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation);
  try {
    return await api.getAgentRun(sessionToken, runId);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error) {
      if (error.status === 401) redirect(loginLocation);
      if (error.status === 404) return null;
    }
    throw error;
  }
}
