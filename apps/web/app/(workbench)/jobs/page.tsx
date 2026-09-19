import { JobOpportunitiesView } from "@/components/workbench/job-opportunities-view";
import { getJobOpportunities } from "@/lib/server/job-opportunities";
import { JobOpportunityArchiveFilterSchema } from "@job-copilot/contracts/job-opportunity-archives";

export default async function JobOpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const filter = JobOpportunityArchiveFilterSchema.safeParse(params.filter).data ?? "active";
  return <JobOpportunitiesView initialFilter={filter} initialPage={await getJobOpportunities(filter)} />;
}
