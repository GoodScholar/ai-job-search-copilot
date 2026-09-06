import { and, asc, eq, inArray } from "drizzle-orm";
import {
  agentRuns,
  careerImports,
  firstRecommendationJourneyCompletions,
  firstRecommendationJourneyInteractions,
  jobAccounts,
  type Database,
} from "@job-copilot/database";
import type {
  FirstRecommendationJourney,
  FirstRecommendationJourneyInteraction,
  FirstRecommendationJourneyInteractionCommand,
  FirstRecommendationJourneyStep,
  FirstRecommendationJourneyStepId,
  FirstRecommendationJourneyStepStatus,
} from "@job-copilot/contracts/workbench";
import type { RunPreflightItem, RunPreflightReport, RunPreflightSuggestedAction } from "@job-copilot/contracts/run-preflight";
import type { RunPreflightEvaluator } from "./run-preflight";

export class FirstRecommendationJourneyError extends Error {
  constructor(public readonly code: "ACCOUNT_NOT_FOUND" | "VERSION_CONFLICT" | "JOURNEY_COMPLETED") { super(code); }
}

type InteractionCommandInput = { userId: string; command: FirstRecommendationJourneyInteractionCommand };
type CompletionResult = { kind: "recommendation_list" | "no_recommendations"; resultId: string };
type Action = FirstRecommendationJourneyStep["action"];

export type FirstRecommendationJourneyReader = { get(input: { userId: string }): Promise<FirstRecommendationJourney> };

const stateLabels: Record<FirstRecommendationJourneyStepStatus, string> = {
  completed: "已完成", in_progress: "进行中", needs_action: "需要处理", waiting: "等待开始",
};

const actionFor: Record<RunPreflightSuggestedAction, Action> = {
  review_profile: { label: "完善求职画像", href: "/profile" },
  review_job_targets: { label: "查看求职目标", href: "/profile/targets" },
  review_source_capabilities: { label: "查看来源能力", href: "/profile/targets" },
  review_source_health: { label: "查看来源健康", href: "/profile/targets" },
  run_model_diagnostic: { label: "检查模型连接", href: "/profile/model-connection" },
  review_account_run_policy: { label: "管理运行策略", href: "/profile/run-policy" },
};

function step(id: FirstRecommendationJourneyStepId, title: string, status: FirstRecommendationJourneyStepStatus, impact: string, action: Action): FirstRecommendationJourneyStep {
  return { id, title, status, stateLabel: stateLabels[status], impact, action } as FirstRecommendationJourneyStep;
}

function item(report: RunPreflightReport, code: RunPreflightItem["code"]): RunPreflightItem | undefined {
  return report.items.find((value) => value.code === code);
}

function sourceAction(targetId: string | null): Action {
  return targetId
    ? { label: "配置岗位来源", href: `/profile/targets/${targetId}/watchlist` }
    : { label: "查看求职目标", href: "/profile/targets" };
}

function reportAction(report: RunPreflightReport): Action {
  const firstBlocking = report.items.find((value) => value.severity === "blocking");
  const action = firstBlocking?.suggestedActions[0];
  return action ? actionFor[action] : { label: "完善求职画像", href: "/profile" };
}

async function activeAccount(db: Pick<Database, "select">, userId: string): Promise<void> {
  const [account] = await db.select({ id: jobAccounts.id }).from(jobAccounts)
    .where(and(eq(jobAccounts.id, userId), eq(jobAccounts.status, "active")));
  if (!account) throw new FirstRecommendationJourneyError("ACCOUNT_NOT_FOUND");
}

async function interaction(db: Pick<Database, "select">, userId: string): Promise<FirstRecommendationJourneyInteraction> {
  const [row] = await db.select().from(firstRecommendationJourneyInteractions)
    .where(eq(firstRecommendationJourneyInteractions.userId, userId));
  return {
    version: row?.version ?? 0,
    dismissedAt: row?.dismissedAt?.toISOString() ?? null,
    lastVisitedStep: (row?.lastVisitedStep as FirstRecommendationJourneyStepId | null | undefined) ?? null,
  };
}

