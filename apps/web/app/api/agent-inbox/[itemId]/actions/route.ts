import { AgentInboxActionCommandSchema } from "@job-copilot/contracts/agent-inbox";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type RouteContext = { params: Promise<{ itemId: string }> };
const noStore = { "Cache-Control": "no-store" };
const emptyResponse = (status: number) => new Response(null, { status, headers: noStore });

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const sessionPromise = readSessionToken();
  const { itemId } = await params;
  const sessionToken = await sessionPromise;
  if (!sessionToken) return emptyResponse(401);
  if (!z.uuid().safeParse(itemId).success) return emptyResponse(404);
  const command = AgentInboxActionCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) return emptyResponse(400);
  try {
    return Response.json(await api.actOnAgentInboxItem(sessionToken, itemId, command.data), { headers: noStore });
  } catch (error) {
    return emptyResponse(safeStatus(error));
  }
}

function safeStatus(error: unknown): number {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
  return status === 400 || status === 401 || status === 404 || status === 409 ? status : 502;
}
