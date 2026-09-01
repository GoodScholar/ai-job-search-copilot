import { z } from "zod";
import { DeepMatchAssessmentSchema } from "./deep-match";

export const RecommendationBandSchema = z.enum(["highly_matched", "worth_trying", "consider_carefully"]);
const RecommendationEvidenceSchema = z.object({ id: z.string().min(1), value: z.string().min(1) }).strict();
export const RecommendationExclusionSchema = z.object({ opportunityId: z.uuid(), reasonCode: z.enum(["TRIAGE_NOT_PASS", "DEADLINE_EXPIRED", "SCORE_BELOW_THRESHOLD", "CANDIDATE_LIMIT", "MATCH_QUALITY_INSUFFICIENT"]) }).strict();
export const RecommendationItemSchema = z.object({
  matchVersionId: z.uuid(), opportunityId: z.uuid(), company: z.string().nullable(), title: z.string().nullable(), location: z.string().nullable(),
  displayBand: RecommendationBandSchema, highlighted: z.boolean(), ordinal: z.int().min(1).max(10), jobEvidence: z.array(RecommendationEvidenceSchema).max(20), profileEvidence: z.array(RecommendationEvidenceSchema).max(20), assessment: DeepMatchAssessmentSchema,
}).strict();
export const RecommendationListSchema = z.object({
  recommendationListId: z.uuid(), targetId: z.uuid(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), sequence: z.int().min(1), createdAt: z.iso.datetime(), exclusions: z.array(RecommendationExclusionSchema).max(10), items: z.array(RecommendationItemSchema).max(10),
}).strict();
/** Historical versions carry the same frozen details as the latest list. */
export const RecommendationListHistorySchema = z.array(RecommendationListSchema);
export type RecommendationList = z.infer<typeof RecommendationListSchema>;
export type RecommendationListHistory = z.infer<typeof RecommendationListHistorySchema>;
