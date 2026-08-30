import { JobSourceHealthOverviewSchema } from "@job-copilot/contracts/agent-runs";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const headers = { "Cache-Control": "no-store" };
const safeStatus = (error: unknown) => typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && [400, 401, 404].includes(error.status) ? error.status : 502;
export async function GET(_request: Request, { params }: { params: Promise<{ targetId: string }> }): Promise<Response> {
  const { targetId } = await params;
  if (!z.uuid().safeParse(targetId).success) return new Response(null, { status: 404, headers });
  const token = await readSessionToken();
  if (!token) return new Response(null, { status: 401, headers });
  try { return Response.json(JobSourceHealthOverviewSchema.parse(await api.getSourceHealth(token, targetId)), { headers }); }
  catch (error) { unstable_rethrow(error); return new Response(null, { status: safeStatus(error), headers }); }
}
