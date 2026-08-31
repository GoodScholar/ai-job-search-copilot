import type { Database } from "@job-copilot/database";

import { createJobDiscoveryLeadRepository } from "./job-discovery-leads";
import { createLayeredPublicJobDiscoveryWorkflow } from "./layered-public-job-discovery-workflow";
import { createVerifiedJobSourceGate, type VerifiedJobEvidenceStore } from "./verified-job-source-gate";

type WorkflowDependencies = Parameters<typeof createLayeredPublicJobDiscoveryWorkflow>[0];

/**
 * v4 运行时唯一持有 claim-bound Lead/Gate 的组装点；Worker 只能提供外部 I/O ports。
 */
export function createLayeredPublicJobDiscoveryRuntime(input: Omit<WorkflowDependencies, "leads" | "gate"> & {
  db: Database;
  id: () => string;
  evidenceStore: VerifiedJobEvidenceStore;
}) {
  const leads = createJobDiscoveryLeadRepository({ db: input.db, id: input.id });
  const gate = createVerifiedJobSourceGate({ db: input.db, contentStore: input.evidenceStore, id: input.id });
  const { db: _db, id: _id, evidenceStore: _evidenceStore, ...workflowDependencies } = input;
  return createLayeredPublicJobDiscoveryWorkflow({
    ...workflowDependencies,
    leads,
    gate: {
      verifyForClaim: async (value) => {
        const verified = await gate.verifyForClaim({
          userId: value.candidate.userId, leadId: value.candidate.leadId,
          candidate: { queryId: value.candidate.queryId, normalizedUrl: value.candidate.normalizedUrl, candidateFingerprint: value.candidateFingerprint },
          extract: value.extract, page: value.page, claimToken: value.claimToken, now: value.now,
        });
        return { sourcePostingVersionId: verified.sourcePostingVersion.sourcePostingVersionId };
      },
      rejectForClaim: async (value) => {
        await gate.rejectForClaim({ userId: value.candidate.userId, leadId: value.candidate.leadId, code: value.code, claimToken: value.claimToken, now: value.now });
      },
    },
  });
}
