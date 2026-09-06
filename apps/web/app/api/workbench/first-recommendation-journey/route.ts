import {
  FirstRecommendationJourneyInteractionCommandSchema,
  FirstRecommendationJourneyInteractionSchema,
} from "@job-copilot/contracts/workbench";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };
const empty = (status: number) => new Response(null, { status, headers: noStore });

export async function PUT(request: Request): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return empty(401);

  const command = FirstRecommendationJourneyInteractionCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) return empty(400);

  try {
    const interaction = FirstRecommendationJourneyInteractionSchema.parse(
      await api.updateFirstRecommendationJourneyInteraction(sessionToken, command.data),
    );
    return Response.json(interaction, { headers: noStore });
  } catch (error) {
    return empty(safeStatus(error));
  }
}

function safeStatus(error: unknown): number {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : 502;
  return status === 401 || status === 404 || status === 409 ? status : 502;
}
