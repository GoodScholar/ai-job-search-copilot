import { asc, eq } from "drizzle-orm";
import { auditEvents, type Database } from "@job-copilot/database";
import { CareerImportFailureCodeSchema } from "@job-copilot/contracts/career-import";
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
