"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

/** Starts the durable matching workflow; this action never evaluates a model in the HTTP request. */
export async function requestRecommendationReevaluationAction(targetId: string): Promise<void> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Frecommendations");
  await api.startDeepMatchRun(sessionToken, targetId, randomUUID());
  revalidatePath("/recommendations");
}
