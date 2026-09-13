import { Buffer } from "node:buffer";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jobProfiles, type Database } from "@job-copilot/database";
import { AgentRunBudgetSchema, AgentRunExecutionSpecSchema } from "@job-copilot/contracts/agent-runs";
import { RecommendationRunPreparationSchema, type RecommendationRunPreparation } from "@job-copilot/contracts/recommendation-runs";
import { RunPreflightReportSchema } from "@job-copilot/contracts/run-preflight";
import { JobTargetConstraintsSchema } from "@job-copilot/contracts/job-targets";
import { discoverySourceScopeCounts, type DiscoveryTargetSnapshot } from "./agent-run-discovery-spec";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { JobDiscoveryExecutionMode } from "./job-discovery-execution-mode";
import type { RunPreflightEvaluator } from "./run-preflight";

const RecommendationContextSchema = z.object({
  version: z.literal("recommendation-context-v1"),
  profile: z.object({ profileId: z.uuid(), profileVersion: z.int().min(1) }).strict(),
  budgets: z.object({ discovery: AgentRunBudgetSchema, deepMatch: AgentRunBudgetSchema }).strict(),
  preflight: RunPreflightReportSchema,
  accountPolicyRevisionNumber: z.int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.preflight.workflow !== "recommendation") context.addIssue({ code: "custom", path: ["preflight", "workflow"], message: "推荐上下文必须绑定推荐运行前检查" });
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 32 * 1024) context.addIssue({ code: "custom", message: "推荐上下文不能超过 32KiB" });
});

export type RecommendationRunStartSpec = { targetId: string; targetVersion: number; targetSnapshot: DiscoveryTargetSnapshot; executionSpec: z.infer<typeof AgentRunExecutionSpecSchema>; accountPolicySnapshot: unknown };
export type RecommendationRunContext = z.infer<typeof RecommendationContextSchema>;
export type RecommendationRunPreparationResult = { preparation: RecommendationRunPreparation; startSpec: RecommendationRunStartSpec | null; recommendationContext: RecommendationRunContext | null };

export async function prepareRecommendationRunInTransaction(transaction: any, input: { userId: string; executionMode: JobDiscoveryExecutionMode }, deps: { runPreflight: RunPreflightEvaluator; id: () => string; clock: () => Date }): Promise<RecommendationRunPreparationResult> {
  const evaluation = await deps.runPreflight.evaluate(transaction, { userId: input.userId, workflow: "recommendation", trigger: "manual" });
  const budgets = { discovery: input.executionMode === "fake" ? evaluation.policy.snapshot.budgets.fake : evaluation.policy.snapshot.budgets.publicDiscovery, deepMatch: evaluation.policy.snapshot.budgets.deepMatch };
  const plan = evaluation.recommendationPlan;
  if (!plan) return { preparation: RecommendationRunPreparationSchema.parse({ target: null, sourceScope: { trustedSourceCount: 0, publicQueryCount: 0 }, accountPolicyRevisionNumber: evaluation.policy.revisionNumber, budgets, preflight: evaluation.report }), startSpec: null, recommendationContext: null };
  const { targetSnapshot, discoverySpec: spec } = plan;
  const constraints = JobTargetConstraintsSchema.parse(targetSnapshot.constraints);
  const preparation = RecommendationRunPreparationSchema.parse({ target: { targetId: targetSnapshot.targetId, targetVersion: targetSnapshot.version, roleFamily: constraints.roleFamily }, sourceScope: spec ? discoverySourceScopeCounts(spec.sourceScope, input.executionMode) : { trustedSourceCount: 0, publicQueryCount: 0 }, accountPolicyRevisionNumber: evaluation.policy.revisionNumber, budgets, preflight: evaluation.report });
  if (evaluation.report.status === "blocked" || !spec) return { preparation, startSpec: null, recommendationContext: null };
  const [profile] = await transaction.select({ id: jobProfiles.id, version: jobProfiles.version }).from(jobProfiles).where(eq(jobProfiles.userId, input.userId));
  if (!profile || profile.version < 1) return { preparation, startSpec: null, recommendationContext: null };
  const executionSpec = AgentRunExecutionSpecSchema.parse({ targetSnapshot, ...(spec.profileSnapshot ? { profileSnapshot: spec.profileSnapshot, watchlistSnapshot: spec.watchlistSnapshot } : {}), sourceScope: spec.sourceScope, workflowVersion: spec.execution.workflowVersion, ruleVersion: spec.execution.ruleVersion, adapter: spec.execution.adapter, adapterVersion: spec.execution.adapterVersion, outputSchemaVersion: spec.execution.outputSchemaVersion, toolAllowlist: spec.toolAllowlist, model: null, budget: spec.execution.budget });
  const recommendationContext = RecommendationContextSchema.parse({ version: "recommendation-context-v1", profile: { profileId: profile.id, profileVersion: profile.version }, budgets, preflight: evaluation.report, accountPolicyRevisionNumber: evaluation.policy.revisionNumber });
  return { preparation, startSpec: { targetId: targetSnapshot.targetId, targetVersion: targetSnapshot.version, targetSnapshot, executionSpec, accountPolicySnapshot: evaluation.policy.snapshot }, recommendationContext };
}

export function createRecommendationRunPreparationQueries(deps: { db: Database; runPreflight: RunPreflightEvaluator; executionMode: JobDiscoveryExecutionMode; id: () => string; clock: () => Date }): { prepare(input: { userId: string }): Promise<RecommendationRunPreparation> } {
  return { async prepare(input) { return deps.db.transaction(async (transaction) => { await acquireAccountAdvisoryLock(transaction, input.userId); return (await prepareRecommendationRunInTransaction(transaction, { userId: input.userId, executionMode: deps.executionMode }, deps)).preparation; }); } };
}
