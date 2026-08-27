import "server-only";

import type { CareerImportList } from "@job-copilot/contracts/career-import";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2Fprofile";

export async function getCareerImports(): Promise<CareerImportList> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) {
    redirect(loginLocation);
  }

  try {
    return await api.listCareerImports(sessionToken);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
      redirect(loginLocation);
    }
    throw error;
  }
}
