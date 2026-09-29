import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import {
  jobExportRows,
  jobExports,
  jobMatchVersions,
  jobOpportunities,
  jobSourcePostings,
  jobSourcePostingVersions,
  recommendationDecisionEvents,
  recommendationListItems,
  recommendationLists,
  type Database,
} from "@job-copilot/database";
import {
  JOB_EXPORT_FIELD_VERSION,
  JobExportCommandSchema,
  JobExportListSchema,
  JobExportSchema,
  JobExportJobSchema,
  type JobExport,
  type JobExportCommand,
  type JobExportFilter,
  type JobExportJob,
} from "@job-copilot/contracts/job-exports";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

const EXPORT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface JobExportQueue { enqueue(job: JobExportJob): Promise<void>; }
export interface JobExportStore {
  put(input: { objectKey: string; bytes: Uint8Array; exportId: string }): Promise<void>;
  get(input: { objectKey: string }): Promise<Uint8Array>;
  delete(input: { objectKey: string }): Promise<void>;
}

export class JobExportError extends Error {
  constructor(readonly code: "JOB_EXPORT_NOT_FOUND" | "JOB_EXPORT_COMMAND_ID_CONFLICT" | "JOB_EXPORT_NOT_READY" | "JOB_EXPORT_EXPIRED" | "JOB_EXPORT_STORAGE_UNAVAILABLE") { super(code); }
}

export class JobExportProcessingError extends Error { constructor() { super("JOB_EXPORT_GENERATION_FAILED"); } }

type ExportRow = typeof jobExportRows.$inferSelect;

function objectKey(userId: string, exportId: string) {
  return `accounts/${userId}/job-exports/${exportId}.csv`;
}

function toPublic(row: typeof jobExports.$inferSelect, now: Date): JobExport {
  const expired = row.expiresAt.getTime() <= now.getTime();
  return JobExportSchema.parse({
    id: row.id, status: expired ? "expired" : row.status, filter: row.filter, fieldVersion: row.fieldVersion,
    rowCount: row.rowCount, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    failureCode: expired ? null : row.failureCode,
  });
}

function sourceUrl(value: string | null): string | null {
  try {
    const url = value ? new URL(value) : null;
    return url && !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:") ? url.toString() : null;
  } catch { return null; }
}

function exportFilter(filter: JobExportFilter) {
  return and(
    isNull(jobOpportunities.canonicalOpportunityId),
    filter === "active" ? isNull(jobOpportunities.archivedAt) : filter === "archived" ? isNotNull(jobOpportunities.archivedAt) : undefined,
  );
}

async function latestDecisions(db: Pick<Database, "select">, userId: string, opportunityIds: string[]): Promise<Map<string, "pending" | "saved" | "ignored">> {
  if (!opportunityIds.length) return new Map();
  const rows = await db.select({ opportunityId: jobMatchVersions.opportunityId, decision: recommendationDecisionEvents.decision })
    .from(recommendationListItems)
    .innerJoin(jobMatchVersions, and(
      eq(jobMatchVersions.userId, recommendationListItems.userId),
      eq(jobMatchVersions.id, recommendationListItems.matchVersionId),
    ))
    .innerJoin(recommendationLists, and(eq(recommendationLists.userId, recommendationListItems.userId), eq(recommendationLists.id, recommendationListItems.recommendationListId)))
    .leftJoin(recommendationDecisionEvents, and(eq(recommendationDecisionEvents.userId, recommendationListItems.userId), eq(recommendationDecisionEvents.recommendationListItemId, recommendationListItems.id)))
    .where(and(eq(recommendationListItems.userId, userId), inArray(jobMatchVersions.opportunityId, opportunityIds), sql`not exists (
      select 1 from recommendation_lists newer where newer.user_id = ${recommendationLists.userId} and newer.target_id = ${recommendationLists.targetId}
      and (newer.created_at > ${recommendationLists.createdAt} or (newer.created_at = ${recommendationLists.createdAt} and newer.sequence > ${recommendationLists.sequence}))
    )`))
    .orderBy(desc(recommendationLists.createdAt), desc(recommendationLists.sequence), desc(recommendationLists.id), desc(recommendationDecisionEvents.version));
  const decisions = new Map<string, "pending" | "saved" | "ignored">();
  for (const row of rows) if (!decisions.has(row.opportunityId)) decisions.set(row.opportunityId, row.decision === "saved" || row.decision === "ignored" ? row.decision : "pending");
  return decisions;
}

