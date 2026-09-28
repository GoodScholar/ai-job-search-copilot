import { and, count, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { jobOpportunities, jobOpportunityArchiveCommands, type Database } from "@job-copilot/database";
import {
  JobOpportunityArchiveCommandResponseSchema,
  JobOpportunityArchiveCommandSchema,
  JobOpportunityArchivePageSchema,
  JobOpportunityArchiveStateSchema,
  type JobOpportunityArchiveCommand,
  type JobOpportunityArchiveFilter,
} from "@job-copilot/contracts/job-opportunity-archives";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";
import type { AuditTrail } from "./audit-trail";

export class JobOpportunityArchiveError extends Error {
  constructor(public readonly code: "JOB_OPPORTUNITY_NOT_FOUND" | "JOB_OPPORTUNITY_ARCHIVE_VERSION_CONFLICT" | "JOB_OPPORTUNITY_ARCHIVE_COMMAND_ID_CONFLICT" | "JOB_OPPORTUNITY_ARCHIVE_CURSOR_INVALID") {
    super(code);
  }
}

function state(row: { archivedAt: Date | null; archiveVersion: number }) {
  return JobOpportunityArchiveStateSchema.parse({ archivedAt: row.archivedAt?.toISOString() ?? null, version: row.archiveVersion });
}

function filterClause(filter: JobOpportunityArchiveFilter) {
  return and(
    isNull(jobOpportunities.canonicalOpportunityId),
    filter === "active" ? isNull(jobOpportunities.archivedAt) : isNotNull(jobOpportunities.archivedAt),
  );
}

export function createJobOpportunityArchiveQueries(deps: { db: Database }) {
  return {
    async get(input: { userId: string; opportunityId: string }) {
      const [opportunity] = await deps.db.select({ archivedAt: jobOpportunities.archivedAt, archiveVersion: jobOpportunities.archiveVersion })
        .from(jobOpportunities)
        .where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.opportunityId), isNull(jobOpportunities.canonicalOpportunityId)))
        .limit(1);
      return opportunity ? state(opportunity) : null;
    },
    async list(input: { userId: string; filter: JobOpportunityArchiveFilter; cursor?: string | null; limit: number }) {
      const [cursor] = input.cursor ? await deps.db.select({ id: jobOpportunities.id, updatedAt: jobOpportunities.updatedAt })
        .from(jobOpportunities)
        .where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.cursor), filterClause(input.filter)))
        .limit(1) : [];
      if (input.cursor && !cursor) throw new JobOpportunityArchiveError("JOB_OPPORTUNITY_ARCHIVE_CURSOR_INVALID");
      const [active, archived, rows] = await Promise.all([
        deps.db.select({ value: count() }).from(jobOpportunities).where(and(eq(jobOpportunities.userId, input.userId), isNull(jobOpportunities.canonicalOpportunityId), isNull(jobOpportunities.archivedAt))),
        deps.db.select({ value: count() }).from(jobOpportunities).where(and(eq(jobOpportunities.userId, input.userId), isNull(jobOpportunities.canonicalOpportunityId), isNotNull(jobOpportunities.archivedAt))),
        deps.db.select({ id: jobOpportunities.id, company: jobOpportunities.company, title: jobOpportunities.title, location: jobOpportunities.location, archivedAt: jobOpportunities.archivedAt, archiveVersion: jobOpportunities.archiveVersion, updatedAt: jobOpportunities.updatedAt })
          .from(jobOpportunities)
          .where(and(
            eq(jobOpportunities.userId, input.userId),
            filterClause(input.filter),
            ...(cursor ? [or(
              lt(jobOpportunities.updatedAt, cursor.updatedAt),
              and(eq(jobOpportunities.updatedAt, cursor.updatedAt), lt(jobOpportunities.id, cursor.id)),
            )] : []),
          ))
          .orderBy(desc(jobOpportunities.updatedAt), desc(jobOpportunities.id))
          .limit(input.limit + 1),
      ]);
      const page = rows.slice(0, input.limit);
      return JobOpportunityArchivePageSchema.parse({
        items: page.map((item) => ({ opportunityId: item.id, company: item.company, title: item.title, location: item.location, archivedAt: item.archivedAt?.toISOString() ?? null, version: item.archiveVersion })),
        nextCursor: rows.length > input.limit ? page.at(-1)?.id ?? null : null,
        counts: { active: Number(active[0]?.value ?? 0), archived: Number(archived[0]?.value ?? 0) },
      });
    },
  };
}

