import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { jobImports, jobOpportunities, jobOpportunitySources, jobSourcePostings, jobSourcePostingVersions, type Database } from "@job-copilot/database";
import {
  CreateJobImportCommandSchema,
  JOB_IMPORT_MAX_BYTES,
  JobImportDetailSchema,
  JobImportJobSchema,
  JobImportListSchema,
  JobNormalizerOutputSchema,
  type CreateJobImportCommand,
  type CreateJobImportResponse,
  type JobImportDetail,
  type JobImportJob,
  type JobImportList,
  type JobImportFailureCode,
} from "@job-copilot/contracts/job-imports";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export interface JobContentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown"; importId: string }): Promise<void>;
  get(input: { objectKey: string }): Promise<Uint8Array>;
  delete(input: { objectKey: string }): Promise<void>;
}

export interface JobImportQueue {
  enqueue(job: JobImportJob): Promise<void>;
}

export interface JobPostingNormalizer {
  normalize(content: string): Promise<unknown>;
}

export class JobImportError extends Error {
  constructor(public readonly code: "JOB_IMPORT_QUEUE_UNAVAILABLE" | "JOB_IMPORT_OBJECT_STORAGE_FAILED") {
    super(code);
  }
}

export class JobImportRetryableError extends Error {
  readonly code = "JOB_IMPORT_RETRYABLE";

  constructor() {
    super("JOB_IMPORT_RETRYABLE");
  }
}

type CommandDependencies = {
  db: Database;
  auditTrail: AuditTrail;
  contentStore: JobContentStore;
  queue: JobImportQueue;
  id: () => string;
  clock: () => Date;
};

type ProcessorDependencies = {
  db: Database;
  auditTrail: AuditTrail;
  contentStore: JobContentStore;
  normalizer: JobPostingNormalizer;
  id: () => string;
  clock: () => Date;
};

export type CreateJobImportResult = CreateJobImportResponse & { reused: boolean };

