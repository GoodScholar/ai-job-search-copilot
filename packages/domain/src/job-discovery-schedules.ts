import { and, eq, sql } from "drizzle-orm";
import {
  companyWatchlistRevisions,
  companyWatchlists,
  agentRuns,
  jobDiscoveryScheduleOccurrences,
  jobDiscoverySchedules,
  jobProfiles,
  jobTargets,
  type Database,
} from "@job-copilot/database";
import {
  JobDiscoveryScheduleOccurrenceSchema,
  JobDiscoveryScheduleSchema,
  SetJobDiscoveryScheduleCommandSchema,
  JobDiscoveryScheduleResponseSchema,
  type JobDiscoverySchedule,
  type JobDiscoveryScheduleResponse,
  type JobDiscoverySourceSupport,
  type JobDiscoveryScheduleOccurrence,
  type SetJobDiscoveryScheduleCommand,
} from "@job-copilot/contracts/job-discovery-schedules";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import { AgentRunError, type AgentRunStarter } from "./agent-run-control";
import type { AuditTrail } from "./audit-trail";
import { analyzePublicJobDiscoverySources } from "./public-job-discovery-sources";
import { applyTransactionDeadline } from "./transaction-deadline";
import type { JobDiscoveryExecutionMode } from "./job-discovery-execution-mode";
import { resolveEffectiveAccountRunPolicy } from "./account-run-policies";
import { isDateInBackgroundWindow, isInBackgroundWindow } from "./account-run-policy-window";
import { RunPreflightRejectedError } from "./run-preflight";

export class JobDiscoveryScheduleError extends Error {
  constructor(public readonly code: "JOB_DISCOVERY_SCHEDULE_TARGET_NOT_FOUND" | "JOB_DISCOVERY_SCHEDULE_TARGET_INACTIVE" | "JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT" | "SOURCE_POLICY_REQUIRED" | "NO_SUPPORTED_SOURCE" | "PROFILE_UNAVAILABLE" | "ACCOUNT_RUN_POLICY_WINDOW_CLOSED") { super(code); }
}

type Dependencies = { db: Database; runs: AgentRunStarter; auditTrail: AuditTrail; id: () => string; clock: () => Date; executionMode?: JobDiscoveryExecutionMode };
type ScheduleRow = typeof jobDiscoverySchedules.$inferSelect;
type OccurrenceRow = typeof jobDiscoveryScheduleOccurrences.$inferSelect;
type ScanInput = { limit: number; deadline?: Date };

const DEFAULT_SCHEDULE_SCAN_TIMEOUT_MS = 5_000;

function scanDeadline(input: ScanInput, clock: () => Date): Date {
  return input.deadline ?? new Date(clock().getTime() + DEFAULT_SCHEDULE_SCAN_TIMEOUT_MS);
}

function scheduleView(row: ScheduleRow): JobDiscoverySchedule {
  return JobDiscoveryScheduleSchema.parse({
    scheduleId: row.id, targetId: row.targetId, version: row.version, state: row.state,
    dailyTime: row.dailyTime, timeZone: row.timeZone, nextRunAt: row.nextRunAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(),
  });
}

function occurrenceView(row: OccurrenceRow): JobDiscoveryScheduleOccurrence {
  return JobDiscoveryScheduleOccurrenceSchema.parse({
    occurrenceId: row.id, scheduleId: row.scheduleId, targetId: row.targetId, scheduledFor: row.scheduledFor.toISOString(),
    status: row.status, runId: row.runId, skipReason: row.skipReason,
  });
}

/** 中国标准时间没有夏令时；从日历日计算，避免主机时区影响计划时点。 */
function nextShanghaiDailyRun(after: Date, dailyTime: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(after).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  const [hour, minute] = dailyTime.split(":").map(Number) as [number, number];
  let next = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour - 8, minute));
  if (next.getTime() <= after.getTime()) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  return next;
}

async function scheduleTarget(db: Pick<Database, "select">, userId: string, targetId: string) {
  const [target] = await db.select({ id: jobTargets.id, state: jobTargets.state }).from(jobTargets)
    .where(and(eq(jobTargets.userId, userId), eq(jobTargets.id, targetId)));
  if (!target) throw new JobDiscoveryScheduleError("JOB_DISCOVERY_SCHEDULE_TARGET_NOT_FOUND");
  return target;
}

