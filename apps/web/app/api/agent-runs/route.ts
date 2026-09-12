import { StartAgentRunCommandSchema } from "@job-copilot/contracts/agent-runs";
import { RunPreflightProblemSchema } from "@job-copilot/contracts/run-preflight";
import { ApiProblemSchema } from "@job-copilot/contracts/api-problem";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };
const emptyResponse = (status: number) => new Response(null, { status, headers: noStore });

export async function GET(): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  try {
    return Response.json(await api.getLatestAgentRun(sessionToken), { headers: noStore });
  } catch (error) {
    return emptyResponse(safeStatus(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  const command = StartAgentRunCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) return emptyResponse(400);
  try {
    const run = await api.startAgentRun(sessionToken, command.data);
    return Response.json(run, { status: run.reused ? 200 : 201, headers: noStore });
  } catch (error) {
    const preflight = runPreflightProblem(error);
    if (preflight) return Response.json(preflight, { status: 409, headers: noStore });
    const stopped = accountRunStoppedProblem(error);
    if (stopped) return Response.json(stopped, { status: 409, headers: noStore });
    return emptyResponse(safeStatus(error));
  }
}

function accountRunStoppedProblem(error: unknown): { code: "ACCOUNT_RUN_STOPPED"; message: string } | null {
  if (!error || typeof error !== "object" || !("status" in error) || error.status !== 409 || !("problem" in error)) return null;
  const parsed = ApiProblemSchema.safeParse(error.problem);
  return parsed.success && parsed.data.code === "ACCOUNT_RUN_STOPPED" ? { code: parsed.data.code, message: parsed.data.message } : null;
}

function runPreflightProblem(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error) || error.status !== 409 || !("problem" in error)) return null;
  return RunPreflightProblemSchema.safeParse(error.problem).data ?? null;
}

function safeStatus(error: unknown): number {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : 502;
  return status === 400 || status === 401 || status === 404 || status === 503 ? status : 502;
}
