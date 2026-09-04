import type { Database } from "@job-copilot/database";
import { createDeepMatchQueries } from "./deep-match-persistence";

/** Public read-only recommendation boundary. Matching invocation and staging stay processor-private. */
export function createRecommendationQueries(deps: { db: Database }) {
  const queries = createDeepMatchQueries(deps);
  return {
    getLatestList: queries.getLatestList,
    getListHistoryPage: queries.getListHistoryPage,
    getListExclusionsPage: queries.getListExclusionsPage,
  };
}
