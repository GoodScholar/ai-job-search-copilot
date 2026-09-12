import { AccountRunControlCommandSchema, AccountRunControlResponseSchema } from "@job-copilot/contracts/account-run-policies";
import { ApiProblemSchema } from "@job-copilot/contracts/api-problem";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return new Response(null, { status: 401, headers: noStore });
  const command = AccountRunControlCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) return new Response(null, { status: 400, headers: noStore });
  try {
    return Response.json(AccountRunControlResponseSchema.parse(await api.controlAccountRuns(token, command.data)), { headers: noStore });
  } catch (error) {
    const problem = publicControlConflict(error);
    if (problem) return Response.json(problem, { status: 409, headers: noStore });
    return new Response(null, { status: safeStatus(error), headers: noStore });
  }
}

function publicControlConflict(error: unknown): { code: "ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT" | "ACCOUNT_RUN_CONTROL_VERSION_CONFLICT"; message: string } | null {
  if (!error || typeof error !== "object" || !("status" in error) || error.status !== 409 || !("problem" in error)) return null;
  const parsed = ApiProblemSchema.safeParse(error.problem);
  if (!parsed.success || (parsed.data.code !== "ACCOUNT_RUN_CONTROL_COMMAND_ID_CONFLICT" && parsed.data.code !== "ACCOUNT_RUN_CONTROL_VERSION_CONFLICT")) return null;
  return { code: parsed.data.code, message: parsed.data.message };
}

function safeStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error && error.status === 401 ? 401 : 502;
}
