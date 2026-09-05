import "server-only";

import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

export async function getRunPreflight(targetId?: string) {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Fhome");
  return api.getRunPreflight(sessionToken, targetId);
}
