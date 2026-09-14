import type { WorkbenchHome } from "@job-copilot/contracts/workbench";
import type { JobTargetOverview } from "@job-copilot/contracts/job-targets";
import { WorkbenchHomeView } from "@/components/workbench/workbench-home-view";
import { unstable_rethrow } from "next/navigation";
import { getWorkbenchHome } from "@/lib/server/workbench";
import { getJobTargets } from "@/lib/server/job-targets";
import { getAgentRun, getLatestAgentRun } from "@/lib/server/agent-runs";
import { getOpenAgentInbox } from "@/lib/server/agent-inbox";
import { getRunPreflight } from "@/lib/server/run-preflight";
import { getLatestRecommendationRun, getRecommendationRun, getRecommendationRunPreparation } from "@/lib/server/recommendation-runs";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "工作台 | AI Job Search Copilot" };

type WorkbenchHomePageProps = { searchParams: Promise<{ runId?: string | string[] }> };
type UnavailableSection = "summary" | "targets" | "run" | "inbox" | "preflight" | "recommendationPreparation" | "recommendationRun";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function valueOr<T>(result: PromiseSettledResult<T>, fallback: T, section: UnavailableSection, unavailable: UnavailableSection[]): T {
  if (result.status === "fulfilled") return result.value;
  unstable_rethrow(result.reason);
  unavailable.push(section);
  return fallback;
}

export default async function WorkbenchHomePage({ searchParams }: WorkbenchHomePageProps = { searchParams: Promise.resolve({}) }) {
  const requestedRunId = (await searchParams).runId;
  const hasRequestedRun = requestedRunId !== undefined;
  const hasValidRequestedRun = typeof requestedRunId === "string" && uuid.test(requestedRunId);
  const recommendationRunPromise = hasValidRequestedRun
    ? getRecommendationRun(requestedRunId)
    : hasRequestedRun ? Promise.resolve(null) : getLatestRecommendationRun();
  const runPromise = hasValidRequestedRun
    ? recommendationRunPromise.then((logicalRun) => logicalRun === null ? getAgentRun(requestedRunId) : null)
    : hasRequestedRun ? Promise.resolve(null) : getLatestAgentRun().then((response) => response.run);
  const recommendationPreparationPromise = getRecommendationRunPreparation();
  const targetsPromise = getJobTargets();
  const preflightPromise = targetsPromise.then((targets) => getRunPreflight(targets.targets.find((target) => target.state === "active" && target.priority === "primary")?.targetId));
  const [homeResult, targetsResult, runResult, inboxResult, preflightResult, recommendationPreparationResult, recommendationRunResult] = await Promise.allSettled([
    getWorkbenchHome(), targetsPromise, runPromise, getOpenAgentInbox(), preflightPromise, recommendationPreparationPromise, recommendationRunPromise,
  ]);
  const unavailable: UnavailableSection[] = [];
  const home = valueOr<WorkbenchHome | null>(homeResult, null, "summary", unavailable);
  const targets = valueOr<JobTargetOverview | null>(targetsResult, null, "targets", unavailable);
  const initialRun = valueOr(runResult, null, "run", unavailable);
  const inbox = valueOr(inboxResult, { items: [] }, "inbox", unavailable);
  const preflight = valueOr(preflightResult, null, "preflight", unavailable);
  const initialRecommendationPreparation = valueOr(recommendationPreparationResult, null, "recommendationPreparation", unavailable);
  const initialRecommendationRun = valueOr(recommendationRunResult, null, "recommendationRun", unavailable);

  return <WorkbenchHomeView home={home} inbox={inbox} initialRecommendationPreparation={initialRecommendationPreparation} initialRecommendationRun={initialRecommendationRun} initialRun={initialRun} preflight={preflight} targets={targets} unavailableSections={unavailable} />;
}
