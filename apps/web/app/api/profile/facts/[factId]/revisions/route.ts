import { ReviseProfileFactCommandSchema } from "@job-copilot/contracts/profile-review";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type RouteContext = { params: Promise<{ factId: string }> };
const noStore = { "Cache-Control": "no-store" };

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: noStore });
}

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const { factId } = await params;
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  if (!z.uuid().safeParse(factId).success) return emptyResponse(404);
  const body = ReviseProfileFactCommandSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return emptyResponse(400);
  try {
    const profile = await api.reviseProfileFact(sessionToken, factId, body.data);
    return Response.json(profile, { status: 201, headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 502;
    return emptyResponse(status === 401 || status === 404 || status === 409 ? status : 502);
  }
}
