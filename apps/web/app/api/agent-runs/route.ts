import { StartAgentRunCommandSchema } from "@job-copilot/contracts/agent-runs";
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
    return emptyResponse(safeStatus(error));
  }
}

function safeStatus(error: unknown): number {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : 502;
  return status === 400 || status === 401 || status === 404 || status === 503 ? status : 502;
}