export function createJobExportCommands(deps: { db: Database; queue: JobExportQueue; id: () => string; clock: () => Date }) {
  return {
    async create(input: { userId: string; command: JobExportCommand }): Promise<JobExport> {
      const command = JobExportCommandSchema.parse(input.command);
      const createOnce = () => deps.db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level repeatable read`);
        await acquireAccountAdvisoryLock(tx, input.userId);
        const [prior] = await tx.select().from(jobExports).where(and(eq(jobExports.userId, input.userId), eq(jobExports.commandId, command.commandId))).limit(1);
        if (prior) {
          if (prior.filter !== command.filter || prior.fieldVersion !== command.fieldVersion) throw new JobExportError("JOB_EXPORT_COMMAND_ID_CONFLICT");
          return { value: toPublic(prior, deps.clock()), created: false };
        }
        const now = deps.clock();
        const exportId = deps.id();
        const opportunities = await tx.select({
          opportunityId: jobOpportunities.id, sourcePostingVersionId: jobOpportunities.sourcePostingVersionId,
          title: jobOpportunities.title, company: jobOpportunities.company, location: jobOpportunities.location,
          availability: jobOpportunities.availability, archivedAt: jobOpportunities.archivedAt,
          postedAt: jobOpportunities.postedAt, deadline: jobOpportunities.deadline, sourceId: jobSourcePostings.sourceId, sourceIdentity: jobSourcePostings.sourceIdentity,
        }).from(jobOpportunities).innerJoin(jobSourcePostingVersions, and(
          eq(jobSourcePostingVersions.userId, jobOpportunities.userId),
          eq(jobSourcePostingVersions.id, jobOpportunities.sourcePostingVersionId),
        )).innerJoin(jobSourcePostings, and(
          eq(jobSourcePostings.userId, jobSourcePostingVersions.userId),
          eq(jobSourcePostings.id, jobSourcePostingVersions.sourcePostingId),
        )).where(and(eq(jobOpportunities.userId, input.userId), exportFilter(command.filter)))
          .orderBy(asc(jobOpportunities.createdAt), asc(jobOpportunities.id));
        const decisions = await latestDecisions(tx, input.userId, opportunities.map((item) => item.opportunityId));
        const rows = opportunities.map((item, index) => ({
          exportId, userId: input.userId, ordinal: index + 1, opportunityId: item.opportunityId,
          sourcePostingVersionId: item.sourcePostingVersionId, title: item.title, company: item.company,
          location: item.location, sourceUrl: sourceUrl(
            item.sourceIdentity && typeof item.sourceIdentity === "object" && "canonicalUrl" in item.sourceIdentity && typeof item.sourceIdentity.canonicalUrl === "string"
              ? item.sourceIdentity.canonicalUrl : item.sourceId,
          ), availability: item.availability,
          archivedAt: item.archivedAt, recommendationDecision: decisions.get(item.opportunityId) ?? null,
          applicationStatus: null, postedAt: item.postedAt, deadline: item.deadline, createdAt: now,
        }));
        const expiresAt = new Date(now.getTime() + EXPORT_TTL_MS);
        const [record] = await tx.insert(jobExports).values({
          id: exportId, userId: input.userId, commandId: command.commandId, filter: command.filter,
          fieldVersion: JOB_EXPORT_FIELD_VERSION, status: "generating", rowCount: rows.length,
          objectKey: objectKey(input.userId, exportId), queuePublishedAt: null, objectDeletedAt: null, failureCode: null,
          createdAt: now, expiresAt, updatedAt: now,
        }).returning();
        if (rows.length) await tx.insert(jobExportRows).values(rows);
        return { value: toPublic(record!, now), created: true };
      });
      let created: Awaited<ReturnType<typeof createOnce>>;
      try { created = await createOnce(); }
      catch (error) {
        const code = databaseErrorCode(error);
        if (code !== "40001" && code !== "23505") throw error;
        created = await createOnce();
      }
      if (created.created) {
        try {
          await deps.queue.enqueue(JobExportJobSchema.parse({ version: 1, exportId: created.value.id, userId: input.userId }));
          await deps.db.update(jobExports).set({ queuePublishedAt: deps.clock(), updatedAt: deps.clock() }).where(and(eq(jobExports.userId, input.userId), eq(jobExports.id, created.value.id), isNull(jobExports.queuePublishedAt)));
        } catch {
          // 已提交快照由 Worker reconciler 持久恢复，不能把排队基础设施细节暴露给调用者。
        }
      }
      return created.value;
    },
  };
}

export function createJobExportQueries(deps: { db: Database; clock: () => Date }) {
  return {
    async list(input: { userId: string }): Promise<{ items: JobExport[] }> {
      const rows = await deps.db.select().from(jobExports).where(eq(jobExports.userId, input.userId)).orderBy(desc(jobExports.createdAt), desc(jobExports.id)).limit(20);
      return JobExportListSchema.parse({ items: rows.map((row) => toPublic(row, deps.clock())) });
    },
    async get(input: { userId: string; exportId: string }): Promise<JobExport | null> {
      const [record] = await deps.db.select().from(jobExports).where(and(eq(jobExports.userId, input.userId), eq(jobExports.id, input.exportId))).limit(1);
      return record ? toPublic(record, deps.clock()) : null;
    },
    async download(input: { userId: string; exportId: string }): Promise<{ objectKey: string }> {
      const [record] = await deps.db.select().from(jobExports).where(and(eq(jobExports.userId, input.userId), eq(jobExports.id, input.exportId))).limit(1);
      if (!record) throw new JobExportError("JOB_EXPORT_NOT_FOUND");
      if (record.expiresAt.getTime() <= deps.clock().getTime() || record.status === "expired") throw new JobExportError("JOB_EXPORT_EXPIRED");
      if (record.status !== "ready") throw new JobExportError("JOB_EXPORT_NOT_READY");
      return { objectKey: record.objectKey };
    },
  };
}

function cell(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : value === null || value === undefined ? "" : String(value);
  const escaped = /^[=+\-@\t\r\n]/.test(text) || /^\s+[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${escaped.replaceAll('"', '""')}"`;
}

export function renderJobExportCsv(rows: ExportRow[]): Uint8Array {
  const columns = ["opportunityId", "title", "company", "location", "sourceUrl", "availability", "archivedAt", "recommendationDecision", "applicationStatus", "postedAt", "deadline"] as const;
  const headers = ["岗位机会 ID", "职位", "公司", "地点", "来源链接", "可用状态", "归档时间", "推荐决策", "投递状态", "发布时间", "截止时间"];
  const body = [headers.map(cell).join(","), ...rows.sort((a, b) => a.ordinal - b.ordinal).map((row) => columns.map((column) => cell(column === "applicationStatus" && row.applicationStatus === null ? "暂无投递记录" : row[column])).join(","))].join("\r\n");
  return new TextEncoder().encode(`\uFEFF${body}\r\n`);
}

export function createJobExportProcessor(deps: { db: Database; store: JobExportStore; clock: () => Date }) {
  return {
    async process(input: JobExportJob & { finalAttempt: boolean }): Promise<void> {
      const job = JobExportJobSchema.parse({ version: input.version, exportId: input.exportId, userId: input.userId });
      try {
        await deps.db.transaction(async (tx) => {
          // 清理与生成按同一导出行锁串行化；对象写入完成前清理不能把记录标记为已删除。
          await tx.execute(sql`select id from job_exports where id = ${job.exportId} and user_id = ${job.userId} for update`);
          const [record] = await tx.select().from(jobExports).where(and(eq(jobExports.userId, job.userId), eq(jobExports.id, job.exportId))).limit(1);
          if (!record || record.status === "ready" || record.status === "failed" || record.status === "expired") return;
          const now = deps.clock();
          if (record.expiresAt.getTime() <= now.getTime()) {
            await tx.update(jobExports).set({ status: "expired", updatedAt: now }).where(and(eq(jobExports.id, record.id), eq(jobExports.userId, record.userId), eq(jobExports.status, "generating")));
            return;
          }
          const rows = await tx.select().from(jobExportRows).where(and(eq(jobExportRows.userId, job.userId), eq(jobExportRows.exportId, job.exportId))).orderBy(asc(jobExportRows.ordinal));
          await deps.store.put({ objectKey: record.objectKey, bytes: renderJobExportCsv(rows), exportId: record.id });
          await tx.update(jobExports).set({ status: "ready", failureCode: null, updatedAt: now }).where(and(eq(jobExports.id, record.id), eq(jobExports.userId, record.userId), eq(jobExports.status, "generating"), gt(jobExports.expiresAt, now)));
        });
      } catch {
        if (input.finalAttempt) {
          await deps.db.update(jobExports).set({ status: "failed", failureCode: "JOB_EXPORT_GENERATION_FAILED", updatedAt: deps.clock() }).where(and(eq(jobExports.id, job.exportId), eq(jobExports.userId, job.userId), eq(jobExports.status, "generating")));
          return;
        }
        throw new JobExportProcessingError();
      }
    },
  };
}

function databaseErrorCode(error: unknown): string | undefined {
  let value = error;
  while (typeof value === "object" && value !== null) {
    if ("code" in value && typeof (value as { code?: unknown }).code === "string") return (value as { code: string }).code;
    value = "cause" in value ? (value as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

export function createJobExportRecoveryQueries(deps: { db: Database; clock: () => Date }) {
  return {
    async listRecoverable(): Promise<JobExportJob[]> {
      const rows = await deps.db.select({ exportId: jobExports.id, userId: jobExports.userId }).from(jobExports).where(eq(jobExports.status, "generating"));
      return rows.map((row) => JobExportJobSchema.parse({ version: 1, exportId: row.exportId, userId: row.userId }));
    },
    async expire(): Promise<void> {
      const now = deps.clock();
      await deps.db.update(jobExports).set({ status: "expired", updatedAt: now }).where(and(lte(jobExports.expiresAt, now), ne(jobExports.status, "expired")));
    },
    async listCleanupPending(): Promise<Array<{ exportId: string; userId: string; objectKey: string }>> {
      return deps.db.select({ exportId: jobExports.id, userId: jobExports.userId, objectKey: jobExports.objectKey }).from(jobExports).where(and(eq(jobExports.status, "expired"), isNull(jobExports.objectDeletedAt)));
    },
    async markObjectDeleted(input: { exportId: string; userId: string }): Promise<void> {
      await deps.db.update(jobExports).set({ objectDeletedAt: deps.clock(), updatedAt: deps.clock() }).where(and(eq(jobExports.id, input.exportId), eq(jobExports.userId, input.userId), eq(jobExports.status, "expired"), isNull(jobExports.objectDeletedAt)));
    },
  };
}
