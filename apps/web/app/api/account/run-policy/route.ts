import { accountRunPolicyProblemFromZodIssues, AccountRunPolicyCommandSchema, AccountRunPolicyProblemSchema, AccountRunPolicyResponseSchema } from "@job-copilot/contracts/account-run-policies";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";
const noStore = { "Cache-Control": "no-store" };
const empty = (status: number) => new Response(null, { status, headers: noStore });
export async function GET() {
  const token = await readSessionToken(); if (!token) return empty(401);
  try { return Response.json(AccountRunPolicyResponseSchema.parse(await api.getAccountRunPolicy(token)), { headers: noStore }); }
  catch (error) { return problem(error); }
}
export async function PUT(request: Request) {
  const token = await readSessionToken(); if (!token) return empty(401);
  const command = AccountRunPolicyCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) {
    const localProblem = accountRunPolicyProblemFromZodIssues(command.error.issues);
    return localProblem ? Response.json(localProblem, { status: 400, headers: noStore }) : empty(400);
  }
  try { return Response.json(AccountRunPolicyResponseSchema.parse(await api.saveAccountRunPolicy(token, command.data)), { headers: noStore }); }
  catch (error) { return problem(error); }
}
function problem(error: unknown): Response {
  const value = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
  const raw = typeof error === "object" && error !== null && "problem" in error ? error.problem : null;
  const parsed = AccountRunPolicyProblemSchema.safeParse(raw);
  if (parsed.success && (value === 400 || value === 409)) return Response.json(parsed.data, { status: value, headers: noStore });
  return empty(value === 401 ? 401 : 502);
}
