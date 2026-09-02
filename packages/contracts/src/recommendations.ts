import { z } from "zod";
import { DeepMatchAssessmentSchema } from "./deep-match";

export const RecommendationBandSchema = z.enum(["highly_matched", "worth_trying", "consider_carefully"]);
const RecommendationJobEvidenceSchema = z.object({ id: z.string().min(1), value: z.string().min(1) }).strict();
const RecommendationProfileEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().min(1), value: z.string().min(1), kind: z.literal("profile_fact"), profileFactRevisionId: z.uuid() }).strict(),
  z.object({ id: z.string().min(1), value: z.string().min(1), kind: z.literal("target_revision"), targetRevisionId: z.uuid() }).strict(),
]);
export const RecommendationExclusionSchema = z.object({ opportunityId: z.uuid(), reasonCode: z.enum(["TRIAGE_NOT_PASS", "DEADLINE_EXPIRED", "SCORE_BELOW_THRESHOLD", "CANDIDATE_LIMIT", "MATCH_QUALITY_INSUFFICIENT"]) }).strict();
export const RecommendationItemSchema = z.object({
  matchVersionId: z.uuid(), opportunityId: z.uuid(), company: z.string().nullable(), title: z.string().nullable(), location: z.string().nullable(),
  displayBand: RecommendationBandSchema, highlighted: z.boolean(), ordinal: z.int().min(1).max(10), jobEvidence: z.array(RecommendationJobEvidenceSchema).max(20), profileEvidence: z.array(RecommendationProfileEvidenceSchema).max(20), assessment: DeepMatchAssessmentSchema,
}).strict();
export const RecommendationListSchema = z.object({
  recommendationListId: z.uuid(), targetId: z.uuid(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), sequence: z.int().min(1), createdAt: z.iso.datetime(), exclusions: z.array(RecommendationExclusionSchema), exclusionsNextCursor: z.uuid().nullable().optional(), items: z.array(RecommendationItemSchema).max(10),
}).strict();
/** Historical versions carry the same frozen details as the latest list. */
export const RecommendationListHistorySchema = z.array(RecommendationListSchema);
/** Cursor values are immutable list/exclusion ids and are always scoped by the owning query. */
export const RecommendationListHistoryPageSchema = z.object({
  items: z.array(RecommendationListSchema),
  nextCursor: z.uuid().nullable(),
}).strict();
export const RecommendationExclusionPageSchema = z.object({
  items: z.array(RecommendationExclusionSchema),
  nextCursor: z.uuid().nullable(),
}).strict();
export type RecommendationList = z.infer<typeof RecommendationListSchema>;
export type RecommendationListHistory = z.infer<typeof RecommendationListHistorySchema>;
export type RecommendationListHistoryPage = z.infer<typeof RecommendationListHistoryPageSchema>;
export type RecommendationExclusionPage = z.infer<typeof RecommendationExclusionPageSchema>;