function canonicalContent(content: string): string {
  return content.normalize("NFKC").replace(/\r\n?/g, "\n")
    .split("\n").map((line) => line.replace(/\s+$/u, "")).join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sourceObjectKey(userId: string, importId: string): string {
  return `accounts/${userId}/job-imports/${importId}/source.md`;
}

function response(record: {
  id: string; inputType: string; originalFilename: string | null; status: string; failureCode: string | null; createdAt: Date; updatedAt: Date;
}, reused: boolean): CreateJobImportResult {
  return {
    importId: record.id,
    inputType: record.inputType as "pasted_text" | "markdown_upload",
    originalFilename: record.originalFilename,
    status: record.status as "imported" | "normalizing" | "completed" | "failed",
    failureCode: record.failureCode as CreateJobImportResponse["failureCode"],
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    detailUrl: `/v1/job-imports/${record.id}`,
    reused,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function opportunityDedupKey(output: {
  company: string | null; title: string | null; location: string | null; postedAt: string | null; deadline: string | null; description: string | null;
}): string {
  return sha256(JSON.stringify([
    output.company, output.title, output.location, output.postedAt, output.deadline,
    output.description === null ? null : sha256(output.description),
  ]));
}

function importBase(record: {
  id: string; inputType: string; originalFilename: string | null; status: string; failureCode: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    importId: record.id, inputType: record.inputType, originalFilename: record.originalFilename, status: record.status,
    failureCode: record.failureCode, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  };
}

async function failImport(deps: Pick<ProcessorDependencies, "db" | "auditTrail" | "clock">, input: { userId: string; importId: string; inputType: "pasted_text" | "markdown_upload"; failureCode: JobImportFailureCode }) {
  const now = deps.clock();
  await deps.db.transaction(async (transaction) => {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const [failed] = await transaction.update(jobImports).set({ status: "failed", failureCode: input.failureCode, updatedAt: now }).where(and(
      eq(jobImports.userId, input.userId), eq(jobImports.id, input.importId),
      eq(jobImports.status, "normalizing"),
    )).returning({ id: jobImports.id });
    if (!failed) return;
    await deps.auditTrail.bind(transaction).append({
      userId: input.userId, actorUserId: input.userId, eventType: "job.import_failed", occurredAt: now,
      requestId: input.importId, outcome: "failure", reasonCode: input.failureCode, resourceType: "job_import", resourceId: input.importId,
      metadata: { importId: input.importId, inputType: input.inputType, attemptCount: 1, failureCode: input.failureCode },
    });
  });
}

async function releaseImportForRetry(deps: Pick<ProcessorDependencies, "db" | "clock">, input: { userId: string; importId: string }) {
  await deps.db.update(jobImports).set({ status: "imported", failureCode: null, updatedAt: deps.clock() }).where(and(
    eq(jobImports.userId, input.userId), eq(jobImports.id, input.importId), eq(jobImports.status, "normalizing"),
  ));
}

export function createJobImportCommands(deps: CommandDependencies): {
  submit(input: { userId: string; requestId: string; command: CreateJobImportCommand }): Promise<CreateJobImportResult>;
} {
  return {
    async submit(input): Promise<CreateJobImportResult> {
      const command = CreateJobImportCommandSchema.parse(input.command);
      const content = canonicalContent(command.content);
      const bytes = new TextEncoder().encode(content);
      if (!content || bytes.byteLength > JOB_IMPORT_MAX_BYTES) throw new Error("JOB_IMPORT_CONTENT_INVALID");

      const checksum = contentHash(content);
      const now = deps.clock();
      let reused = false;
      let storedObjectKey: string | null = null;
      let record!: {
        id: string; inputType: string; originalFilename: string | null; status: string;
        failureCode: string | null; createdAt: Date; updatedAt: Date;
      };
      try {
        record = await deps.db.transaction(async (transaction) => {
        await acquireAccountAdvisoryLock(transaction, input.userId);
        const [existing] = await transaction.select({
          id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename,
          status: jobImports.status, failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt,
        }).from(jobImports).where(and(eq(jobImports.userId, input.userId), eq(jobImports.contentSha256, checksum)));
        if (existing) {
          reused = true;
          if (existing.status === "failed" || existing.status === "imported") {
            const [retried] = await transaction.update(jobImports).set({ status: "imported", failureCode: null, updatedAt: now }).where(and(
              eq(jobImports.userId, input.userId), eq(jobImports.id, existing.id), inArray(jobImports.status, ["failed", "imported"]),
            )).returning({
              id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename,
              status: jobImports.status, failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt,
            });
            return retried ?? existing;
          }
          return existing;
        }

        const importId = deps.id();
        const [created] = await transaction.insert(jobImports).values({
          id: importId, userId: input.userId, inputType: command.inputType, contentSha256: checksum,
          originalFilename: command.inputType === "markdown_upload" ? command.originalFilename : null,
          status: "imported", createdAt: now, updatedAt: now,
        }).returning({
          id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename,
          status: jobImports.status, failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt,
        });
        if (!created) throw new Error("JOB_IMPORT_PERSIST_FAILED");
        const objectKey = sourceObjectKey(input.userId, importId);
        try {
          await deps.contentStore.put({ objectKey, bytes, mediaType: "text/markdown", importId });
          storedObjectKey = objectKey;
        } catch {
          throw new JobImportError("JOB_IMPORT_OBJECT_STORAGE_FAILED");
        }
        await deps.auditTrail.bind(transaction).append({
          userId: input.userId, actorUserId: input.userId, eventType: "job.import_submitted", occurredAt: now,
          requestId: input.requestId, outcome: "success", reasonCode: "JOB_IMPORT_SUBMITTED",
          resourceType: "job_import", resourceId: importId, metadata: { importId, inputType: command.inputType },
        });
        return created;
        });
      } catch (error) {
        if (storedObjectKey) {
          try {
            await deps.contentStore.delete({ objectKey: storedObjectKey });
          } catch {
            // 保留原始事务失败，避免补偿错误覆盖它。
          }
        }
        throw error;
      }

      try {
        await deps.queue.enqueue({ version: 1, importId: record.id, userId: input.userId });
      } catch {
        throw new JobImportError("JOB_IMPORT_QUEUE_UNAVAILABLE");
      }
      return response(record, reused);
    },
  };
}

export function createJobImportProcessor(deps: ProcessorDependencies): {
  process(job: JobImportJob & { finalAttempt: boolean }): Promise<"completed" | "failed" | "stale">;
} {
  return {
    async process(job): Promise<"completed" | "failed" | "stale"> {
      const parsedJob = JobImportJobSchema.parse({ version: job.version, importId: job.importId, userId: job.userId });
      const [record] = await deps.db.update(jobImports).set({ status: "normalizing", failureCode: null, updatedAt: deps.clock() }).where(and(
        eq(jobImports.userId, parsedJob.userId), eq(jobImports.id, parsedJob.importId), eq(jobImports.status, "imported"),
      )).returning({
        id: jobImports.id, inputType: jobImports.inputType, contentSha256: jobImports.contentSha256,
      });
      if (!record) return "stale";
      const inputType = record.inputType as "pasted_text" | "markdown_upload";
      let content: string;
      try {
        const bytes = await deps.contentStore.get({ objectKey: sourceObjectKey(parsedJob.userId, parsedJob.importId) });
        content = new TextDecoder().decode(bytes);
      } catch {
        if (!job.finalAttempt) {
          await releaseImportForRetry(deps, parsedJob);
          throw new JobImportRetryableError();
        }
        await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, failureCode: "JOB_IMPORT_CONTENT_READ_FAILED" });
        return "failed";
      }
      if (sha256(content) !== record.contentSha256) {
        await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, failureCode: "JOB_IMPORT_CHECKSUM_MISMATCH" });
        return "failed";
      }
      let normalized: unknown;
      try {
        normalized = await deps.normalizer.normalize(content);
      } catch {
        if (!job.finalAttempt) {
          await releaseImportForRetry(deps, parsedJob);
          throw new JobImportRetryableError();
        }
        await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, failureCode: "JOB_IMPORT_PERSIST_FAILED" });
        return "failed";
      }
      const result = JobNormalizerOutputSchema.safeParse(normalized);
      if (!result.success) {
        await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, failureCode: "JOB_NORMALIZER_OUTPUT_INVALID" });
        return "failed";
      }
      const output = result.data;
      const now = deps.clock();
      try {
        const completed = await deps.db.transaction(async (transaction) => {
          await acquireAccountAdvisoryLock(transaction, parsedJob.userId);
          const [completionClaimed] = await transaction.update(jobImports).set({ status: "completed", failureCode: null, updatedAt: now }).where(and(
            eq(jobImports.userId, parsedJob.userId), eq(jobImports.id, parsedJob.importId), eq(jobImports.status, "normalizing"),
          )).returning({ id: jobImports.id });
          if (!completionClaimed) return false;

          const sourceIdentifier = record.contentSha256;
          let [posting] = await transaction.select({ id: jobSourcePostings.id }).from(jobSourcePostings).where(and(
            eq(jobSourcePostings.userId, parsedJob.userId), eq(jobSourcePostings.sourceType, "user_import"), eq(jobSourcePostings.sourceIdentifier, sourceIdentifier),
          ));
          if (!posting) {
            const [created] = await transaction.insert(jobSourcePostings).values({
              id: deps.id(), userId: parsedJob.userId, sourceType: "user_import", sourceIdentifier,
              sourceIdentity: { contentFingerprint: sourceIdentifier }, createdAt: now, updatedAt: now,
            }).returning({ id: jobSourcePostings.id });
            if (!created) throw new Error("JOB_IMPORT_PERSIST_FAILED");
            posting = created;
          }
          let [sourceVersion] = await transaction.select({ id: jobSourcePostingVersions.id, version: jobSourcePostingVersions.version })
            .from(jobSourcePostingVersions).where(and(
              eq(jobSourcePostingVersions.userId, parsedJob.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id), eq(jobSourcePostingVersions.contentSha256, record.contentSha256),
            ));
          if (!sourceVersion) {
            const [latest] = await transaction.select({ version: jobSourcePostingVersions.version }).from(jobSourcePostingVersions)
              .where(and(eq(jobSourcePostingVersions.userId, parsedJob.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id)))
              .orderBy(desc(jobSourcePostingVersions.version)).limit(1);
            const [created] = await transaction.insert(jobSourcePostingVersions).values({
              id: deps.id(), userId: parsedJob.userId, sourcePostingId: posting.id, version: (latest?.version ?? 0) + 1,
              contentSha256: record.contentSha256, rawObjectReference: { objectKey: sourceObjectKey(parsedJob.userId, parsedJob.importId) }, retrievedAt: now, createdAt: now,
            }).returning({ id: jobSourcePostingVersions.id, version: jobSourcePostingVersions.version });
            if (!created) throw new Error("JOB_IMPORT_PERSIST_FAILED");
            sourceVersion = created;
          }
          const dedupKey = opportunityDedupKey(output);
          let [opportunity] = await transaction.select({ id: jobOpportunities.id }).from(jobOpportunities).where(and(
            eq(jobOpportunities.userId, parsedJob.userId), eq(jobOpportunities.dedupKey, dedupKey),
          ));
          if (!opportunity) {
            const [created] = await transaction.insert(jobOpportunities).values({
              id: deps.id(), userId: parsedJob.userId, importId: parsedJob.importId, sourcePostingVersionId: sourceVersion.id,
              dedupKey, company: output.company, title: output.title, location: output.location,
              postedAt: output.postedAt ? new Date(output.postedAt) : null, deadline: output.deadline ? new Date(output.deadline) : null,
              description: output.description, normalizedData: output, createdAt: now, updatedAt: now,
            }).returning({ id: jobOpportunities.id });
            if (!created) throw new Error("JOB_IMPORT_PERSIST_FAILED");
            opportunity = created;
          }
          await transaction.insert(jobOpportunitySources).values({
            userId: parsedJob.userId, opportunityId: opportunity.id, sourcePostingVersionId: sourceVersion.id, createdAt: now,
          }).onConflictDoNothing();
          await deps.auditTrail.bind(transaction).append({
            userId: parsedJob.userId, actorUserId: parsedJob.userId, eventType: "job.import_completed", occurredAt: now,
            requestId: parsedJob.importId, outcome: "success", reasonCode: "JOB_IMPORT_COMPLETED", resourceType: "job_import", resourceId: parsedJob.importId,
            metadata: { importId: parsedJob.importId, sourcePostingId: posting.id, sourcePostingVersionId: sourceVersion.id, opportunityId: opportunity.id, version: sourceVersion.version, inputType, attemptCount: 1 },
          });
          return true;
        });
        return completed ? "completed" : "stale";
      } catch {
        await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, failureCode: "JOB_IMPORT_PERSIST_FAILED" });
        return "failed";
      }
    },
  };
}

