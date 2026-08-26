import { asc, eq } from "drizzle-orm";
import { auditEvents, type Database } from "@job-copilot/database";

type AuditMetadataValue = string | number | boolean;
export type AuditMetadata = Record<string, AuditMetadataValue>;

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
  append(input: {
    userId?: string;
    actorUserId?: string;
    eventType: string;
    occurredAt?: Date;
    requestId: string;
    outcome: string;
    reasonCode?: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: AuditMetadata;
  }): Promise<void>;
  query(input: { userId: string }): Promise<AuditEvent[]>;
};

const sensitiveMetadataKey = /token|cookie|secret|subject|resume|document/i;

function validateMetadata(metadata: AuditMetadata): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (sensitiveMetadataKey.test(key)) {
      throw new Error(`敏感审计字段不能写入：${key}`);
    }
    if (typeof value === "string" && value.length > 128) {
      throw new Error(`审计元数据字符串不能超过 128 字符：${key}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`审计元数据必须是有限数值：${key}`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`审计元数据值类型不受支持：${key}`);
    }
  }
}

export function createAuditTrail(input: {
  db: Database;
  clock: () => Date;
}): AuditTrail {
  return {
    async append(event): Promise<void> {
      const metadata = event.metadata ?? {};
      validateMetadata(metadata);
      await input.db.insert(auditEvents).values({
        userId: event.userId,
        actorUserId: event.actorUserId,
        eventType: event.eventType,
        occurredAt: event.occurredAt ?? input.clock(),
        requestId: event.requestId,
        outcome: event.outcome,
        reasonCode: event.reasonCode ?? "NONE",
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        metadata,
      });
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
