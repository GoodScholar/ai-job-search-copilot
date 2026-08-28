import { ReviseJobTargetCommandSchema } from "@job-copilot/contracts/job-targets";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type RouteContext = { params: Promise<{ targetId: string }> };
const noStore = { "Cache-Control": "no-store" };
const emptyResponse = (status: number) => new Response(null, { status, headers: noStore });

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const { targetId } = await params;
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  if (!z.uuid().safeParse(targetId).success) return emptyResponse(404);
  const body = ReviseJobTargetCommandSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return emptyResponse(400);
  try {
    return Response.json(await api.reviseJobTarget(sessionToken, targetId, body.data), { status: 201, headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return emptyResponse(status === 401 || status === 404 || status === 409 ? status : 502);
  }
}
