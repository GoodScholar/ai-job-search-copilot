import { ModelDiagnosticPublicResponseSchema } from "@job-copilot/contracts/model-diagnostics";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };
const maxBodyBytes = 64;
const empty = (status: number) => new Response(null, { status, headers: noStore });

export async function GET(): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return empty(401);
  try {
    return Response.json(ModelDiagnosticPublicResponseSchema.parse(await api.getModelDiagnostics(sessionToken)), { headers: noStore });
  } catch (error) {
    return empty(safeStatus(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  const sessionToken = await readSessionToken();
  if (!sessionToken) return empty(401);
  if (!(await isEmptyBody(request))) return empty(400);
  try {
    return Response.json(ModelDiagnosticPublicResponseSchema.parse(await api.runModelDiagnostics(sessionToken)), { headers: noStore });
  } catch (error) {
    return empty(safeStatus(error));
  }
}

async function isEmptyBody(request: Request): Promise<boolean> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBodyBytes)) return false;
  let raw = "";
  try {
    if (request.body) {
      const reader = request.body.getReader(); const decoder = new TextDecoder(); let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBodyBytes) { await reader.cancel(); return false; }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    }
  } catch { return false; }
  if (!raw.trim()) return true;
  const parsed = (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })();
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
}

function safeStatus(error: unknown): number {
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502;
  return status === 400 || status === 401 ? status : 502;
}
