import { StartRecommendationRunCommandSchema } from "@job-copilot/contracts/recommendation-runs";
import { ApiProblemSchema } from "@job-copilot/contracts/api-problem";
import { RunPreflightProblemSchema } from "@job-copilot/contracts/run-preflight";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";
const noStore = { "Cache-Control": "no-store" }; const empty = (status: number) => new Response(null, { status, headers: noStore });
export async function POST(request: Request) { const token = await readSessionToken(); if (!token) return empty(401); const command = StartRecommendationRunCommandSchema.safeParse(await request.json().catch(() => null)); if (!command.success) return empty(400); try { const result = await api.startRecommendationRun(token, command.data); return Response.json(result, { status: result.reused ? 200 : 201, headers: noStore }); } catch (error) { const problem = typeof error === "object" && error !== null && "status" in error && error.status === 409 && "problem" in error ? error.problem : null; const parsed = RunPreflightProblemSchema.safeParse(problem).data ?? ApiProblemSchema.safeParse(problem).data; if (parsed?.code === "RUN_PREFLIGHT_BLOCKED" || parsed?.code === "ACCOUNT_RUN_STOPPED") return Response.json(parsed, { status: 409, headers: noStore }); return empty(502); } }