async function validateScheduleConfiguration(db: Pick<Database, "select" | "insert" | "update">, userId: string, targetId: string, executionMode?: JobDiscoveryExecutionMode, context?: { id: () => string; clock: () => Date }): Promise<"TARGET_INACTIVE" | "NO_SUPPORTED_SOURCE" | "SOURCE_POLICY_REQUIRED" | "PROFILE_UNAVAILABLE" | null> {
  const policy = await resolveEffectiveAccountRunPolicy(db, userId, context);
  const target = await scheduleTarget(db, userId, targetId);
  if (target.state !== "active") return "TARGET_INACTIVE";
  // v4 总会冻结 general/site public discovery；Greenhouse 仅是可选 trusted branch。
  if (executionMode === "layered_public") {
    const [profile] = await db.select({ version: jobProfiles.version }).from(jobProfiles).where(eq(jobProfiles.userId, userId)).limit(1);
    if (!profile || profile.version <= 0) return "PROFILE_UNAVAILABLE";
    const [watchlist] = await db.select({ items: companyWatchlistRevisions.items }).from(companyWatchlists).innerJoin(companyWatchlistRevisions, and(
      eq(companyWatchlistRevisions.userId, companyWatchlists.userId),
      eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id),
      eq(companyWatchlistRevisions.version, companyWatchlists.version),
    )).where(and(eq(companyWatchlists.userId, userId), eq(companyWatchlists.targetId, targetId)));
    const analysis = analyzePublicJobDiscoverySources(watchlist);
    const trustedAvailable = analysis.status === "executable" && analysis.sources.slice(0, policy.effective.discovery.trustedSourceLimit).length > 0;
    const publicAvailable = policy.effective.discovery.enabledProviders.includes("anysearch") && policy.effective.discovery.publicQueryLimit > 0;
    return trustedAvailable || publicAvailable ? null : "NO_SUPPORTED_SOURCE";
  }
  const [watchlist] = await db.select({ items: companyWatchlistRevisions.items }).from(companyWatchlists).innerJoin(companyWatchlistRevisions, and(
    eq(companyWatchlistRevisions.userId, companyWatchlists.userId),
    eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id),
    eq(companyWatchlistRevisions.version, companyWatchlists.version),
  )).where(and(eq(companyWatchlists.userId, userId), eq(companyWatchlists.targetId, targetId)));
  const analysis = analyzePublicJobDiscoverySources(watchlist);
  return analysis.status === "policy_required" ? "SOURCE_POLICY_REQUIRED" : analysis.status === "unsupported" || analysis.sources.slice(0, policy.effective.discovery.trustedSourceLimit).length === 0 ? "NO_SUPPORTED_SOURCE" : null;
}

async function sourceSupport(db: Pick<Database, "select" | "insert">, userId: string, targetId: string, executionMode?: JobDiscoveryExecutionMode, context?: { id: () => string; clock: () => Date }): Promise<JobDiscoverySourceSupport> {
  const [watchlist] = await db.select({ items: companyWatchlistRevisions.items }).from(companyWatchlists).innerJoin(companyWatchlistRevisions, and(
    eq(companyWatchlistRevisions.userId, companyWatchlists.userId),
    eq(companyWatchlistRevisions.watchlistId, companyWatchlists.id),
    eq(companyWatchlistRevisions.version, companyWatchlists.version),
  )).where(and(eq(companyWatchlists.userId, userId), eq(companyWatchlists.targetId, targetId)));
  const analysis = analyzePublicJobDiscoverySources(watchlist);
  const policy = await resolveEffectiveAccountRunPolicy(db, userId, context);
  const supportedSourceCount = analysis.status === "executable" ? analysis.sources.slice(0, policy.effective.discovery.trustedSourceLimit).length : 0;
  if (executionMode === "layered_public") {
    const publicAvailable = policy.effective.discovery.enabledProviders.includes("anysearch") && policy.effective.discovery.publicQueryLimit > 0;
    return supportedSourceCount > 0 || publicAvailable ? { status: "executable", supportedSourceCount } : { status: "unsupported" };
  }
  if (analysis.status === "policy_required") return { status: "policy_required", message: "需允许 boards-api.greenhouse.io" };
  return analysis.status === "unsupported" || supportedSourceCount === 0 ? { status: "unsupported" } : { status: "executable", supportedSourceCount };
}

