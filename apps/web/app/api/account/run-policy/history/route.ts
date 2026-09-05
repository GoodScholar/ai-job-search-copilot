import { AccountRunPolicyHistorySchema } from "@job-copilot/contracts/account-run-policies";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";
export async function GET() {
  const token = await readSessionToken(); if (!token) return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  try { return Response.json(AccountRunPolicyHistorySchema.parse(await api.getAccountRunPolicyHistory(token)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && error.status === 401 ? 401 : 502; return new Response(null, { status, headers: { "Cache-Control": "no-store" } }); }
}
