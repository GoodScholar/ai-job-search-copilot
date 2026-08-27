import { CreateProfileFactCommandSchema } from "@job-copilot/contracts/profile-review";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: noStore });
}

export async function POST(request: Request): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  const body = CreateProfileFactCommandSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return emptyResponse(400);
  try {
    const profile = await api.createProfileFact(sessionToken, body.data);
    return Response.json(profile, { status: 201, headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 502;
    return emptyResponse(status === 401 || status === 409 ? status : 502);
  }
}
