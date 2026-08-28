import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, or } from "drizzle-orm";
import { jobImports, jobOpportunities, jobOpportunitySources, jobSourcePostings, jobSourcePostingVersions, type Database } from "@job-copilot/database";
import {
  CreateJobImportCommandSchema,
  JOB_IMPORT_CLAIM_LEASE_MS,
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
  type JobImportInputType,
} from "@job-copilot/contracts/job-imports";
import type { AuditTrail } from "./audit-trail";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

export interface JobContentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown" | "text/html" | "text/plain"; importId: string }): Promise<void>;
  get(input: { objectKey: string }): Promise<Uint8Array>;
  delete(input: { objectKey: string }): Promise<void>;
}

export interface JobImportQueue {
  enqueue(job: JobImportJob): Promise<void>;
}

export interface JobPostingNormalizer {
  normalize(content: string): Promise<unknown>;
}

export type FetchedUrlJobPage = {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl: string;
  rawHtml: string;
  visibleText: string;
  pageClassification: "job";
  sourceKind: "official" | "aggregator";
};

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

function rawContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceObjectKey(userId: string, importId: string): string {
  return `accounts/${userId}/job-imports/${importId}/source.md`;
}

function rawHtmlObjectKey(userId: string, importId: string): string {
  return `accounts/${userId}/job-imports/${importId}/raw.html`;
}

function visibleTextObjectKey(userId: string, importId: string): string {
  return `accounts/${userId}/job-imports/${importId}/visible.txt`;
}

