import { AgentRunSseCursorSchema } from "@job-copilot/contracts/agent-runs";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type RouteContext = { params: Promise<{ runId: string }> };
const streamHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};
const emptyResponse = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const sessionPromise = readSessionToken();
  const { runId } = await params;
  const sessionToken = await sessionPromise;
  if (!sessionToken) return emptyResponse(401);
  if (!z.uuid().safeParse(runId).success) return emptyResponse(404);

  const url = new URL(request.url);
  const lastEventId = request.headers.get("last-event-id") ?? undefined;
  const afterEventId = url.searchParams.get("afterEventId") ?? undefined;
  if ((lastEventId !== undefined && !AgentRunSseCursorSchema.safeParse(lastEventId).success)
    || (afterEventId !== undefined && !AgentRunSseCursorSchema.safeParse(afterEventId).success)) {
    return emptyResponse(400);
  }

  try {
    const upstream = await api.openAgentRunEventStream(sessionToken, runId, {
      lastEventId,
      afterEventId,
      signal: request.signal,
    });
    return new Response(upstream.body, { status: upstream.status, headers: streamHeaders });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return emptyResponse(status === 401 || status === 404 ? status : 502);
  }
}
