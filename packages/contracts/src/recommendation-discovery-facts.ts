import { z } from "zod";

const nonnegativeInteger = z.int().nonnegative();

export const RecommendationCoverageLossCodeSchema = z.enum([
  "TRUSTED_SOURCE_UNAVAILABLE",
  "PUBLIC_DISCOVERY_UNAVAILABLE",
  "SOURCE_HEALTH_DEGRADED",
  "SOURCE_CAPABILITY_UNAVAILABLE",
  "VERIFICATION_FAILED",
  "DISCOVERY_BUDGET_EXCEEDED",
]);

const RecommendationDiscoveryLossSchema = z.object({
  code: RecommendationCoverageLossCodeSchema,
  retryable: z.boolean(),
}).strict();

const RecommendationDiscoveryOutcomeSchema = z.enum([
  "credible_results",
  "credible_zero",
  "failed",
  "verification_failed",
]);

const RecommendationDiscoveryBranchSchema = z.object({
  checked: z.boolean(),
  outcome: RecommendationDiscoveryOutcomeSchema,
  losses: z.array(RecommendationDiscoveryLossSchema).max(10).refine(
    (losses) => new Set(losses.map((loss) => `${loss.code}:${loss.retryable}`)).size === losses.length,
    "coverage losses must be unique",
  ),
}).strict().superRefine((branch, context) => {
  if ((branch.outcome === "credible_results" || branch.outcome === "credible_zero") && !branch.checked) {
    context.addIssue({ code: "custom", path: ["checked"], message: "credible branch must be checked" });
  }
  if ((branch.outcome === "failed" || branch.outcome === "verification_failed") && branch.losses.length === 0) {
    context.addIssue({ code: "custom", path: ["losses"], message: "failed branch must retain a coverage loss" });
  }
});

const TrustedBranchSchema = RecommendationDiscoveryBranchSchema.extend({
  sourceId: z.string().trim().min(1).max(2_048),
}).strict();

const PublicQueryBranchSchema = RecommendationDiscoveryBranchSchema.extend({
  queryId: z.uuid(),
}).strict();

export const RecommendationDiscoveryFactsSchema = z.object({
  version: z.literal("recommendation-discovery-facts-v1"),
  trusted: z.array(TrustedBranchSchema).max(50).refine(
    (branches) => new Set(branches.map((branch) => branch.sourceId)).size === branches.length,
    "trusted source identities must be unique",
  ),
  publicQueries: z.array(PublicQueryBranchSchema).max(10).refine(
    (branches) => new Set(branches.map((branch) => branch.queryId)).size === branches.length,
    "public query identities must be unique",
  ),
}).strict();

export const FrozenRecommendationEvidenceSchema = z.object({
  version: z.literal("recommendation-evidence-v1"),
  plannedTrustedSourceCount: nonnegativeInteger,
  plannedPublicQueryCount: nonnegativeInteger,
  discoveryFacts: RecommendationDiscoveryFactsSchema,
  frozenTriageVersionIds: z.array(z.uuid()).max(5).refine(
    (ids) => new Set(ids).size === ids.length,
    "frozen triage version IDs must be unique",
  ),
}).strict().superRefine((evidence, context) => {
  if (evidence.discoveryFacts.trusted.length > evidence.plannedTrustedSourceCount) {
    context.addIssue({ code: "custom", path: ["plannedTrustedSourceCount"], message: "trusted facts cannot exceed planned sources" });
  }
  if (evidence.discoveryFacts.publicQueries.length > evidence.plannedPublicQueryCount) {
    context.addIssue({ code: "custom", path: ["plannedPublicQueryCount"], message: "public facts cannot exceed planned queries" });
  }
});

export type RecommendationDiscoveryFacts = z.infer<typeof RecommendationDiscoveryFactsSchema>;
export type FrozenRecommendationEvidence = z.infer<typeof FrozenRecommendationEvidenceSchema>;
