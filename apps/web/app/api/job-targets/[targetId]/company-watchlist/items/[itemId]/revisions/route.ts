import { CompanyWatchlistOverviewSchema, ReviseCompanyWatchlistItemCommandSchema } from "@job-copilot/contracts/company-watchlists";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };
const problem = (status: number) => Response.json({ code: "COMPANY_WATCHLIST_REQUEST_FAILED" }, { status, headers: noStore });
const safeStatus = (error: unknown) => typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && [400, 401, 404, 409].includes(error.status) ? error.status : 502;

export async function POST(request: Request, { params }: { params: Promise<{ targetId: string; itemId: string }> }): Promise<Response> {
  const { targetId, itemId } = await params;
  if (!z.uuid().safeParse(targetId).success || !z.uuid().safeParse(itemId).success) return problem(404);
  const sessionToken = await readSessionToken();
  if (!sessionToken) return problem(401);
  const command = ReviseCompanyWatchlistItemCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) return problem(400);
  try {
    return Response.json(CompanyWatchlistOverviewSchema.parse(await api.reviseCompanyWatchlistItem(sessionToken, targetId, itemId, command.data)), { status: 201, headers: noStore });
  } catch (error) {
    unstable_rethrow(error);
    return problem(safeStatus(error));
  }
}
