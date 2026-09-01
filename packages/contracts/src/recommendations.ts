import { z } from "zod";

export const RecommendationBandSchema = z.enum(["highly_matched", "worth_trying", "consider_carefully"]);
export const RecommendationItemSchema = z.object({
  matchVersionId: z.uuid(), opportunityId: z.uuid(), company: z.string().nullable(), title: z.string().nullable(), location: z.string().nullable(),
  displayBand: RecommendationBandSchema, highlighted: z.boolean(), ordinal: z.int().min(1).max(10), assessment: z.unknown(),
}).strict();
export const RecommendationListSchema = z.object({
  recommendationListId: z.uuid(), targetId: z.uuid(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), sequence: z.int().min(1), createdAt: z.iso.datetime(), items: z.array(RecommendationItemSchema).max(10),
}).strict();
export const RecommendationListHistorySchema = z.array(z.object({
  recommendationListId: z.uuid(), targetId: z.uuid(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), sequence: z.int().min(1), createdAt: z.iso.datetime(),
}).strict());
export type RecommendationList = z.infer<typeof RecommendationListSchema>;
export type RecommendationListHistory = z.infer<typeof RecommendationListHistorySchema>;
