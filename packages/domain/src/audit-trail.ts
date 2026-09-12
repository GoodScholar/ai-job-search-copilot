import { asc, eq } from "drizzle-orm";
import { auditEvents, type Database } from "@job-copilot/database";
import { CareerImportFailureCodeSchema } from "@job-copilot/contracts/career-import";
import { ProfileFactTypeSchema } from "@job-copilot/contracts/profile-review";
import { JobImportFailureCodeSchema, JobImportInputTypeSchema } from "@job-copilot/contracts/job-imports";
import { AgentRunFailureCodeSchema } from "@job-copilot/contracts/agent-runs";
import { AgentInboxReasonCodeSchema } from "@job-copilot/contracts/agent-inbox";
import { z } from "zod";

type AuditDatabase = Pick<Database, "insert" | "select">;
type AuditMetadata = Record<string, unknown>;

const EmptyMetadataSchema = z.object({}).strict();
const StartedSessionMetadataSchema = z.object({ provider: z.literal("dev") }).strict();
const QueuedCareerImportMetadataSchema = z.object({ documentId: z.uuid(), importId: z.uuid() }).strict();
const CompletedCareerImportMetadataSchema = z.object({
  documentId: z.uuid(), importId: z.uuid(), attemptCount: z.int().min(0), factCount: z.int().min(0),
}).strict();
const FailedCareerImportMetadataSchema = z.object({
  documentId: z.uuid(), importId: z.uuid(), attemptCount: z.int().min(0),
  failureCode: CareerImportFailureCodeSchema,
}).strict();
const ProfileDecisionBaseMetadataSchema = z.object({
  profileId: z.uuid(), candidateFactId: z.uuid(), factType: ProfileFactTypeSchema.exclude(["work_eligibility"]),
  profileVersion: z.int().min(1),
}).strict();
const ProfileCandidateFactDecisionMetadataSchema = z.discriminatedUnion("decision", [
  ProfileDecisionBaseMetadataSchema.extend({ decision: z.literal("confirmed"), profileFactId: z.uuid(), revisionId: z.uuid() }).strict(),
  ProfileDecisionBaseMetadataSchema.extend({ decision: z.literal("corrected"), profileFactId: z.uuid(), revisionId: z.uuid() }).strict(),
  ProfileDecisionBaseMetadataSchema.extend({ decision: z.literal("rejected") }).strict(),
]);
const ProfileFactMaintenanceMetadataSchema = z.object({
  profileId: z.uuid(), profileFactId: z.uuid(), revisionId: z.uuid(), factType: ProfileFactTypeSchema,
  action: z.enum(["created", "revised", "removed"]), profileVersion: z.int().min(1),
}).strict();
const CareerFactConflictResolvedMetadataSchema = z.object({
  conflictId: z.uuid(), existingCandidateFactId: z.uuid(), incomingCandidateFactId: z.uuid(),
  kind: z.enum(["date", "role", "organization", "metric"]), resolution: z.enum(["use_existing", "use_incoming", "keep_both"]),
  profileId: z.uuid(), profileVersion: z.int().min(1),
}).strict();
const JobTargetMaintenanceMetadataSchema = z.object({
  targetId: z.uuid(), action: z.enum(["created", "revised", "deactivated"]), version: z.int().min(1),
  priority: z.enum(["primary", "secondary"]), state: z.enum(["active", "inactive"]),
}).strict();
const CompanyWatchlistMaintenanceMetadataSchema = z.discriminatedUnion("action", [
  z.object({ targetId: z.uuid(), action: z.literal("item_added"), version: z.int().min(1), itemId: z.uuid(), itemCount: z.int().min(1).max(50) }).strict(),
  z.object({ targetId: z.uuid(), action: z.literal("item_revised"), version: z.int().min(1), itemId: z.uuid(), itemCount: z.int().min(1).max(50) }).strict(),
  z.object({ targetId: z.uuid(), action: z.literal("reordered"), version: z.int().min(1), itemCount: z.int().min(1).max(50) }).strict(),
  z.object({ targetId: z.uuid(), action: z.literal("item_enabled"), version: z.int().min(1), itemId: z.uuid(), itemCount: z.int().min(1).max(50) }).strict(),
  z.object({ targetId: z.uuid(), action: z.literal("item_disabled"), version: z.int().min(1), itemId: z.uuid(), itemCount: z.int().min(1).max(50) }).strict(),
]);
const SubmittedJobImportMetadataSchema = z.object({
  importId: z.uuid(), inputType: JobImportInputTypeSchema,
}).strict();
const CompletedJobImportMetadataSchema = z.object({
  importId: z.uuid(), sourcePostingId: z.uuid(), sourcePostingVersionId: z.uuid(), opportunityId: z.uuid(),
  version: z.int().min(1), inputType: JobImportInputTypeSchema, attemptCount: z.int().min(1),
}).strict();
const FailedJobImportMetadataSchema = z.object({
  importId: z.uuid(), inputType: JobImportInputTypeSchema, attemptCount: z.int().min(1), failureCode: JobImportFailureCodeSchema,
}).strict();
const CreatedJobTriageMetadataSchema = z.object({
  triageVersionId: z.uuid(), opportunityId: z.uuid(), sourcePostingVersionId: z.uuid(), profileId: z.uuid(), profileVersion: z.int().min(1),
  targetId: z.uuid(), targetVersion: z.int().min(1), qualificationRuleVersion: z.string().min(1).max(64), coarseRuleVersion: z.string().min(1).max(64),
  overallVerdict: z.enum(["pass", "fail", "unknown"]), deadlineStatus: z.enum(["expired", "closing_soon", "valid", "missing", "invalid"]),
}).strict();
const QueuedAgentRunMetadataSchema = z.object({ runId: z.uuid(), targetId: z.uuid(), targetVersion: z.int().min(1), workflowVersion: z.string().min(1), adapterVersion: z.string().min(1) }).strict();
const CompletedAgentRunMetadataSchema = z.object({ runId: z.uuid(), targetId: z.uuid(), attemptCount: z.int().min(1), resultCount: z.int().min(0) }).strict();
const FailedAgentRunMetadataSchema = z.object({ runId: z.uuid(), targetId: z.uuid(), attemptCount: z.int().min(1), failureCode: AgentRunFailureCodeSchema }).strict();
const ControlAgentRunMetadataSchema = z.object({
  runId: z.uuid(), version: z.int().min(1), action: z.enum(["pause", "resume", "cancel"]), attemptCount: z.int().min(0),
}).strict();
const AgentRunBudgetConsumedMetadataSchema = z.object({
  runId: z.uuid(), activeDurationMs: z.int().nonnegative(), toolCalls: z.int().nonnegative(), sourceRequests: z.int().nonnegative(), modelCalls: z.int().nonnegative(),
  attempts: z.int().nonnegative(), results: z.int().nonnegative(), tokens: z.int().nonnegative(),
}).strict();
const AgentRunBudgetExhaustedMetadataSchema = z.object({
  runId: z.uuid(), budgetDimension: z.enum(["active_duration", "attempts", "tool_calls", "model_calls", "tokens"]), attemptCount: z.int().min(0),
}).strict();
const AgentRunRetryScheduledMetadataSchema = z.object({
  runId: z.uuid(), attemptCount: z.int().min(1), failureCode: AgentRunFailureCodeSchema,
}).strict();
const AgentInboxOpenedMetadataSchema = z.discriminatedUnion("kind", [
  z.object({ runId: z.uuid(), kind: z.literal("decision_required"), reasonCode: z.literal("AGENT_RUN_PAUSED"), budgetDimension: z.null() }).strict(),
  z.object({ runId: z.uuid(), kind: z.literal("run_failed"), reasonCode: AgentRunFailureCodeSchema.exclude(["AGENT_RUN_BUDGET_EXCEEDED"]), budgetDimension: z.null() }).strict(),
  z.object({ runId: z.uuid(), kind: z.literal("budget_exhausted"), reasonCode: z.literal("AGENT_RUN_BUDGET_EXCEEDED"), budgetDimension: z.enum(["active_duration", "attempts", "tool_calls", "model_calls", "tokens"]) }).strict(),
  z.object({ runId: z.uuid(), kind: z.literal("source_attention"), reasonCode: z.literal("SOURCE_HEALTH_ATTENTION"), budgetDimension: z.null() }).strict(),
  z.object({ runId: z.uuid(), kind: z.literal("discovery_attention"), reasonCode: z.literal("DISCOVERY_ATTENTION"), budgetDimension: z.null() }).strict(),
]);
const AgentInboxActionAppliedMetadataSchema = z.object({
  itemId: z.uuid(), runId: z.uuid().nullable(), action: z.enum(["restart_run", "resume_run", "cancel_run", "mark_read", "dismiss"]), outcome: z.enum(["applied", "no_change", "failed"]), reasonCode: z.union([AgentInboxReasonCodeSchema, z.literal("AGENT_INBOX_ACTION_FAILED")]),
}).strict();
const AgentInboxResolvedMetadataSchema = z.object({
  itemId: z.uuid(), runId: z.uuid().nullable(), action: z.enum(["restart_run", "resume_run", "cancel_run", "dismiss"]), reasonCode: AgentInboxReasonCodeSchema,
}).strict();
const JobDiscoveryScheduleMetadataSchema = z.object({
  scheduleId: z.uuid(), targetId: z.uuid(), occurrenceId: z.uuid().nullable(), runId: z.uuid().nullable(),
  version: z.int().min(1).nullable(), scheduledFor: z.iso.datetime().nullable(), state: z.enum(["enabled", "disabled", "pending", "dispatched", "skipped"]).nullable(),
}).strict();
const RecommendationDecisionMetadataSchema = z.object({ recommendationListId: z.uuid(), recommendationListItemId: z.uuid(), matchVersionId: z.uuid(), action: z.enum(["saved", "ignored"]), reason: z.string().min(1).max(32).nullable(), version: z.int().positive() }).strict();
const CalibrationProposalMetadataSchema = z.object({ proposalId: z.uuid(), targetId: z.uuid(), action: z.enum(["created", "revised", "rebased", "approved", "rejected"]), version: z.int().positive(), evidenceCount: z.int().nonnegative() }).strict();
const AccountRunControlMetadataSchema = z.object({ commandId: z.uuid(), controlVersion: z.int().positive(), action: z.enum(["stop", "release"]) }).strict();

