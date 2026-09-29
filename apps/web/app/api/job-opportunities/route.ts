import { JobOpportunityArchiveFilterSchema } from "@job-copilot/contracts/job-opportunity-archives";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return new Response(null, { status: 401, headers: noStore });
  const params = new URL(request.url).searchParams;
  const filter = JobOpportunityArchiveFilterSchema.safeParse(params.get("filter") ?? "active");
  const cursor = params.get("cursor") ?? undefined;
  if (!filter.success) return new Response(null, { status: 400, headers: noStore });
  try { return Response.json(await api.listJobOpportunities(sessionToken, filter.data, cursor), { headers: noStore }); }
  catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return new Response(null, { status: status === 401 || status === 404 ? status : 502, headers: noStore });
  }
}
