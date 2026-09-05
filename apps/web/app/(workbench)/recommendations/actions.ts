"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiClientError } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";
import { RunPreflightProblemSchema, RunPreflightWarningFingerprintSchema, type RunPreflightReport } from "@job-copilot/contracts/run-preflight";

export type RecommendationReevaluationActionResult = { kind: "started" } | { kind: "blocked"; preflight: RunPreflightReport } | { kind: "warning_confirmation_required"; preflight: RunPreflightReport };

/** Starts the durable matching workflow; this action never evaluates a model in the HTTP request. */
export async function requestRecommendationReevaluationAction(targetId: string, opportunityId: string, formData: FormData): Promise<RecommendationReevaluationActionResult> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Frecommendations");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  const rawFingerprint = formData.get("warningFingerprint");
  const warningFingerprint = typeof rawFingerprint === "string" ? RunPreflightWarningFingerprintSchema.safeParse(rawFingerprint).data ?? null : null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) throw new Error("DEEP_MATCH_IDEMPOTENCY_KEY_INVALID");
  try {
    await api.startDeepMatchRun(sessionToken, targetId, opportunityId, idempotencyKey, warningFingerprint);
    revalidatePath("/recommendations");
    return { kind: "started" };
  } catch (error) {
    const problem = error instanceof ApiClientError && error.status === 409 ? RunPreflightProblemSchema.safeParse(error.problem).data : null;
    if (problem?.code === "RUN_PREFLIGHT_BLOCKED") return { kind: "blocked", preflight: problem.preflight };
    if (problem?.code === "RUN_PREFLIGHT_WARNING_CONFIRMATION_REQUIRED") return { kind: "warning_confirmation_required", preflight: problem.preflight };
    throw error;
  }
}

export async function recordRecommendationDecisionAction(listId: string, itemId: string, formData: FormData): Promise<void> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) redirect("/login?returnTo=%2Frecommendations");
  const decision = String(formData.get("decision") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  const expectedVersion = Number(formData.get("expectedVersion") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const command = decision === "ignored" ? { decision, idempotencyKey, expectedVersion, ...(reason ? { reason } : {}), ...(note ? { note } : {}) } : { decision, idempotencyKey, expectedVersion };
  await api.recordRecommendationDecision(sessionToken, listId, itemId, command as never);
  revalidatePath("/recommendations");
}

export async function reviseCalibrationProposalAction(proposalId: string, formData: FormData): Promise<void> {
  const session = await readSessionToken(); if (!session) redirect("/login?returnTo=%2Frecommendations");
  await api.reviseCalibrationProposal(session, proposalId, { strategy: String(formData.get("strategy")), idempotencyKey: String(formData.get("idempotencyKey")), expectedVersion: Number(formData.get("expectedVersion")) } as never);
  revalidatePath("/recommendations");
}

export async function rebaseCalibrationProposalAction(proposalId: string, formData: FormData): Promise<void> {
  const session = await readSessionToken(); if (!session) redirect("/login?returnTo=%2Frecommendations");
  await api.rebaseCalibrationProposal(session, proposalId, { idempotencyKey: String(formData.get("idempotencyKey")), expectedVersion: Number(formData.get("expectedVersion")) });
  revalidatePath("/recommendations");
}

export type CalibrationProposalResolutionActionResult = { kind: "ok" } | { kind: "rule_version_conflict" };

export async function resolveCalibrationProposalAction(proposalId: string, formData: FormData): Promise<CalibrationProposalResolutionActionResult> {
  const session = await readSessionToken(); if (!session) redirect("/login?returnTo=%2Frecommendations");
  try {
    await api.resolveCalibrationProposal(session, proposalId, { action: String(formData.get("action")), idempotencyKey: String(formData.get("idempotencyKey")), expectedVersion: Number(formData.get("expectedVersion")) } as never);
    return { kind: "ok" };
  } catch (error) {
    if (error instanceof ApiClientError && error.problem?.code === "RULE_VERSION_CONFLICT") return { kind: "rule_version_conflict" };
    throw error;
  } finally {
    revalidatePath("/recommendations");
  }
}