async function appendScheduleAudit(auditTrail: AuditTrail, input: {
  userId: string; requestId: string; eventType: "schedule_set" | "occurrence_materialized" | "occurrence_dispatched" | "occurrence_skipped";
  scheduleId: string; targetId: string; occurrenceId?: string; runId?: string; version?: number; scheduledFor?: Date; state?: "enabled" | "disabled" | "pending" | "dispatched" | "skipped"; now: Date;
}) {
  const metadata = {
    scheduleId: input.scheduleId, targetId: input.targetId, occurrenceId: input.occurrenceId ?? null, runId: input.runId ?? null,
    version: input.version ?? null, scheduledFor: input.scheduledFor?.toISOString() ?? null, state: input.state ?? null,
  };
  if (input.eventType === "schedule_set") return auditTrail.append({ userId: input.userId, actorUserId: input.userId, eventType: "job_discovery.schedule_set", occurredAt: input.now, requestId: input.requestId, outcome: "success", reasonCode: "JOB_DISCOVERY_SCHEDULE_SET", resourceType: "job_discovery_schedule", resourceId: input.scheduleId, metadata });
  if (input.eventType === "occurrence_materialized") return auditTrail.append({ userId: input.userId, actorUserId: input.userId, eventType: "job_discovery.occurrence_materialized", occurredAt: input.now, requestId: input.requestId, outcome: "success", reasonCode: "JOB_DISCOVERY_OCCURRENCE_MATERIALIZED", resourceType: "job_discovery_occurrence", resourceId: input.occurrenceId!, metadata });
  if (input.eventType === "occurrence_dispatched") return auditTrail.append({ userId: input.userId, actorUserId: input.userId, eventType: "job_discovery.occurrence_dispatched", occurredAt: input.now, requestId: input.requestId, outcome: "success", reasonCode: "JOB_DISCOVERY_OCCURRENCE_DISPATCHED", resourceType: "job_discovery_occurrence", resourceId: input.occurrenceId!, metadata });
  return auditTrail.append({ userId: input.userId, actorUserId: input.userId, eventType: "job_discovery.occurrence_skipped", occurredAt: input.now, requestId: input.requestId, outcome: "success", reasonCode: "JOB_DISCOVERY_OCCURRENCE_SKIPPED", resourceType: "job_discovery_occurrence", resourceId: input.occurrenceId!, metadata });
}