const AuditEventInputSchema = z.discriminatedUnion("eventType", [
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("account.run_stopped"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("ACCOUNT_RUN_STOPPED"), resourceType: z.literal("account_run_control"), resourceId: z.uuid(), metadata: AccountRunControlMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("account.run_stop_released"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("ACCOUNT_RUN_STOP_RELEASED"), resourceType: z.literal("account_run_control"), resourceId: z.uuid(), metadata: AccountRunControlMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("recommendation.decision_recorded"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.enum(["RECOMMENDATION_SAVED", "RECOMMENDATION_IGNORED"]), resourceType: z.literal("recommendation_list_item"), resourceId: z.uuid(), metadata: RecommendationDecisionMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("recommendation.calibration_proposal"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.enum(["CALIBRATION_PROPOSAL_CREATED", "CALIBRATION_PROPOSAL_REVISED", "CALIBRATION_PROPOSAL_REBASED", "CALIBRATION_PROPOSAL_APPROVED", "CALIBRATION_PROPOSAL_REJECTED"]), resourceType: z.literal("calibration_proposal"), resourceId: z.uuid(), metadata: CalibrationProposalMetadataSchema }).strict(),
  z.object({
    userId: z.uuid().optional(),
    actorUserId: z.uuid().optional(),
    eventType: z.literal("auth.session_started"),
    occurredAt: z.date().optional(),
    requestId: z.uuid(),
    outcome: z.literal("success"),
    reasonCode: z.literal("AUTH_SESSION_STARTED"),
    resourceType: z.literal("session"),
    metadata: StartedSessionMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid().optional(),
    actorUserId: z.uuid().optional(),
    eventType: z.literal("auth.session_ended"),
    occurredAt: z.date().optional(),
    requestId: z.uuid(),
    outcome: z.literal("success"),
    reasonCode: z.literal("AUTH_SESSION_ENDED"),
    resourceType: z.literal("session"),
    metadata: EmptyMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid().optional(),
    actorUserId: z.uuid().optional(),
    eventType: z.literal("auth.session_rejected"),
    occurredAt: z.date().optional(),
    requestId: z.uuid(),
    outcome: z.literal("denied"),
    reasonCode: z.enum([
      "AUTH_SESSION_NOT_FOUND",
      "AUTH_SESSION_REVOKED",
      "AUTH_SESSION_EXPIRED",
      "AUTH_ACCOUNT_INACTIVE",
    ]),
    resourceType: z.literal("session"),
    metadata: EmptyMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid().optional(),
    actorUserId: z.uuid().optional(),
    eventType: z.literal("account.access_rejected"),
    occurredAt: z.date().optional(),
    requestId: z.uuid(),
    outcome: z.literal("denied"),
    reasonCode: z.literal("ACCOUNT_NOT_FOUND"),
    resourceType: z.literal("account"),
    resourceId: z.uuid(),
    metadata: EmptyMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("career.document_import_queued"),
    occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"),
    reasonCode: z.literal("CAREER_DOCUMENT_IMPORT_QUEUED"), resourceType: z.literal("career_import"), resourceId: z.uuid(),
    metadata: QueuedCareerImportMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("career.document_import_completed"),
    occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"),
    reasonCode: z.literal("CAREER_DOCUMENT_IMPORT_COMPLETED"), resourceType: z.literal("career_import"), resourceId: z.uuid(),
    metadata: CompletedCareerImportMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("career.document_import_failed"),
    occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("failure"),
    reasonCode: CareerImportFailureCodeSchema, resourceType: z.literal("career_import"), resourceId: z.uuid(), metadata: FailedCareerImportMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("profile.candidate_fact_decided"),
    occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"),
    reasonCode: z.enum(["PROFILE_FACT_CONFIRMED", "PROFILE_FACT_CORRECTED", "PROFILE_FACT_REJECTED"]),
    resourceType: z.literal("candidate_fact"), resourceId: z.uuid(), metadata: ProfileCandidateFactDecisionMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("profile.fact_maintained"),
    occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"),
    reasonCode: z.enum(["PROFILE_FACT_CREATED", "PROFILE_FACT_REVISED", "PROFILE_FACT_REMOVED"]),
    resourceType: z.literal("profile_fact"), resourceId: z.uuid(), metadata: ProfileFactMaintenanceMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("profile.career_fact_conflict_resolved"),
    occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("CAREER_FACT_CONFLICT_RESOLVED"),
    resourceType: z.literal("career_fact_conflict"), resourceId: z.uuid(), metadata: CareerFactConflictResolvedMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("profile.job_target_maintained"),
    occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"),
    reasonCode: z.enum(["JOB_TARGET_CREATED", "JOB_TARGET_REVISED", "JOB_TARGET_DEACTIVATED"]),
    resourceType: z.literal("job_target"), resourceId: z.uuid(), metadata: JobTargetMaintenanceMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("profile.company_watchlist_maintained"),
    occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"),
    reasonCode: z.enum([
      "COMPANY_WATCHLIST_ITEM_ADDED",
      "COMPANY_WATCHLIST_ITEM_REVISED",
      "COMPANY_WATCHLIST_REORDERED",
      "COMPANY_WATCHLIST_ITEM_ENABLED",
      "COMPANY_WATCHLIST_ITEM_DISABLED",
    ]),
    resourceType: z.literal("company_watchlist"), resourceId: z.uuid(), metadata: CompanyWatchlistMaintenanceMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("job.import_submitted"), occurredAt: z.date().optional(),
    requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("JOB_IMPORT_SUBMITTED"),
    resourceType: z.literal("job_import"), resourceId: z.uuid(), metadata: SubmittedJobImportMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("job.import_completed"), occurredAt: z.date().optional(),
    requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("JOB_IMPORT_COMPLETED"),
    resourceType: z.literal("job_import"), resourceId: z.uuid(), metadata: CompletedJobImportMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("job.import_failed"), occurredAt: z.date().optional(),
    requestId: z.uuid(), outcome: z.literal("failure"), reasonCode: JobImportFailureCodeSchema,
    resourceType: z.literal("job_import"), resourceId: z.uuid(), metadata: FailedJobImportMetadataSchema,
  }).strict(),
  z.object({
    userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("job.triage_created"), occurredAt: z.date().optional(),
    requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("JOB_TRIAGE_CREATED"),
    resourceType: z.literal("job_triage_version"), resourceId: z.uuid(), metadata: CreatedJobTriageMetadataSchema,
  }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_queued"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_QUEUED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: QueuedAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_completed"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_COMPLETED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: CompletedAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_failed"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("failure"), reasonCode: AgentRunFailureCodeSchema, resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: FailedAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_pause_requested"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_PAUSE_REQUESTED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: ControlAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_paused"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_PAUSED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: ControlAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_resume_requested"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_RESUME_REQUESTED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: ControlAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_resumed"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_RESUMED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: ControlAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_cancel_requested"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_CANCEL_REQUESTED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: ControlAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_cancelled"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_CANCELLED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: ControlAgentRunMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_budget_consumed"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("AGENT_RUN_BUDGET_CONSUMED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: AgentRunBudgetConsumedMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_budget_exhausted"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("failure"), reasonCode: z.literal("AGENT_RUN_BUDGET_EXCEEDED"), resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: AgentRunBudgetExhaustedMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.run_retry_scheduled"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: AgentRunFailureCodeSchema, resourceType: z.literal("agent_run"), resourceId: z.uuid(), metadata: AgentRunRetryScheduledMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.inbox_opened"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.union([z.literal("AGENT_RUN_PAUSED"), z.literal("SOURCE_HEALTH_ATTENTION"), z.literal("DISCOVERY_ATTENTION"), AgentRunFailureCodeSchema]), resourceType: z.literal("agent_inbox_item"), resourceId: z.uuid(), metadata: AgentInboxOpenedMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.inbox_action_applied"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.enum(["success", "failure"]), reasonCode: z.union([AgentInboxReasonCodeSchema, z.literal("AGENT_INBOX_ACTION_FAILED")]), resourceType: z.literal("agent_inbox_item"), resourceId: z.uuid(), metadata: AgentInboxActionAppliedMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("agent.inbox_resolved"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: AgentInboxReasonCodeSchema, resourceType: z.literal("agent_inbox_item"), resourceId: z.uuid(), metadata: AgentInboxResolvedMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("job_discovery.schedule_set"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("JOB_DISCOVERY_SCHEDULE_SET"), resourceType: z.literal("job_discovery_schedule"), resourceId: z.uuid(), metadata: JobDiscoveryScheduleMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("job_discovery.occurrence_materialized"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("JOB_DISCOVERY_OCCURRENCE_MATERIALIZED"), resourceType: z.literal("job_discovery_occurrence"), resourceId: z.uuid(), metadata: JobDiscoveryScheduleMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("job_discovery.occurrence_dispatched"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("JOB_DISCOVERY_OCCURRENCE_DISPATCHED"), resourceType: z.literal("job_discovery_occurrence"), resourceId: z.uuid(), metadata: JobDiscoveryScheduleMetadataSchema }).strict(),
  z.object({ userId: z.uuid(), actorUserId: z.uuid(), eventType: z.literal("job_discovery.occurrence_skipped"), occurredAt: z.date().optional(), requestId: z.uuid(), outcome: z.literal("success"), reasonCode: z.literal("JOB_DISCOVERY_OCCURRENCE_SKIPPED"), resourceType: z.literal("job_discovery_occurrence"), resourceId: z.uuid(), metadata: JobDiscoveryScheduleMetadataSchema }).strict(),
]);

type AuditEventInput = z.input<typeof AuditEventInputSchema>;

export type AuditEvent = {
  userId: string | null;
  actorUserId: string | null;
  eventType: string;
  occurredAt: Date;
  requestId: string;
  outcome: string;
  reasonCode: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: AuditMetadata;
};

export type AuditTrail = {
  append(input: AuditEventInput): Promise<void>;
  bind(database: AuditDatabase): AuditTrail;
  query(input: { userId: string }): Promise<AuditEvent[]>;
};

export function createAuditTrail(input: {
  db: AuditDatabase;
  clock: () => Date;
}): AuditTrail {
  return {
    async append(event): Promise<void> {
      const result = AuditEventInputSchema.safeParse(event);
      if (!result.success) {
        throw new Error("审计事件不符合字段白名单");
      }
      const parsed = result.data;
      const metadata = parsed.metadata ?? {};
      await input.db.insert(auditEvents).values({
        userId: parsed.userId,
        actorUserId: parsed.actorUserId,
        eventType: parsed.eventType,
        occurredAt: parsed.occurredAt ?? input.clock(),
        requestId: parsed.requestId,
        outcome: parsed.outcome,
        reasonCode: parsed.reasonCode ?? "NONE",
        resourceType: parsed.resourceType,
        resourceId: "resourceId" in parsed ? parsed.resourceId : undefined,
        metadata,
      });
    },
    bind(database): AuditTrail {
      return createAuditTrail({ db: database, clock: input.clock });
    },
    async query({ userId }): Promise<AuditEvent[]> {
      const rows = await input.db.select({
        userId: auditEvents.userId,
        actorUserId: auditEvents.actorUserId,
        eventType: auditEvents.eventType,
        occurredAt: auditEvents.occurredAt,
        requestId: auditEvents.requestId,
        outcome: auditEvents.outcome,
        reasonCode: auditEvents.reasonCode,
        resourceType: auditEvents.resourceType,
        resourceId: auditEvents.resourceId,
        metadata: auditEvents.metadata,
      }).from(auditEvents).where(eq(auditEvents.userId, userId)).orderBy(asc(auditEvents.createdAt));

      return rows as AuditEvent[];
    },
  };
}