async function stepsFor(input: { db: Database; userId: string; report: RunPreflightReport }): Promise<FirstRecommendationJourneyStep[]> {
  const [imports, activeRuns] = await Promise.all([
    input.db.select({ status: careerImports.status }).from(careerImports).where(eq(careerImports.userId, input.userId)),
    input.db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.userId, input.userId), inArray(agentRuns.status, ["queued", "running", "paused"]))).orderBy(asc(agentRuns.queuedAt), asc(agentRuns.id)),
  ]);
  const materials = imports.some((value) => value.status === "completed") ? "completed" : imports.some((value) => value.status === "queued" || value.status === "processing") ? "in_progress" : "needs_action";
  const profile = item(input.report, "PROFILE_EVIDENCE_READY") ? "completed" : "needs_action";
  const target = item(input.report, "PRIMARY_JOB_TARGET_READY") ? "completed" : "needs_action";
  const capability = input.report.items.find((value) => value.evidence.kind === "source_capability");
  const sources = capability?.evidence.kind === "source_capability" && capability.evidence.capableSourceCount > 0 ? "completed" : "needs_action";
  const readiness = input.report.status === "blocked" ? "needs_action" : "completed";
  const prerequisitesComplete = [materials, profile, target, sources, readiness].every((value) => value === "completed");
  const result = activeRuns.length ? "in_progress" : prerequisitesComplete ? "needs_action" : "waiting";
  const targetId = input.report.targetId;
  return [
    step("career_materials", "准备可用职业资料", materials, materials === "completed" ? "职业资料已经可以用于建立求职画像。" : materials === "in_progress" ? "职业资料正在处理中，完成后会自动更新。" : "导入职业资料后，系统才能建立可追溯的求职基础。", { label: "导入职业资料", href: "/profile" }),
    step("profile_evidence", "建立可信求职画像", profile, profile === "completed" ? "可信画像已准备好。" : "确认至少一条画像事实，才能更准确地匹配职位。", { label: "完善求职画像", href: "/profile" }),
    step("primary_target", "明确主要求职方向", target, target === "completed" ? "主要求职方向已明确。" : "设置主要求职方向后，系统才能聚焦推荐。", { label: "查看求职目标", href: "/profile/targets" }),
    step("job_sources", "接通真实岗位来源", sources, sources === "completed" ? "至少一个启用来源具备发现和读取职位详情的能力。" : "接通可执行的岗位来源，才能发现真实职位。", sourceAction(targetId)),
    step("run_readiness", "确认今天可以开始", readiness, input.report.status === "ready_with_warnings" ? input.report.items.find((value) => value.severity === "warning")?.impact ?? "当前条件允许开始推荐。" : readiness === "completed" ? "当前条件允许开始推荐。" : input.report.items.find((value) => value.severity === "blocking")?.impact ?? "请先完成阻塞推荐的准备事项。", reportAction(input.report)),
    step("first_result", "获得第一份推荐结果", result, result === "in_progress" ? "推荐正在生成，请稍后查看结果。" : result === "needs_action" ? "现在可以开始获取第一份推荐结果。" : "请先完成前面的准备事项。", activeRuns[0] ? { label: "查看进行中的推荐", href: `/home?runId=${activeRuns[0].id}#agent-run` } : { label: "开始推荐", href: "/home" }),
  ];
}

function currentStep(steps: FirstRecommendationJourneyStep[], lastVisitedStep: FirstRecommendationJourneyStepId | null): FirstRecommendationJourneyStepId {
  const visited = steps.find((value) => value.id === lastVisitedStep);
  if (visited && visited.status !== "completed") return visited.id;
  const first = steps.find((value) => value.status !== "completed");
  if (!first) throw new Error("未完成旅程必须保留至少一个未完成步骤");
  return first.id;
}

export function createFirstRecommendationJourneyReader(deps: { db: Database; runPreflight: RunPreflightEvaluator }): FirstRecommendationJourneyReader {
  return {
    async get({ userId }) {
      await activeAccount(deps.db, userId);
      const [completion] = await deps.db.select({ completedAt: firstRecommendationJourneyCompletions.completedAt })
        .from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, userId));
      if (completion) return { status: "completed", steps: [], currentStepId: null, completedAt: completion.completedAt.toISOString() };

      const [state, evaluation] = await Promise.all([
        interaction(deps.db, userId),
        deps.runPreflight.evaluate(deps.db, { userId, workflow: "discovery", trigger: "manual" }),
      ]);
      const steps = await stepsFor({ db: deps.db, userId, report: evaluation.report });
      return { status: state.dismissedAt ? "dismissed" : "active", steps, currentStepId: currentStep(steps, state.lastVisitedStep), completedAt: null };
    },
  };
}

export function createFirstRecommendationJourneyCommands(deps: { db: Database; clock: () => Date }): { updateInteraction(input: InteractionCommandInput): Promise<FirstRecommendationJourneyInteraction> } {
  return {
    async updateInteraction(input) {
      return deps.db.transaction(async (transaction) => {
        await activeAccount(transaction, input.userId);
        const [completion] = await transaction.select({ userId: firstRecommendationJourneyCompletions.userId })
          .from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, input.userId));
        if (completion) throw new FirstRecommendationJourneyError("JOURNEY_COMPLETED");
        const [current] = await transaction.select().from(firstRecommendationJourneyInteractions)
          .where(eq(firstRecommendationJourneyInteractions.userId, input.userId));
        const version = current?.version ?? 0;
        if (version !== input.command.expectedVersion) throw new FirstRecommendationJourneyError("VERSION_CONFLICT");
        const next = {
          version: version + 1,
          dismissedAt: input.command.action === "dismiss" ? deps.clock() : current?.dismissedAt ?? null,
          lastVisitedStep: input.command.action === "visit_step" ? input.command.stepId : current?.lastVisitedStep ?? null,
        };
        const [written] = current
          ? await transaction.update(firstRecommendationJourneyInteractions).set(next).where(and(
            eq(firstRecommendationJourneyInteractions.userId, input.userId), eq(firstRecommendationJourneyInteractions.version, version),
          )).returning()
          : await transaction.insert(firstRecommendationJourneyInteractions).values({ userId: input.userId, ...next }).onConflictDoNothing().returning();
        if (!written) throw new FirstRecommendationJourneyError("VERSION_CONFLICT");
        return { version: written.version, dismissedAt: written.dismissedAt?.toISOString() ?? null, lastVisitedStep: written.lastVisitedStep as FirstRecommendationJourneyStepId | null };
      });
    },
  };
}

export async function recordFirstRecommendationJourneyCompletion(
  transaction: Pick<Database, "insert">,
  input: { userId: string; result: CompletionResult; completedAt: Date },
): Promise<void> {
  await transaction.insert(firstRecommendationJourneyCompletions).values({
    userId: input.userId,
    resultKind: input.result.kind,
    resultId: input.result.resultId,
    completedAt: input.completedAt,
  }).onConflictDoNothing({ target: firstRecommendationJourneyCompletions.userId });
}
