import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { agentRuns, auditEvents, careerImports, firstRecommendationJourneyCompletions, jobAccounts, journeyMetricEnrollments, journeyMetricEvents, type Database } from "@job-copilot/database";
import { JourneyMetricEventSchema, JourneyMetricReasonSchema, type JourneyMetricEvent, type JourneyMetricReason } from "@job-copilot/contracts/journey-metrics";
import { DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION, FAKE_JOB_DISCOVERY_WORKFLOW_VERSION, GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/agent-runs";
import { LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION } from "@job-copilot/contracts/job-discovery";
import { createFirstRecommendationJourneyReader } from "./first-recommendation-journey";
import type { RunPreflightEvaluator } from "./run-preflight";

const twentyMinutes = 20 * 60_000;
type Enrollment = typeof journeyMetricEnrollments.$inferSelect;

export function createJourneyMetrics(deps: { db: Database; clock: () => Date; runPreflight: RunPreflightEvaluator }) {
  async function append(enrollment: Enrollment, startedAt: Date, key: string, input: Pick<JourneyMetricEvent, "type" | "stage"> & { at: Date; terminalStatus?: JourneyMetricEvent["terminalStatus"]; reasonCode?: JourneyMetricReason }) {
    const event = JourneyMetricEventSchema.parse({
      version: "first-recommendation-metrics-v1", journeyId: enrollment.journeyId,
      eventKey: createHash("sha256").update(`${enrollment.journeyId}:${key}`).digest("hex"),
      type: input.type, stage: input.stage, occurredAt: input.at.toISOString(),
      elapsedMs: Math.max(0, input.at.getTime() - startedAt.getTime()),
      terminalStatus: input.terminalStatus ?? null, reasonCode: input.reasonCode ?? null,
      configuration: enrollment.configuration,
    });
    await deps.db.insert(journeyMetricEvents).values({ eventKey: event.eventKey, journeyId: event.journeyId, event }).onConflictDoNothing();
  }
  async function observe(enrollment: Enrollment): Promise<void> {
    const [login] = await deps.db.select({ at: auditEvents.occurredAt }).from(auditEvents)
      .where(and(eq(auditEvents.userId, enrollment.userId), eq(auditEvents.eventType, "auth.session_started")))
      .orderBy(asc(auditEvents.occurredAt)).limit(1);
    if (!login) return;
    const startedAt = login.at;
    await append(enrollment, startedAt, "started", { type: "started", stage: "career_materials", at: startedAt });
    const now = deps.clock();
    const [completion] = await deps.db.select({ kind: firstRecommendationJourneyCompletions.resultKind, at: firstRecommendationJourneyCompletions.completedAt })
      .from(firstRecommendationJourneyCompletions).where(eq(firstRecommendationJourneyCompletions.userId, enrollment.userId));
    const runs = await deps.db.select({ id: agentRuns.id, status: agentRuns.status, failedAt: agentRuns.failedAt, cancelledAt: agentRuns.cancelledAt, failureCode: agentRuns.failureCode })
      .from(agentRuns).where(and(eq(agentRuns.userId, enrollment.userId), inArray(agentRuns.workflowVersion, [FAKE_JOB_DISCOVERY_WORKFLOW_VERSION, GREENHOUSE_JOB_DISCOVERY_WORKFLOW_VERSION, LAYERED_PUBLIC_JOB_DISCOVERY_WORKFLOW_VERSION, DEEP_MATCH_AGENT_RUN_WORKFLOW_VERSION])));
    for (const run of runs) {
      const at = run.failedAt ?? run.cancelledAt;
      if (!at || at < startedAt || (completion && at > completion.at)) continue;
      const known: Record<string, JourneyMetricReason> = { AGENT_RUN_BUDGET_EXCEEDED: "RUN_BUDGET_EXCEEDED", AGENT_RUN_MODEL_AUTH_FAILED: "MODEL_AUTH_FAILED", AGENT_RUN_MODEL_POLICY_REJECTED: "MODEL_POLICY_REJECTED" };
      await append(enrollment, startedAt, `terminated:${run.id}`, { type: "terminated", stage: "first_result", at,
        terminalStatus: run.status === "cancelled" ? "cancelled" : "failed",
        reasonCode: run.status === "cancelled" ? "RUN_CANCELLED" : known[run.failureCode ?? ""] ?? "UNKNOWN_BLOCKER" });
    }
    if (completion) {
      await append(enrollment, startedAt, "completed", { type: "completed", stage: "first_result", at: completion.at, terminalStatus: completion.kind as "recommendation_list" | "no_recommendations" });
      return;
    }
    const evaluation = await deps.runPreflight.evaluate(deps.db, { userId: enrollment.userId, workflow: "discovery", trigger: "manual" });
    const reader = createFirstRecommendationJourneyReader({ db: deps.db, runPreflight: { evaluate: async () => evaluation } });
    const journey = await reader.get({ userId: enrollment.userId });
    // 读取过程中发布器可能完成旅程；不可变完成事实保证这次重读会直接返回。
    if (journey.status === "completed") return observe(enrollment);
    for (const step of journey.steps) {
      if (step.status === "completed") await append(enrollment, startedAt, `stage:${step.id}`, { type: "stage_reached", stage: step.id, at: now });
    }
    const blocking = evaluation.report.items.filter((item) => item.severity === "blocking");
    for (const item of blocking) {
      const parsed = JourneyMetricReasonSchema.safeParse(item.code);
      const reasonCode = parsed.success ? parsed.data : "UNKNOWN_BLOCKER";
      await append(enrollment, startedAt, `blocked:${reasonCode}`, { type: "blocked", stage: "run_readiness", reasonCode, at: now });
    }
    const materials = journey.steps.find((step) => step.id === "career_materials");
    if (materials?.status === "needs_action") {
      const [failedImport] = await deps.db.select({ at: careerImports.failedAt }).from(careerImports)
        .where(and(eq(careerImports.userId, enrollment.userId), eq(careerImports.status, "failed"))).orderBy(asc(careerImports.failedAt)).limit(1);
      const reasonCode = failedImport ? "CAREER_IMPORT_FAILED" : "CAREER_MATERIALS_MISSING";
      await append(enrollment, startedAt, `blocked:${reasonCode}`, { type: "blocked", stage: "career_materials", reasonCode, at: failedImport?.at ?? now });
    }
  }
  async function events(): Promise<JourneyMetricEvent[]> {
    const rows = await deps.db.select({ event: journeyMetricEvents.event }).from(journeyMetricEvents);
    return rows.map((row) => JourneyMetricEventSchema.parse(row.event)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.eventKey.localeCompare(b.eventKey));
  }
  return {
    /** 只供受信任运营入口登记邀请名单和当时已核验的部署配置，不是浏览器埋点接口。 */
    async enroll(input: { userId: string; configuration: "valid" | "invalid" }): Promise<string> {
      const [account] = await deps.db.select({ id: jobAccounts.id }).from(jobAccounts).where(and(eq(jobAccounts.id, input.userId), eq(jobAccounts.status, "active")));
      if (!account) throw new Error("JOURNEY_METRIC_ACCOUNT_NOT_FOUND");
      await deps.db.insert(journeyMetricEnrollments).values(input).onConflictDoNothing();
      const [row] = await deps.db.select().from(journeyMetricEnrollments).where(eq(journeyMetricEnrollments.userId, input.userId));
      if (row!.configuration !== input.configuration) throw new Error("JOURNEY_METRIC_ENROLLMENT_IMMUTABLE");
      return row!.journeyId;
    },
    async collect(): Promise<void> {
      const enrollments = await deps.db.select().from(journeyMetricEnrollments);
      let failed = false;
      for (const enrollment of enrollments) {
        try { await observe(enrollment); } catch { failed = true; }
      }
      if (failed) throw new Error("JOURNEY_METRIC_COLLECTION_FAILED");
    },
    events,
    async summary() {
      const all = await events();
      const starts = all.filter((event) => event.type === "started" && event.configuration === "valid");
      const evaluated = starts.filter((start) => deps.clock().getTime() - Date.parse(start.occurredAt) >= twentyMinutes);
      const successes = evaluated.filter((start) => all.some((event) => event.journeyId === start.journeyId && event.type === "completed" && event.elapsedMs <= twentyMinutes));
      return { eligibleJourneys: starts.length, evaluatedJourneys: evaluated.length, pendingJourneys: starts.length - evaluated.length,
        completedWithin20Minutes: successes.length, missed20MinuteTarget: evaluated.length - successes.length, completionRate: evaluated.length ? successes.length / evaluated.length : null,
        invalidConfigurationJourneys: all.filter((event) => event.type === "started" && event.configuration === "invalid").length,
        knownBlockedJourneys: evaluated.filter((start) => all.some((event) => event.journeyId === start.journeyId && event.reasonCode !== null && event.reasonCode !== "UNKNOWN_BLOCKER")).length,
        unknownBlockedJourneys: evaluated.filter((start) => all.some((event) => event.journeyId === start.journeyId && event.reasonCode === "UNKNOWN_BLOCKER")).length,
      };
    },
  };
}
