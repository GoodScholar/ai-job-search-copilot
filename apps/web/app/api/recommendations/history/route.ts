import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const querySchema = z.object({ targetId: z.uuid(), cursor: z.uuid().optional() }).strict();
const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return new Response(null, { status: 401, headers: noStore });
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return new Response(null, { status: 400, headers: noStore });
  try {
    return Response.json(await api.getRecommendationHistoryPage(sessionToken, parsed.data.targetId, parsed.data.cursor), { headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return new Response(null, { status: status === 401 || status === 404 ? status : 502, headers: noStore });
  }
}
