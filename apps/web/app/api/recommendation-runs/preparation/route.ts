import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";
const noStore = { "Cache-Control": "no-store" };
export async function GET() { const token = await readSessionToken(); if (!token) return new Response(null, { status: 401, headers: noStore }); try { return Response.json(await api.getRecommendationRunPreparation(token), { headers: noStore }); } catch (error) { const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 502; return new Response(null, { status: status === 401 ? 401 : 502, headers: noStore }); } }
