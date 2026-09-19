import "server-only";

import type { JobOpportunityArchiveFilter, JobOpportunityArchivePage } from "@job-copilot/contracts/job-opportunity-archives";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

export async function getJobOpportunities(filter: JobOpportunityArchiveFilter): Promise<JobOpportunityArchivePage> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Fjobs");
  try { return await api.listJobOpportunities(sessionToken, filter); }
  catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect("/login?returnTo=%2Fjobs");
    throw error;
  }
}
