import { CreateJobTriageVersionCommandSchema } from "@job-copilot/contracts/job-triage";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type RouteContext = { params: Promise<{ opportunityId: string }> };
const noStore = { "Cache-Control": "no-store" };
const emptyResponse = (status: number) => new Response(null, { status, headers: noStore });

export async function GET(request: Request, { params }: RouteContext): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  const { opportunityId } = await params;
  if (!z.uuid().safeParse(opportunityId).success) return emptyResponse(404);
  const targetId = new URL(request.url).searchParams.get("targetId");
  if (!z.uuid().safeParse(targetId).success) return emptyResponse(400);
  try {
    return Response.json(await api.getLatestJobTriageVersion(sessionToken, opportunityId, targetId!), { headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return emptyResponse(status === 401 || status === 404 ? status : 502);
  }
}

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  const { opportunityId } = await params;
  if (!z.uuid().safeParse(opportunityId).success) return emptyResponse(404);
  const command = CreateJobTriageVersionCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) return emptyResponse(400);
  try {
    return Response.json(await api.createJobTriageVersion(sessionToken, opportunityId, command.data), { status: 201, headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return emptyResponse(status === 401 || status === 404 || status === 409 ? status : 502);
  }
}
