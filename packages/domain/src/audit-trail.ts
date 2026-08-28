import { asc, eq } from "drizzle-orm";
import { auditEvents, type Database } from "@job-copilot/database";
import { CareerImportFailureCodeSchema } from "@job-copilot/contracts/career-import";
import { ProfileFactTypeSchema } from "@job-copilot/contracts/profile-review";
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

const AuditEventInputSchema = z.discriminatedUnion("eventType", [
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
