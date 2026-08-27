import "server-only";

import type { ProfileSnapshot } from "@job-copilot/contracts/profile-review";
import { redirect } from "next/navigation";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const loginLocation = "/login?returnTo=%2Fprofile";

export async function getProfile(): Promise<ProfileSnapshot> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect(loginLocation);
  try {
    return await api.getProfile(sessionToken);
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 401) redirect(loginLocation);
    throw error;
  }
}
