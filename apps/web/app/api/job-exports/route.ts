import { JobExportCommandSchema } from "@job-copilot/contracts/job-exports";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "private, no-store" };

function failed(error: unknown): Response {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
  return new Response(null, { status: [401, 409, 503].includes(status) ? status : 502, headers: noStore });
}

export async function GET(): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return new Response(null, { status: 401, headers: noStore });
  try { return Response.json(await api.listJobExports(token), { headers: noStore }); }
  catch (error) { return failed(error); }
}

export async function POST(request: Request): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return new Response(null, { status: 401, headers: noStore });
  const parsed = JobExportCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 400, headers: noStore });
  try { return Response.json(await api.createJobExport(token, parsed.data), { status: 201, headers: noStore }); }
  catch (error) { return failed(error); }
}
