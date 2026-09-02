"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

/** Starts the durable matching workflow; this action never evaluates a model in the HTTP request. */
export async function requestRecommendationReevaluationAction(targetId: string, opportunityId: string, formData: FormData): Promise<void> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Frecommendations");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) throw new Error("DEEP_MATCH_IDEMPOTENCY_KEY_INVALID");
  await api.startDeepMatchRun(sessionToken, targetId, opportunityId, idempotencyKey);
  revalidatePath("/recommendations");
}
