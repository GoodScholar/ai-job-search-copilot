import { CreateJobTargetCommandSchema } from "@job-copilot/contracts/job-targets";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };
const emptyResponse = (status: number) => new Response(null, { status, headers: noStore });

export async function POST(request: Request): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  const body = CreateJobTargetCommandSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return emptyResponse(400);
  try {
    return Response.json(await api.createJobTarget(sessionToken, body.data), { status: 201, headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return emptyResponse(status === 401 || status === 409 ? status : 502);
  }
}
