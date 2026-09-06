import { z } from "zod";

const summaryCount = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const chineseDisplayText = (maxLength: number) => z.string().trim().min(1).max(maxLength).regex(/[\u3400-\u9fff]/u);
const firstRecommendationJourneyStepIds = [
  "career_materials", "profile_evidence", "primary_target", "job_sources", "run_readiness", "first_result",
] as const;

export const FirstRecommendationJourneyStepIdSchema = z.enum(firstRecommendationJourneyStepIds);
export const FirstRecommendationJourneyStepStatusSchema = z.enum(["completed", "in_progress", "needs_action", "waiting"]);

const firstRecommendationJourneyActionSchema = z.object({
  label: chineseDisplayText(80),
  href: z.string().regex(/^\/(?!\/)/u),
}).strict();

const stepFor = (id: z.infer<typeof FirstRecommendationJourneyStepIdSchema>, title: string) => z.object({
  id: z.literal(id),
  title: chineseDisplayText(80).refine((value) => value === title),
  status: FirstRecommendationJourneyStepStatusSchema,
  stateLabel: chineseDisplayText(40),
  impact: chineseDisplayText(500),
  action: firstRecommendationJourneyActionSchema,
}).strict();

export const FirstRecommendationJourneyStepSchema = z.discriminatedUnion("id", [
  stepFor("career_materials", "准备可用职业资料"),
  stepFor("profile_evidence", "建立可信求职画像"),
  stepFor("primary_target", "明确主要求职方向"),
  stepFor("job_sources", "接通真实岗位来源"),
  stepFor("run_readiness", "确认今天可以开始"),
  stepFor("first_result", "获得第一份推荐结果"),
]);

const activeJourneyStepsSchema = z.array(FirstRecommendationJourneyStepSchema)
  .length(firstRecommendationJourneyStepIds.length)
  .superRefine((steps, context) => {
    for (const [index, stepId] of firstRecommendationJourneyStepIds.entries()) {
      if (steps[index]?.id !== stepId) {
        context.addIssue({ code: "custom", path: [index, "id"], message: "steps must follow the fixed first recommendation journey order" });
      }
    }
  });

const activeJourneySchema = (status: "active" | "dismissed") => z.object({
  status: z.literal(status),
  steps: activeJourneyStepsSchema,
  currentStepId: FirstRecommendationJourneyStepIdSchema,
  completedAt: z.null(),
}).strict().superRefine((journey, context) => {
  if (!journey.steps.some((step) => step.id === journey.currentStepId && step.status !== "completed")) {
    context.addIssue({ code: "custom", path: ["currentStepId"], message: "current step must be unfinished" });
  }
});

export const FirstRecommendationJourneySchema = z.discriminatedUnion("status", [
  activeJourneySchema("active"),
  activeJourneySchema("dismissed"),
  z.object({
    status: z.literal("completed"),
    steps: z.tuple([]),
    currentStepId: z.null(),
    completedAt: z.iso.datetime(),
  }).strict(),
]);

export const FirstRecommendationJourneyInteractionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("visit_step"), stepId: FirstRecommendationJourneyStepIdSchema, expectedVersion: z.int().nonnegative() }).strict(),
  z.object({ action: z.literal("dismiss"), expectedVersion: z.int().nonnegative() }).strict(),
]);

export const FirstRecommendationJourneyInteractionSchema = z.object({
  version: z.int().nonnegative(),
  dismissedAt: z.iso.datetime().nullable(),
  lastVisitedStep: FirstRecommendationJourneyStepIdSchema.nullable(),
}).strict();

export const WorkbenchHomeSchema = z.object({
  account: z.object({ userId: z.string().uuid() }).strict(),
  summary: z.object({
    todayRecommendations: summaryCount,
    pendingFacts: summaryCount,
    activeAgentRuns: summaryCount,
    failedAgentRuns: summaryCount,
    sourceFailures: summaryCount,
    pendingDecisions: summaryCount,
    applications: z.literal(0),
    applicationsAvailable: z.literal(false),
  }).strict(),
  firstRecommendationJourney: FirstRecommendationJourneySchema.nullable(),
}).strict();

export type FirstRecommendationJourneyStepId = z.infer<typeof FirstRecommendationJourneyStepIdSchema>;
export type FirstRecommendationJourneyStepStatus = z.infer<typeof FirstRecommendationJourneyStepStatusSchema>;
export type FirstRecommendationJourneyStep = z.infer<typeof FirstRecommendationJourneyStepSchema>;
export type FirstRecommendationJourney = z.infer<typeof FirstRecommendationJourneySchema>;
export type FirstRecommendationJourneyInteractionCommand = z.infer<typeof FirstRecommendationJourneyInteractionCommandSchema>;
export type FirstRecommendationJourneyInteraction = z.infer<typeof FirstRecommendationJourneyInteractionSchema>;
export type WorkbenchHome = z.infer<typeof WorkbenchHomeSchema>;
