import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(_request: Request, { params }: { params: Promise<{ exportId: string }> }): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return new Response(null, { status: 401, headers: noStore });
  const { exportId } = await params;
  if (!z.uuid().safeParse(exportId).success) return new Response(null, { status: 400, headers: noStore });
  try {
    const response = await api.downloadJobExport(token, exportId);
    return new Response(response.body, { headers: { ...noStore, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="job-opportunities-${exportId}.csv"` } });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
    return new Response(null, { status: [401, 404, 409, 410, 503].includes(status) ? status : 502, headers: noStore });
  }
}
