import { RunPreflightReportSchema } from "@job-copilot/contracts/run-preflight";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };
const empty = (status: number) => new Response(null, { status, headers: noStore });
const querySchema = z.object({ targetId: z.uuid().optional() }).strict();

export async function GET(request: Request): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return empty(401);
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "targetId") || parameters.getAll("targetId").length > 1) return empty(400);
  const query = querySchema.safeParse(Object.fromEntries(parameters));
  if (!query.success) return empty(400);
  try { return Response.json(RunPreflightReportSchema.parse(await api.getRunPreflight(sessionToken, query.data.targetId)), { headers: noStore }); }
  catch (error) { return empty(safeStatus(error)); }
}

function safeStatus(error: unknown): number {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
  return status === 400 || status === 401 || status === 404 ? status : 502;
}
