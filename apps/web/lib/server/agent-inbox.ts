import "server-only";

import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2F";

export async function getOpenAgentInbox() {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation);

  try {
    return await api.listAgentInbox(sessionToken, "open");
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
      redirect(loginLocation);
    }
    throw error;
  }
}
