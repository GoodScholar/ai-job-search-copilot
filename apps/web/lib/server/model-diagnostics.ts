import "server-only";

import type { ModelDiagnosticPublicResponse } from "@job-copilot/contracts/model-diagnostics";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2Fprofile%2Fmodel-connection";

export async function getModelDiagnostics(): Promise<ModelDiagnosticPublicResponse> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation);
  try {
    return await api.getModelDiagnostics(sessionToken);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect(loginLocation);
    throw error;
  }
}