export function createJobOpportunityArchiveCommands(deps: { db: Database; auditTrail: AuditTrail; clock: () => Date }) {
  return {
    async change(input: { userId: string; requestId: string; opportunityId: string; command: JobOpportunityArchiveCommand }) {
      const command = JobOpportunityArchiveCommandSchema.parse(input.command);
      return deps.db.transaction(async (tx) => {
        await acquireAccountAdvisoryLock(tx, input.userId);
        const [prior] = await tx.select().from(jobOpportunityArchiveCommands)
          .where(and(eq(jobOpportunityArchiveCommands.userId, input.userId), eq(jobOpportunityArchiveCommands.commandId, command.commandId)))
          .limit(1);
        if (prior) {
          if (prior.opportunityId !== input.opportunityId || prior.action !== command.action || prior.expectedVersion !== command.expectedVersion) {
            throw new JobOpportunityArchiveError("JOB_OPPORTUNITY_ARCHIVE_COMMAND_ID_CONFLICT");
          }
          return JobOpportunityArchiveCommandResponseSchema.parse(prior.resultSnapshot);
        }
        const [current] = await tx.select({ id: jobOpportunities.id, archivedAt: jobOpportunities.archivedAt, archiveVersion: jobOpportunities.archiveVersion })
          .from(jobOpportunities)
          .where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.opportunityId), isNull(jobOpportunities.canonicalOpportunityId)))
          .limit(1);
        if (!current) throw new JobOpportunityArchiveError("JOB_OPPORTUNITY_NOT_FOUND");
        if (current.archiveVersion !== command.expectedVersion) throw new JobOpportunityArchiveError("JOB_OPPORTUNITY_ARCHIVE_VERSION_CONFLICT");
        const applies = command.action === "archive" ? current.archivedAt === null : current.archivedAt !== null;
        const now = deps.clock();
        const next = applies ? {
          archivedAt: command.action === "archive" ? now : null,
          archiveVersion: current.archiveVersion + 1,
        } : current;
        const response = JobOpportunityArchiveCommandResponseSchema.parse({ applied: applies, state: state(next) });
        if (applies) {
          await tx.update(jobOpportunities).set({ archivedAt: next.archivedAt, archiveVersion: next.archiveVersion, updatedAt: now })
            .where(and(eq(jobOpportunities.userId, input.userId), eq(jobOpportunities.id, input.opportunityId), eq(jobOpportunities.archiveVersion, current.archiveVersion)));
          if (command.action === "archive") await deps.auditTrail.bind(tx).append({
            userId: input.userId, actorUserId: input.userId, eventType: "job.opportunity_archived", occurredAt: now,
            requestId: input.requestId, outcome: "success", reasonCode: "JOB_OPPORTUNITY_ARCHIVED",
            resourceType: "job_opportunity", resourceId: input.opportunityId,
            metadata: { opportunityId: input.opportunityId, action: "archive", version: next.archiveVersion },
          });
          else await deps.auditTrail.bind(tx).append({
            userId: input.userId, actorUserId: input.userId, eventType: "job.opportunity_restored", occurredAt: now,
            requestId: input.requestId, outcome: "success", reasonCode: "JOB_OPPORTUNITY_RESTORED",
            resourceType: "job_opportunity", resourceId: input.opportunityId,
            metadata: { opportunityId: input.opportunityId, action: "restore", version: next.archiveVersion },
          });
        }
        await tx.insert(jobOpportunityArchiveCommands).values({
          userId: input.userId, opportunityId: input.opportunityId, commandId: command.commandId,
          action: command.action, expectedVersion: command.expectedVersion, applied: response.applied,
          resultSnapshot: response, createdAt: now,
        });
        return response;
      });
    },
  };
}
