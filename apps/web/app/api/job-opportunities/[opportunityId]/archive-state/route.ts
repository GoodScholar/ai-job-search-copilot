import { JobOpportunityArchiveCommandSchema } from "@job-copilot/contracts/job-opportunity-archives";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };
export async function POST(request: Request, { params }: { params: Promise<{ opportunityId: string }> }): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return new Response(null, { status: 401, headers: noStore });
  const { opportunityId } = await params;
  const command = JobOpportunityArchiveCommandSchema.safeParse(await request.json().catch(() => null));
  if (!z.uuid().safeParse(opportunityId).success || !command.success) return new Response(null, { status: 400, headers: noStore });
  try { return Response.json(await api.changeJobOpportunityArchiveState(sessionToken, opportunityId, command.data), { status: 201, headers: noStore }); }
  catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return new Response(null, { status: status === 401 || status === 404 || status === 409 ? status : 502, headers: noStore });
  }
}
