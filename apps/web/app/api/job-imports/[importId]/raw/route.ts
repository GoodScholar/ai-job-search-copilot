import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

type RouteContext = { params: Promise<{ importId: string }> };
const noStore = { "Cache-Control": "no-store" };
const emptyResponse = (status: number) => new Response(null, { status, headers: noStore });

export async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
  const { importId } = await params;
  const sessionToken = await readSessionToken();
  if (!sessionToken) return emptyResponse(401);
  if (!z.uuid().safeParse(importId).success) return emptyResponse(404);

  try {
    const raw = await api.getJobImportRaw(sessionToken, importId);
    return new Response(raw, { headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return emptyResponse(status === 401 || status === 404 ? status : 502);
  }
}