export function createJobImportQueries(deps: { db: Database; contentStore: JobContentStore }): {
  list(input: { userId: string }): Promise<JobImportList>;
  get(input: { userId: string; importId: string }): Promise<JobImportDetail | null>;
  getRawContent(input: { userId: string; importId: string }): Promise<{ content: string; filename: string | null } | null>;
} {
  return {
    async list({ userId }) {
      const rows = await deps.db.select({
        id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename, status: jobImports.status,
        failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt,
      }).from(jobImports).where(eq(jobImports.userId, userId)).orderBy(asc(jobImports.createdAt));
      return JobImportListSchema.parse({ imports: rows.map(importBase) });
    },
    async get({ userId, importId }) {
      const [row] = await deps.db.select({
        id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename, status: jobImports.status,
        failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt,
        opportunityId: jobOpportunities.id, company: jobOpportunities.company, title: jobOpportunities.title, location: jobOpportunities.location,
        postedAt: jobOpportunities.postedAt, deadline: jobOpportunities.deadline, description: jobOpportunities.description,
        sourcePostingId: jobSourcePostings.id, sourcePostingVersionId: jobSourcePostingVersions.id, sourceVersion: jobSourcePostingVersions.version,
        retrievedAt: jobSourcePostingVersions.retrievedAt,
      }).from(jobImports)
        .leftJoin(jobSourcePostings, and(
          eq(jobSourcePostings.userId, jobImports.userId), eq(jobSourcePostings.sourceType, "user_import"),
          eq(jobSourcePostings.sourceIdentifier, jobImports.contentSha256),
        ))
        .leftJoin(jobSourcePostingVersions, and(
          eq(jobSourcePostingVersions.userId, jobImports.userId), eq(jobSourcePostingVersions.sourcePostingId, jobSourcePostings.id),
          eq(jobSourcePostingVersions.contentSha256, jobImports.contentSha256),
        ))
        .leftJoin(jobOpportunitySources, and(
          eq(jobOpportunitySources.userId, jobImports.userId), eq(jobOpportunitySources.sourcePostingVersionId, jobSourcePostingVersions.id),
        ))
        .leftJoin(jobOpportunities, and(
          eq(jobOpportunities.userId, jobImports.userId), eq(jobOpportunities.id, jobOpportunitySources.opportunityId),
        ))
        .where(and(eq(jobImports.userId, userId), eq(jobImports.id, importId)));
      if (!row) return null;
      return JobImportDetailSchema.parse({
        ...importBase(row),
        opportunity: row.opportunityId ? {
          opportunityId: row.opportunityId, company: row.company, title: row.title, location: row.location,
          postedAt: row.postedAt?.toISOString() ?? null, deadline: row.deadline?.toISOString() ?? null, description: row.description,
          evidence: { sourcePostingId: row.sourcePostingId, sourcePostingVersionId: row.sourcePostingVersionId, version: row.sourceVersion,
            sourceType: "user_import", retrievedAt: row.retrievedAt?.toISOString(), originalFilename: row.originalFilename },
        } : null,
      });
    },
    async getRawContent({ userId, importId }) {
      const [row] = await deps.db.select({ originalFilename: jobImports.originalFilename }).from(jobImports)
        .where(and(eq(jobImports.userId, userId), eq(jobImports.id, importId)));
      if (!row) return null;
      const bytes = await deps.contentStore.get({ objectKey: sourceObjectKey(userId, importId) });
      return { content: new TextDecoder().decode(bytes), filename: row.originalFilename };
    },
  };
}
