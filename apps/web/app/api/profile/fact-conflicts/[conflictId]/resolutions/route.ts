import { ResolveCareerFactConflictCommandSchema } from "@job-copilot/contracts/career-import";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type Context = { params: Promise<{ conflictId: string }> };
const noStore = { "Cache-Control": "no-store" };
const empty = (status: number) => new Response(null, { status, headers: noStore });

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { conflictId } = await params;
  const token = await readSessionToken();
  if (!token) return empty(401);
  if (!z.uuid().safeParse(conflictId).success) return empty(404);
  const command = ResolveCareerFactConflictCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) return empty(400);
  try {
    return Response.json(await api.resolveCareerFactConflict(token, conflictId, command.data), { headers: noStore });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return empty(status === 401 || status === 404 || status === 409 || status === 400 ? status : 502);
  }
}
