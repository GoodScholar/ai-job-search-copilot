import { z } from "zod";
import {
  AgentRunExecutionSpecSchema,
} from "@job-copilot/contracts/agent-runs";
import {
  LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION,
  LayeredPublicJobDiscoveryQuerySchema,
} from "@job-copilot/contracts/job-discovery";

const InputSchema = z.object({ runId: z.uuid(), executionSpec: AgentRunExecutionSpecSchema }).strict();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);

type LayeredSpec = Extract<z.infer<typeof AgentRunExecutionSpecSchema>, { workflowVersion: "layered-public-job-discovery-v1" }>;
type LayeredPublicJobDiscoveryQuery = z.infer<typeof LayeredPublicJobDiscoveryQuerySchema>;
type Candidate = { normalizedUrl: string; stableFingerprint: string };

/**
 * v4 领域编排 seam：仅接受完整冻结的执行规格；provider URL 保持在 adapter 内，领域结果只携带
 * 可审计的 query/稳定指纹。生产 resolver/config 由 Slice 8 注入。
 */
export function createLayeredPublicJobDiscoveryWorkflow(deps: {
  trustedSources: { discover(input: { runId: string; executionSpec: LayeredSpec }): Promise<{ verifiedSourcePostingVersionIds: string[] }> };
  anySearch: { search(input: { runId: string; executionSpec: LayeredSpec; query: LayeredPublicJobDiscoveryQuery }): Promise<{ candidates: Candidate[] }> };
}) {
  return {
    async run(input: unknown) {
      const value = InputSchema.parse(input);
      if (value.executionSpec.workflowVersion !== LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION) throw new Error("LAYERED_PUBLIC_WORKFLOW_SPEC_REQUIRED");
      if (value.executionSpec.sourceScope.kind !== "layered_public") throw new Error("LAYERED_PUBLIC_WORKFLOW_SCOPE_REQUIRED");
      const executionSpec = value.executionSpec;
      const trusted = await deps.trustedSources.discover({ runId: value.runId, executionSpec });
      const candidates: Array<{ queryId: string; kind: LayeredPublicJobDiscoveryQuery["kind"]; stableFingerprint: string }> = [];
      for (const query of executionSpec.sourceScope.publicDiscovery.queries) {
        const response = await deps.anySearch.search({ runId: value.runId, executionSpec, query });
        for (const candidate of response.candidates.slice(0, query.resultLimit)) {
          if (fingerprint.safeParse(candidate.stableFingerprint).success) candidates.push({ queryId: query.queryId, kind: query.kind, stableFingerprint: candidate.stableFingerprint });
        }
      }
      return { verifiedSourcePostingVersionIds: trusted.verifiedSourcePostingVersionIds, candidates, diagnostics: [] as Array<never> };
    },
  };
}
