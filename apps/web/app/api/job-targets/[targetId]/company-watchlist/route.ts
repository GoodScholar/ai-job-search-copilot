import { CompanyWatchlistOverviewSchema } from "@job-copilot/contracts/company-watchlists";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { api } from "@/lib/server/api-client";
import { readSessionToken } from "@/lib/server/session-cookie";

const noStore = { "Cache-Control": "no-store" };
const problem = (status: number) => Response.json({ code: "COMPANY_WATCHLIST_REQUEST_FAILED" }, { status, headers: noStore });
const safeStatus = (error: unknown) => typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && [400, 401, 404, 409].includes(error.status) ? error.status : 502;

export async function GET(_request: Request, { params }: { params: Promise<{ targetId: string }> }): Promise<Response> {
  const { targetId } = await params;
  if (!z.uuid().safeParse(targetId).success) return problem(404);
  const sessionToken = await readSessionToken();
  if (!sessionToken) return problem(401);
  try {
    return Response.json(CompanyWatchlistOverviewSchema.parse(await api.getCompanyWatchlist(sessionToken, targetId)), { headers: noStore });
  } catch (error) {
    unstable_rethrow(error);
    return problem(safeStatus(error));
  }
}
