import { AccountRunPolicyResponseSchema } from "@job-copilot/contracts/account-run-policies";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";
const headers = { "Cache-Control": "no-store" };
export async function GET(_request: Request, { params }: { params: Promise<{ revisionNumber: string }> }) {
  const token = await readSessionToken(); const { revisionNumber } = await params;
  if (!token) return new Response(null, { status: 401, headers });
  if (!/^[0-9]+$/u.test(revisionNumber)) return new Response(null, { status: 404, headers });
  try { return Response.json(AccountRunPolicyResponseSchema.parse(await api.getAccountRunPolicyRevision(token, Number(revisionNumber))), { headers }); }
  catch (error) { const status = typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 404) ? error.status : 502; return new Response(null, { status, headers }); }
}
