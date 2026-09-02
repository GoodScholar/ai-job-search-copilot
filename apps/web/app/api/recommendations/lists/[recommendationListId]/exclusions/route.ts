import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const querySchema = z.object({ targetId: z.uuid(), cursor: z.uuid().optional() }).strict();
const paramsSchema = z.object({ recommendationListId: z.uuid() }).strict();
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request, { params }: { params: Promise<{ recommendationListId: string }> }): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return new Response(null, { status: 401, headers: noStore });
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  const path = paramsSchema.safeParse(await params);
  if (!query.success || !path.success) return new Response(null, { status: 400, headers: noStore });
  try {
    return Response.json(await api.getRecommendationExclusionsPage(sessionToken, query.data.targetId, path.data.recommendationListId, query.data.cursor), { headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return new Response(null, { status: status === 401 || status === 404 ? status : 502, headers: noStore });
  }
}
