import "server-only";

import type { JobTriageVersion } from "@job-copilot/contracts/job-triage";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

export async function getLatestJobTriageVersion(opportunityId: string): Promise<JobTriageVersion> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Fjobs%2Fimport");
  try {
    return await api.getLatestJobTriageVersion(sessionToken, opportunityId);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect("/login?returnTo=%2Fjobs%2Fimport");
    throw error;
  }
}
