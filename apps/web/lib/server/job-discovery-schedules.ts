import "server-only";

import type { JobDiscoveryScheduleResponse } from "@job-copilot/contracts/job-discovery-schedules";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2Fhome";

export async function getJobDiscoverySchedule(targetId: string): Promise<JobDiscoveryScheduleResponse> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation);
  try { return await api.getJobDiscoverySchedule(sessionToken, targetId); }
  catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect(loginLocation);
    throw error;
  }
}
