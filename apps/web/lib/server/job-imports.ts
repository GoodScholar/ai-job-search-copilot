import "server-only";

import type { JobImportList } from "@job-copilot/contracts/job-imports";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2Fjobs%2Fimport";

export async function getJobImports(): Promise<JobImportList> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation);

  try {
    return await api.listJobImports(sessionToken);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
      redirect(loginLocation);
    }
    throw error;
  }
}
