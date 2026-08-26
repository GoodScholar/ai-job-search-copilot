import "server-only";

import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2Fhome";

export async function getWorkbenchHome(): Promise<WorkbenchHome> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) {
    redirect(loginLocation);
  }

  try {
    return await api.getWorkbenchHome(sessionToken);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
      redirect(loginLocation);
    }
    throw error;
  }
}