function response(record: {
  id: string; inputType: string; originalFilename: string | null; status: string; failureCode: string | null; createdAt: Date; updatedAt: Date;
}, reused: boolean): CreateJobImportResult {
  return {
    importId: record.id,
    inputType: record.inputType as JobImportInputType,
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

async function failImport(deps: Pick<ProcessorDependencies, "db" | "auditTrail" | "clock">, input: { userId: string; importId: string; inputType: JobImportInputType; claimToken: string; failureCode: JobImportFailureCode; attemptCount: number }): Promise<boolean> {
  const now = deps.clock();
  return deps.db.transaction(async (transaction) => {
    await acquireAccountAdvisoryLock(transaction, input.userId);
    const [failed] = await transaction.update(jobImports).set({
      status: "failed", failureCode: input.failureCode, claimToken: null, claimExpiresAt: null, updatedAt: now,
    }).where(and(
      eq(jobImports.userId, input.userId), eq(jobImports.id, input.importId),
      eq(jobImports.status, "normalizing"), eq(jobImports.claimToken, input.claimToken),
    )).returning({ id: jobImports.id });
    if (!failed) return false;
    await deps.auditTrail.bind(transaction).append({
      userId: input.userId, actorUserId: input.userId, eventType: "job.import_failed", occurredAt: now,
      requestId: input.importId, outcome: "failure", reasonCode: input.failureCode, resourceType: "job_import", resourceId: input.importId,
      metadata: { importId: input.importId, inputType: input.inputType, attemptCount: input.attemptCount, failureCode: input.failureCode },
    });
    return true;
  });
}

async function releaseImportForRetry(deps: Pick<ProcessorDependencies, "db" | "clock">, input: { userId: string; importId: string; claimToken: string }): Promise<boolean> {
  const [released] = await deps.db.update(jobImports).set({
    status: "imported", failureCode: null, claimToken: null, claimExpiresAt: null, updatedAt: deps.clock(),
  }).where(and(
    eq(jobImports.userId, input.userId), eq(jobImports.id, input.importId),
    eq(jobImports.status, "normalizing"), eq(jobImports.claimToken, input.claimToken),
  )).returning({ id: jobImports.id });
  return Boolean(released);
}

export function createJobImportCommands(deps: CommandDependencies): {
  submit(input: { userId: string; requestId: string; command: CreateJobImportCommand }): Promise<CreateJobImportResult>;
  submitFetchedUrl(input: { userId: string; requestId: string; command: Extract<CreateJobImportCommand, { inputType: "url" }>; page: FetchedUrlJobPage }): Promise<CreateJobImportResult>;
} {
  return {
    async submit(input): Promise<CreateJobImportResult> {
      const command = CreateJobImportCommandSchema.parse(input.command);
      if (command.inputType === "url") throw new Error("JOB_IMPORT_CONTENT_INVALID");
      const rawContent = command.content;
      const content = canonicalContent(rawContent);
      const bytes = new TextEncoder().encode(rawContent);
      if (!content || bytes.byteLength > JOB_IMPORT_MAX_BYTES) throw new Error("JOB_IMPORT_CONTENT_INVALID");

      const checksum = contentHash(content);
      const rawChecksum = rawContentHash(bytes);
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
            const [retried] = await transaction.update(jobImports).set({
              status: "imported", failureCode: null, claimToken: null, claimExpiresAt: null, updatedAt: now,
            }).where(and(
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
          id: importId, userId: input.userId, inputType: command.inputType, contentSha256: checksum, sourceIdentifier: checksum,
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
        const [posting] = await transaction.insert(jobSourcePostings).values({
          id: deps.id(), userId: input.userId, sourceType: "user_import", sourceIdentifier: checksum,
          sourceIdentity: { contentFingerprint: checksum }, isOfficial: false, createdAt: now, updatedAt: now,
        }).returning({ id: jobSourcePostings.id });
        if (!posting) throw new Error("JOB_IMPORT_PERSIST_FAILED");
        const [sourceVersion] = await transaction.insert(jobSourcePostingVersions).values({
          id: deps.id(), userId: input.userId, sourcePostingId: posting.id, version: 1, contentSha256: checksum,
          rawContentSha256: rawChecksum,
          rawObjectReference: { objectKey }, retrievedAt: now, createdAt: now,
        }).returning({ id: jobSourcePostingVersions.id });
        if (!sourceVersion) throw new Error("JOB_IMPORT_PERSIST_FAILED");
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

    async submitFetchedUrl(input): Promise<CreateJobImportResult> {
      const command = CreateJobImportCommandSchema.parse(input.command);
      if (command.inputType !== "url") throw new Error("JOB_IMPORT_CONTENT_INVALID");
      const page = input.page;
      const visibleText = canonicalContent(page.visibleText);
      const visibleBytes = new TextEncoder().encode(page.visibleText);
      const rawBytes = new TextEncoder().encode(page.rawHtml);
      if (!visibleText || visibleBytes.byteLength > 2 * 1024 * 1024 || rawBytes.byteLength > 2 * 1024 * 1024) throw new Error("JOB_IMPORT_CONTENT_INVALID");
      const checksum = contentHash(visibleText);
      const rawChecksum = rawContentHash(rawBytes);
      const sourceIdentifier = sha256(page.canonicalUrl);
      const now = deps.clock();
      let reused = false;
      const storedObjectKeys: string[] = [];
      let record!: { id: string; inputType: string; originalFilename: string | null; status: string; failureCode: string | null; createdAt: Date; updatedAt: Date };
      try {
        record = await deps.db.transaction(async (transaction) => {
          await acquireAccountAdvisoryLock(transaction, input.userId);
          const [existing] = await transaction.select({
            id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename,
            status: jobImports.status, failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt,
          }).from(jobImports).where(and(
            eq(jobImports.userId, input.userId), eq(jobImports.inputType, "url"),
            eq(jobImports.canonicalUrl, page.canonicalUrl), eq(jobImports.contentSha256, checksum),
          ));
          if (existing) {
            reused = true;
            if (existing.status === "failed" || existing.status === "imported") {
              const [retried] = await transaction.update(jobImports).set({
                status: "imported", failureCode: null, claimToken: null, claimExpiresAt: null, updatedAt: now,
              }).where(and(eq(jobImports.userId, input.userId), eq(jobImports.id, existing.id), inArray(jobImports.status, ["failed", "imported"])))
                .returning({ id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename, status: jobImports.status, failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt });
              return retried ?? existing;
            }
            return existing;
          }

          const importId = deps.id();
          const [created] = await transaction.insert(jobImports).values({
            id: importId, userId: input.userId, inputType: "url", contentSha256: checksum, sourceIdentifier,
            requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, canonicalUrl: page.canonicalUrl,
            pageClassification: page.pageClassification, sourceKind: page.sourceKind, status: "imported", createdAt: now, updatedAt: now,
          }).returning({ id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename, status: jobImports.status, failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt });
          if (!created) throw new Error("JOB_IMPORT_PERSIST_FAILED");
          const rawObjectKey = rawHtmlObjectKey(input.userId, importId);
          const visibleObjectKey = visibleTextObjectKey(input.userId, importId);
          try {
            await deps.contentStore.put({ objectKey: rawObjectKey, bytes: rawBytes, mediaType: "text/html", importId });
            storedObjectKeys.push(rawObjectKey);
            await deps.contentStore.put({ objectKey: visibleObjectKey, bytes: visibleBytes, mediaType: "text/plain", importId });
            storedObjectKeys.push(visibleObjectKey);
          } catch { throw new JobImportError("JOB_IMPORT_OBJECT_STORAGE_FAILED"); }

          let [posting] = await transaction.select({ id: jobSourcePostings.id, isOfficial: jobSourcePostings.isOfficial })
            .from(jobSourcePostings).where(and(eq(jobSourcePostings.userId, input.userId), eq(jobSourcePostings.sourceType, "url_import"), eq(jobSourcePostings.sourceIdentifier, sourceIdentifier)));
          if (!posting) {
            const [createdPosting] = await transaction.insert(jobSourcePostings).values({
              id: deps.id(), userId: input.userId, sourceType: "url_import", sourceIdentifier,
              sourceIdentity: { canonicalUrl: page.canonicalUrl }, isOfficial: page.sourceKind === "official", createdAt: now, updatedAt: now,
            }).returning({ id: jobSourcePostings.id, isOfficial: jobSourcePostings.isOfficial });
            if (!createdPosting) throw new Error("JOB_IMPORT_PERSIST_FAILED");
            posting = createdPosting;
          } else if (page.sourceKind === "official" && !posting.isOfficial) {
            await transaction.update(jobSourcePostings).set({ isOfficial: true, updatedAt: now }).where(eq(jobSourcePostings.id, posting.id));
            posting = { ...posting, isOfficial: true };
          }
          const [sameVersion] = await transaction.select({ id: jobSourcePostingVersions.id }).from(jobSourcePostingVersions).where(and(
            eq(jobSourcePostingVersions.userId, input.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id), eq(jobSourcePostingVersions.contentSha256, checksum),
          ));
          if (!sameVersion) {
            const [latestVersion] = await transaction.select({ version: jobSourcePostingVersions.version }).from(jobSourcePostingVersions)
              .where(and(eq(jobSourcePostingVersions.userId, input.userId), eq(jobSourcePostingVersions.sourcePostingId, posting.id))).orderBy(desc(jobSourcePostingVersions.version)).limit(1);
            const [sourceVersion] = await transaction.insert(jobSourcePostingVersions).values({
              id: deps.id(), userId: input.userId, sourcePostingId: posting.id, version: (latestVersion?.version ?? 0) + 1,
              contentSha256: checksum, rawContentSha256: rawChecksum, rawObjectReference: { rawObjectKey, visibleObjectKey }, retrievedAt: now, createdAt: now,
            }).returning({ id: jobSourcePostingVersions.id });
            if (!sourceVersion) throw new Error("JOB_IMPORT_PERSIST_FAILED");
          }
          await deps.auditTrail.bind(transaction).append({
            userId: input.userId, actorUserId: input.userId, eventType: "job.import_submitted", occurredAt: now,
            requestId: input.requestId, outcome: "success", reasonCode: "JOB_IMPORT_SUBMITTED", resourceType: "job_import", resourceId: importId,
            metadata: { importId, inputType: "url" },
          });
          return created;
        });
      } catch (error) {
        for (const objectKey of storedObjectKeys) {
          try { await deps.contentStore.delete({ objectKey }); } catch { /* 保留原始失败。 */ }
        }
        throw error;
      }
      try { await deps.queue.enqueue({ version: 1, importId: record.id, userId: input.userId }); }
      catch { throw new JobImportError("JOB_IMPORT_QUEUE_UNAVAILABLE"); }
      return response(record, reused);
    },
  };
}

export function createJobImportProcessor(deps: ProcessorDependencies): {
  process(job: JobImportJob & { finalAttempt: boolean; attemptCount?: number }): Promise<"completed" | "failed" | "stale">;
} {
  return {
    async process(job): Promise<"completed" | "failed" | "stale"> {
      const parsedJob = JobImportJobSchema.parse({ version: job.version, importId: job.importId, userId: job.userId });
      const attemptCount = job.attemptCount ?? 1;
      const now = deps.clock();
      const claimToken = deps.id();
      const claimExpiresAt = new Date(now.getTime() + JOB_IMPORT_CLAIM_LEASE_MS);
      const [record] = await deps.db.update(jobImports).set({
        status: "normalizing", failureCode: null, claimToken, claimExpiresAt, updatedAt: now,
      }).where(and(
        eq(jobImports.userId, parsedJob.userId), eq(jobImports.id, parsedJob.importId), or(
          eq(jobImports.status, "imported"),
          and(eq(jobImports.status, "normalizing"), lte(jobImports.claimExpiresAt, now)),
        ),
      )).returning({
        id: jobImports.id, inputType: jobImports.inputType, contentSha256: jobImports.contentSha256, sourceIdentifier: jobImports.sourceIdentifier,
      });
      if (!record) {
        const [current] = await deps.db.select({ status: jobImports.status, claimExpiresAt: jobImports.claimExpiresAt }).from(jobImports)
          .where(and(eq(jobImports.userId, parsedJob.userId), eq(jobImports.id, parsedJob.importId)));
        if (current?.status === "normalizing" && current.claimExpiresAt && current.claimExpiresAt > now) throw new JobImportRetryableError();
        return "stale";
      }
      const inputType = record.inputType as JobImportInputType;
      const [sourceVersion] = await deps.db.select({
        sourcePostingId: jobSourcePostings.id, id: jobSourcePostingVersions.id, version: jobSourcePostingVersions.version,
        rawContentSha256: jobSourcePostingVersions.rawContentSha256, isOfficial: jobSourcePostings.isOfficial,
      }).from(jobSourcePostings).innerJoin(jobSourcePostingVersions, and(
        eq(jobSourcePostingVersions.userId, jobSourcePostings.userId), eq(jobSourcePostingVersions.sourcePostingId, jobSourcePostings.id),
      )).where(and(
        eq(jobSourcePostings.userId, parsedJob.userId), eq(jobSourcePostings.sourceIdentifier, record.sourceIdentifier),
        eq(jobSourcePostingVersions.contentSha256, record.contentSha256),
      ));
      let bytes: Uint8Array;
      try {
        if (!sourceVersion) throw new Error("source version missing");
        bytes = await deps.contentStore.get({ objectKey: inputType === "url" ? visibleTextObjectKey(parsedJob.userId, parsedJob.importId) : sourceObjectKey(parsedJob.userId, parsedJob.importId) });
      } catch {
        if (!job.finalAttempt) {
          await releaseImportForRetry(deps, { ...parsedJob, claimToken });
          throw new JobImportRetryableError();
        }
        return await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, claimToken, failureCode: "JOB_IMPORT_CONTENT_READ_FAILED", attemptCount }) ? "failed" : "stale";
      }
      if (inputType !== "url" && rawContentHash(bytes) !== sourceVersion.rawContentSha256) {
        if (!job.finalAttempt) {
          await releaseImportForRetry(deps, { ...parsedJob, claimToken });
          throw new JobImportRetryableError();
        }
        return await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, claimToken, failureCode: "JOB_IMPORT_CHECKSUM_MISMATCH", attemptCount }) ? "failed" : "stale";
      }
      const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      const canonical = canonicalContent(content);
      if (sha256(canonical) !== record.contentSha256) {
        return await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, claimToken, failureCode: "JOB_IMPORT_CHECKSUM_MISMATCH", attemptCount }) ? "failed" : "stale";
      }
      let normalized: unknown;
      try {
        normalized = await deps.normalizer.normalize(canonical);
      } catch {
        if (!job.finalAttempt) {
          await releaseImportForRetry(deps, { ...parsedJob, claimToken });
          throw new JobImportRetryableError();
        }
        return await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, claimToken, failureCode: "JOB_IMPORT_PERSIST_FAILED", attemptCount }) ? "failed" : "stale";
      }
      const result = JobNormalizerOutputSchema.safeParse(normalized);
      if (!result.success) {
        return await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, claimToken, failureCode: "JOB_NORMALIZER_OUTPUT_INVALID", attemptCount }) ? "failed" : "stale";
      }
      const output = result.data;
      try {
        const completed = await deps.db.transaction(async (transaction) => {
          await acquireAccountAdvisoryLock(transaction, parsedJob.userId);
          const [completionClaimed] = await transaction.update(jobImports).set({
            status: "completed", failureCode: null, claimToken: null, claimExpiresAt: null, updatedAt: now,
          }).where(and(
            eq(jobImports.userId, parsedJob.userId), eq(jobImports.id, parsedJob.importId),
            eq(jobImports.status, "normalizing"), eq(jobImports.claimToken, claimToken),
          )).returning({ id: jobImports.id });
          if (!completionClaimed) return false;

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
          } else if (sourceVersion.isOfficial) {
            await transaction.update(jobOpportunities).set({ sourcePostingVersionId: sourceVersion.id, updatedAt: now })
              .where(and(eq(jobOpportunities.userId, parsedJob.userId), eq(jobOpportunities.id, opportunity.id)));
          }
          await transaction.insert(jobOpportunitySources).values({
            userId: parsedJob.userId, opportunityId: opportunity.id, sourcePostingVersionId: sourceVersion.id, createdAt: now,
          }).onConflictDoNothing();
          await deps.auditTrail.bind(transaction).append({
            userId: parsedJob.userId, actorUserId: parsedJob.userId, eventType: "job.import_completed", occurredAt: now,
            requestId: parsedJob.importId, outcome: "success", reasonCode: "JOB_IMPORT_COMPLETED", resourceType: "job_import", resourceId: parsedJob.importId,
            metadata: { importId: parsedJob.importId, sourcePostingId: sourceVersion.sourcePostingId, sourcePostingVersionId: sourceVersion.id, opportunityId: opportunity.id, version: sourceVersion.version, inputType, attemptCount },
          });
          return true;
        });
        return completed ? "completed" : "stale";
      } catch {
        return await failImport(deps, { userId: parsedJob.userId, importId: parsedJob.importId, inputType, claimToken, failureCode: "JOB_IMPORT_PERSIST_FAILED", attemptCount }) ? "failed" : "stale";
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
      }).from(jobImports).where(eq(jobImports.userId, userId)).orderBy(desc(jobImports.createdAt), desc(jobImports.id)).limit(20);
      return JobImportListSchema.parse({ imports: rows.map(importBase) });
    },
    async get({ userId, importId }) {
      const [row] = await deps.db.select({
        id: jobImports.id, inputType: jobImports.inputType, originalFilename: jobImports.originalFilename, status: jobImports.status,
        failureCode: jobImports.failureCode, createdAt: jobImports.createdAt, updatedAt: jobImports.updatedAt,
        requestedUrl: jobImports.requestedUrl, finalUrl: jobImports.finalUrl, canonicalUrl: jobImports.canonicalUrl,
        pageClassification: jobImports.pageClassification, sourceKind: jobImports.sourceKind, sourceIdentifier: jobImports.sourceIdentifier,
        opportunityId: jobOpportunities.id, company: jobOpportunities.company, title: jobOpportunities.title, location: jobOpportunities.location,
        postedAt: jobOpportunities.postedAt, deadline: jobOpportunities.deadline, description: jobOpportunities.description,
        sourcePostingId: jobSourcePostings.id, sourcePostingVersionId: jobSourcePostingVersions.id, sourceVersion: jobSourcePostingVersions.version,
        retrievedAt: jobSourcePostingVersions.retrievedAt,
      }).from(jobImports)
        .leftJoin(jobSourcePostings, and(
          eq(jobSourcePostings.userId, jobImports.userId), eq(jobSourcePostings.sourceIdentifier, jobImports.sourceIdentifier),
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
            sourceType: row.inputType === "url" ? "url_import" : "user_import", retrievedAt: row.retrievedAt?.toISOString(), originalFilename: row.originalFilename,
            requestedUrl: row.requestedUrl, finalUrl: row.finalUrl, canonicalUrl: row.canonicalUrl,
            pageClassification: row.pageClassification, sourceKind: row.sourceKind },
        } : null,
      });
    },
    async getRawContent({ userId, importId }) {
      const [row] = await deps.db.select({
        originalFilename: jobImports.originalFilename, inputType: jobImports.inputType, contentSha256: jobImports.contentSha256,
        rawContentSha256: jobSourcePostingVersions.rawContentSha256, rawObjectReference: jobSourcePostingVersions.rawObjectReference,
      })
        .from(jobImports)
        .leftJoin(jobSourcePostings, and(
          eq(jobSourcePostings.userId, jobImports.userId), eq(jobSourcePostings.sourceIdentifier, jobImports.sourceIdentifier),
        ))
        .leftJoin(jobSourcePostingVersions, and(
          eq(jobSourcePostingVersions.userId, jobImports.userId), eq(jobSourcePostingVersions.sourcePostingId, jobSourcePostings.id),
          eq(jobSourcePostingVersions.contentSha256, jobImports.contentSha256),
      ))
        .where(and(eq(jobImports.userId, userId), eq(jobImports.id, importId)));
      if (!row) return null;
      const objectKey = row.inputType === "url"
        ? (typeof row.rawObjectReference === "object" && row.rawObjectReference !== null && "visibleObjectKey" in row.rawObjectReference && typeof row.rawObjectReference.visibleObjectKey === "string" ? row.rawObjectReference.visibleObjectKey : null)
        : sourceObjectKey(userId, importId);
      if (!objectKey) throw new Error("JOB_IMPORT_CHECKSUM_MISMATCH");
      const bytes = await deps.contentStore.get({ objectKey });
      const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      if (row.inputType === "url") {
        if (contentHash(canonicalContent(content)) !== row.contentSha256) throw new Error("JOB_IMPORT_CHECKSUM_MISMATCH");
      } else if (!row.rawContentSha256 || rawContentHash(bytes) !== row.rawContentSha256) throw new Error("JOB_IMPORT_CHECKSUM_MISMATCH");
      return { content, filename: row.originalFilename };
    },
  };
}