export function createJobDiscoverySchedules(deps: Dependencies): {
  get(input: { userId: string; targetId: string }): Promise<JobDiscoveryScheduleResponse | null>;
  set(input: { userId: string; targetId: string; requestId: string; command: SetJobDiscoveryScheduleCommand }): Promise<JobDiscoverySchedule>;
  materializeDue(input: ScanInput): Promise<JobDiscoveryScheduleOccurrence[]>;
  dispatchPending(input: ScanInput): Promise<void>;
} {
  return {
    async get(input) {
      try { await scheduleTarget(deps.db, input.userId, input.targetId); }
      catch (error) {
        if (error instanceof JobDiscoveryScheduleError && error.code === "JOB_DISCOVERY_SCHEDULE_TARGET_NOT_FOUND") return null;
        throw error;
      }
      const [schedule] = await deps.db.select().from(jobDiscoverySchedules).where(and(eq(jobDiscoverySchedules.userId, input.userId), eq(jobDiscoverySchedules.targetId, input.targetId)));
      return JobDiscoveryScheduleResponseSchema.parse({ schedule: schedule ? scheduleView(schedule) : null, sourceSupport: await sourceSupport(deps.db, input.userId, input.targetId, deps.executionMode, { id: deps.id, clock: deps.clock }) });
    },
    async set(input) {
      const command = SetJobDiscoveryScheduleCommandSchema.parse(input.command);
      const now = deps.clock();
      return deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const target = await scheduleTarget(transaction, input.userId, input.targetId);
        if (command.state === "enabled" && target.state !== "active") throw new JobDiscoveryScheduleError("JOB_DISCOVERY_SCHEDULE_TARGET_INACTIVE");
        if (command.state === "enabled") {
          const policy = await resolveEffectiveAccountRunPolicy(transaction, input.userId, { id: deps.id, clock: deps.clock });
          if (!isInBackgroundWindow(command.dailyTime, policy.effective.backgroundWindow)) throw new JobDiscoveryScheduleError("ACCOUNT_RUN_POLICY_WINDOW_CLOSED");
          const reason = await validateScheduleConfiguration(transaction, input.userId, input.targetId, deps.executionMode, { id: deps.id, clock: deps.clock });
          if (reason === "SOURCE_POLICY_REQUIRED") throw new JobDiscoveryScheduleError("SOURCE_POLICY_REQUIRED");
          if (reason === "NO_SUPPORTED_SOURCE") throw new JobDiscoveryScheduleError("NO_SUPPORTED_SOURCE");
          if (reason === "PROFILE_UNAVAILABLE") throw new JobDiscoveryScheduleError("PROFILE_UNAVAILABLE");
        }
        const [current] = await transaction.select().from(jobDiscoverySchedules).where(and(eq(jobDiscoverySchedules.userId, input.userId), eq(jobDiscoverySchedules.targetId, input.targetId)));
        const currentVersion = current?.version ?? 0;
        if (currentVersion !== command.expectedVersion) throw new JobDiscoveryScheduleError("JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT");
        const nextRunAt = command.state === "enabled" ? nextShanghaiDailyRun(now, command.dailyTime) : null;
        const row = current
          ? (await transaction.update(jobDiscoverySchedules).set({ version: current.version + 1, state: command.state, dailyTime: command.dailyTime, nextRunAt, updatedAt: now }).where(and(eq(jobDiscoverySchedules.userId, input.userId), eq(jobDiscoverySchedules.id, current.id), eq(jobDiscoverySchedules.version, current.version))).returning())[0]
          : (await transaction.insert(jobDiscoverySchedules).values({ id: deps.id(), userId: input.userId, targetId: input.targetId, version: 1, state: command.state, dailyTime: command.dailyTime, timeZone: "Asia/Shanghai", nextRunAt, createdAt: now, updatedAt: now }).returning())[0];
        if (!row) throw new JobDiscoveryScheduleError("JOB_DISCOVERY_SCHEDULE_VERSION_CONFLICT");
        await appendScheduleAudit(deps.auditTrail.bind(transaction), { userId: input.userId, requestId: input.requestId, eventType: "schedule_set", scheduleId: row.id, targetId: row.targetId, version: row.version, state: row.state as "enabled" | "disabled", now });
        return scheduleView(row);
      });
    },
    async materializeDue(input) {
      const now = deps.clock();
      const deadline = scanDeadline(input, deps.clock);
      return deps.db.transaction(async (transaction) => {
        await applyTransactionDeadline(transaction, { deadline, clock: deps.clock });
        const due = await transaction.execute(sql`
          select id, user_id, target_id, daily_time, next_run_at
          from job_discovery_schedules
          where state = 'enabled' and next_run_at <= ${now.toISOString()}
          order by next_run_at asc, id asc
          for update skip locked
          limit ${Math.max(1, input.limit)}
        `) as unknown as Array<{ id: string; user_id: string; target_id: string; daily_time: string; next_run_at: Date }>;
        const occurrences: JobDiscoveryScheduleOccurrence[] = [];
        for (const schedule of due) {
          const scheduledFor = new Date(schedule.next_run_at);
          const [created] = await transaction.insert(jobDiscoveryScheduleOccurrences).values({
            id: deps.id(), userId: schedule.user_id, scheduleId: schedule.id, targetId: schedule.target_id, scheduledFor,
            status: "pending", runId: null, skipReason: null, createdAt: now,
          }).onConflictDoNothing().returning();
          await transaction.update(jobDiscoverySchedules).set({ nextRunAt: nextShanghaiDailyRun(now, schedule.daily_time), updatedAt: now }).where(eq(jobDiscoverySchedules.id, schedule.id));
          if (created) {
            const occurrence = occurrenceView(created);
            occurrences.push(occurrence);
            await appendScheduleAudit(deps.auditTrail.bind(transaction), { userId: schedule.user_id, requestId: deps.id(), eventType: "occurrence_materialized", scheduleId: schedule.id, targetId: schedule.target_id, occurrenceId: created.id, scheduledFor, state: "pending", now });
          }
        }
        return occurrences;
      });
    },
    async dispatchPending(input) {
      const deadline = scanDeadline(input, deps.clock);
      await deps.db.transaction(async (transaction) => {
        await applyTransactionDeadline(transaction, { deadline, clock: deps.clock });
        const pending = await transaction.execute(sql`
          select id, user_id, schedule_id, target_id, scheduled_for, status, run_id, skip_reason, created_at
          from job_discovery_schedule_occurrences
          where status = 'pending'
          order by scheduled_for asc, id asc
          for update skip locked
          limit ${Math.max(1, input.limit)}
        `) as unknown as Array<{
          id: string; user_id: string; schedule_id: string; target_id: string; scheduled_for: Date;
          status: OccurrenceRow["status"]; run_id: string | null; skip_reason: OccurrenceRow["skipReason"]; created_at: Date;
        }>;

        for (const row of pending) {
          const occurrence: OccurrenceRow = {
            id: row.id, userId: row.user_id, scheduleId: row.schedule_id, targetId: row.target_id,
            scheduledFor: new Date(row.scheduled_for), status: row.status, runId: row.run_id,
            skipReason: row.skip_reason, createdAt: new Date(row.created_at),
          };
          const now = deps.clock();
          const auditTrail = deps.auditTrail.bind(transaction);
          const dispatch = async (runId: string) => {
            const [dispatched] = await transaction.update(jobDiscoveryScheduleOccurrences).set({ status: "dispatched", runId, skipReason: null })
              .where(and(eq(jobDiscoveryScheduleOccurrences.id, occurrence.id), eq(jobDiscoveryScheduleOccurrences.status, "pending"))).returning();
            if (dispatched) await appendScheduleAudit(auditTrail, { userId: dispatched.userId, requestId: deps.id(), eventType: "occurrence_dispatched", scheduleId: dispatched.scheduleId, targetId: dispatched.targetId, occurrenceId: dispatched.id, runId, scheduledFor: dispatched.scheduledFor, state: "dispatched", now });
          };
          const skip = async (reason: "TARGET_INACTIVE" | "NO_SUPPORTED_SOURCE" | "SOURCE_POLICY_REQUIRED" | "PROFILE_UNAVAILABLE" | "ACCOUNT_RUN_POLICY_WINDOW_CLOSED" | "RUN_PREFLIGHT_BLOCKED") => {
            const [skipped] = await transaction.update(jobDiscoveryScheduleOccurrences).set({ status: "skipped", runId: null, skipReason: reason })
              .where(and(eq(jobDiscoveryScheduleOccurrences.id, occurrence.id), eq(jobDiscoveryScheduleOccurrences.status, "pending"))).returning();
            if (skipped) await appendScheduleAudit(auditTrail, { userId: skipped.userId, requestId: deps.id(), eventType: "occurrence_skipped", scheduleId: skipped.scheduleId, targetId: skipped.targetId, occurrenceId: skipped.id, scheduledFor: skipped.scheduledFor, state: "skipped", now });
          };

          const [existingRun] = await transaction.select({ id: agentRuns.id }).from(agentRuns)
            .where(and(eq(agentRuns.userId, occurrence.userId), eq(agentRuns.idempotencyKey, occurrence.id)));
          if (existingRun) {
            const run = await deps.runs.start({ userId: occurrence.userId, requestId: deps.id(), command: { targetId: occurrence.targetId, idempotencyKey: occurrence.id }, trigger: { kind: "schedule", occurrenceId: occurrence.id, scheduledFor: occurrence.scheduledFor }, deadline });
            await dispatch(run.runId);
            continue;
          }

          try {
            const run = await deps.runs.start({ userId: occurrence.userId, requestId: deps.id(), command: { targetId: occurrence.targetId, idempotencyKey: occurrence.id }, trigger: { kind: "schedule", occurrenceId: occurrence.id, scheduledFor: occurrence.scheduledFor }, deadline });
            await dispatch(run.runId);
          } catch (error) {
            if (error instanceof RunPreflightRejectedError && error.code === "RUN_PREFLIGHT_BLOCKED") { await skip("RUN_PREFLIGHT_BLOCKED"); continue; }
            if (!(error instanceof AgentRunError)) throw error;
            if (error.code === "AGENT_RUN_TARGET_INACTIVE") { await skip("TARGET_INACTIVE"); continue; }
            if (error.code === "AGENT_RUN_UNAVAILABLE") {
              const reason = await validateScheduleConfiguration(transaction, occurrence.userId, occurrence.targetId, deps.executionMode, { id: deps.id, clock: deps.clock });
              if (reason) { await skip(reason); continue; }
              const policy = await resolveEffectiveAccountRunPolicy(transaction, occurrence.userId, { id: deps.id, clock: deps.clock });
              if (!isDateInBackgroundWindow(deps.clock(), policy.effective.backgroundWindow) || !isDateInBackgroundWindow(occurrence.scheduledFor, policy.effective.backgroundWindow)) { await skip("ACCOUNT_RUN_POLICY_WINDOW_CLOSED"); continue; }
            }
            throw error;
          }
        }
      });
    },
  };
}
