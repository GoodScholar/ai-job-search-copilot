import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type RouteContext = { params: Promise<{ runId: string }> };
const noStore = { "Cache-Control": "no-store" };
const emptyResponse = (status: number) => new Response(null, { status, headers: noStore });

export async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
  const sessionPromise = readSessionToken();
  const { runId } = await params;
  const sessionToken = await sessionPromise;
  if (!sessionToken) return emptyResponse(401);
  if (!z.uuid().safeParse(runId).success) return emptyResponse(404);
  try {
    return Response.json(await api.getAgentRun(sessionToken, runId), { headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return emptyResponse(status === 401 || status === 404 ? status : 502);
  }
}
