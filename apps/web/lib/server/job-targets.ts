import "server-only";

import type { JobTargetOverview } from "@job-copilot/contracts/job-targets";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2Fprofile%2Ftargets";

export async function getJobTargets(): Promise<JobTargetOverview> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation);

  try {
    return await api.getJobTargetOverview(sessionToken);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
      redirect(loginLocation);
    }
    throw error;
  }
}
