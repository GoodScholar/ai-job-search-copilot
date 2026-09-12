import { AccountRunControlStateSchema } from "@job-copilot/contracts/account-run-policies";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };

export async function GET(): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return new Response(null, { status: 401, headers: noStore });
  try {
    return Response.json(AccountRunControlStateSchema.parse(await api.getAccountRunControl(token)), { headers: noStore });
  } catch (error) {
    return new Response(null, { status: safeStatus(error), headers: noStore });
  }
}

function safeStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error && error.status === 401 ? 401 : 502;
}
