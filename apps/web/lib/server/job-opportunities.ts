import "server-only";

import type { JobOpportunityArchiveFilter, JobOpportunityArchivePage } from "@job-copilot/contracts/job-opportunity-archives";
import type { JobExport } from "@job-copilot/contracts/job-exports";
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

export async function getJobExports(): Promise<JobExport[] | null> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Fjobs");
  try { return (await api.listJobExports(sessionToken)).items; }
  catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect("/login?returnTo=%2Fjobs");
    return null;
  }
}
