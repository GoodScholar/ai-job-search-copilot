import { JobDiscoveryScheduleResponseSchema, SetJobDiscoveryScheduleCommandSchema } from "@job-copilot/contracts/job-discovery-schedules";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type RouteContext = { params: Promise<{ targetId: string }> };
const noStore = { "Cache-Control": "no-store" };
const emptyResponse = (status: number) => new Response(null, { status, headers: noStore });

export async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
  const sessionPromise = readSessionToken();
  const { targetId } = await params;
  const sessionToken = await sessionPromise;
  if (!sessionToken) return emptyResponse(401);
  if (!z.uuid().safeParse(targetId).success) return emptyResponse(404);
  try {
    const response = JobDiscoveryScheduleResponseSchema.parse(await api.getJobDiscoverySchedule(sessionToken, targetId));
    return Response.json(response, { headers: noStore });
  } catch (error) {
    unstable_rethrow(error);
    return emptyResponse(safeStatus(error));
  }
}

export async function PUT(request: Request, { params }: RouteContext): Promise<Response> {
  const sessionPromise = readSessionToken();
  const { targetId } = await params;
  const sessionToken = await sessionPromise;
  if (!sessionToken) return emptyResponse(401);
  if (!z.uuid().safeParse(targetId).success) return emptyResponse(404);
  const command = SetJobDiscoveryScheduleCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) return emptyResponse(400);
  try {
    const response = JobDiscoveryScheduleResponseSchema.parse(await api.setJobDiscoverySchedule(sessionToken, targetId, command.data));
    return Response.json(response, { headers: noStore });
  } catch (error) {
    unstable_rethrow(error);
    return emptyResponse(safeStatus(error));
  }
}

function safeStatus(error: unknown): number {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
  return status === 400 || status === 401 || status === 404 || status === 409 ? status : 502;
}
