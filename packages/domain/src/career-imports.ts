import { createHash } from "node:crypto";
import { and, asc, desc, eq, ne, or, sql } from "drizzle-orm";
import {
  candidateFactEvidence,
  candidateFactDecisions,
  candidateFacts,
  careerDocuments,
  careerImports,
  protectedCareerDocuments,
  careerFactConflicts,
  type Database,
} from "@job-copilot/database";
import {
  CareerImportJobSchema,
  CAREER_IMPORT_MAX_FACTS,
  parseQuotedCareerFactValue,
  type CreateCareerImportResponse,
  CareerParserOutputSchema,
  type CareerImportDetail,
  type CareerImportFailureCode,
  type CareerImportJob,
  type CareerImportStatus,
  type CareerImportSummary,
  type CareerDocumentSourceFormat,
  type CareerDocumentPrivacyStatus,
  type CareerParserFact,
} from "@job-copilot/contracts/career-import";
import { CAREER_PRIVACY_SCAN_VERSION } from "@job-copilot/contracts/career-document-privacy";
import { mapPdfTextLineRangeToPages } from "@job-copilot/contracts/pdf-career-processing";
import type { AuditTrail } from "./audit-trail";
import { detectCareerFactConflict } from "./career-fact-conflicts";
import { acquireAccountAdvisoryLock } from "./account-advisory-lock";

const parserAdapter = "fake";
const parserVersion = "fake-career-parser-v1";
const promptVersion = "career-import-prompt-v1";
const outputSchemaVersion = "career-facts-v1";

export interface CareerDocumentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown" | "text/plain" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/pdf"; documentId: string }): Promise<void>;
  get(input: { objectKey: string }): Promise<Uint8Array>;
}

export interface CareerImportQueue {
  enqueue(job: CareerImportJob): Promise<void>;
}

export interface CareerDocumentParser {
  parse(markdown: string): Promise<unknown>;
}

export class CareerImportError extends Error {
  constructor(public readonly code: "CAREER_IMPORT_QUEUE_UNAVAILABLE") {
    super(code);
  }
}

export type CreateOrReuseInput = {
  userId: string;
  requestId: string;
  bytes: Uint8Array;
  originalFilename: string;
  mediaType: "text/markdown" | "text/plain";
  sourceFormat?: "markdown" | "docx" | "pdf";
  privacyScanVersion?: string;
  protectedOriginal?: {
    bytes: Uint8Array;
    originalFilename: string;
    mediaType?: "text/markdown" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/pdf";
  };
};

export type CreateOrReuseResult = CreateCareerImportResponse & {
  shouldReturnAccepted: boolean;
};

type CommandDependencies = {
  db: Database;
  auditTrail: AuditTrail;
  documentStore: CareerDocumentStore;
  queue: CareerImportQueue;
  id: () => string;
  clock: () => Date;
};

type ProcessorDependencies = {
  db: Database;
  auditTrail: AuditTrail;
  documentStore: CareerDocumentStore;
  parser: CareerDocumentParser;
  id: () => string;
  clock: () => Date;
};

type ImportRecord = {
  id: string;
  userId: string;
  documentId: string;
  objectKey: string;
  originalFilename: string;
  sourceFormat: string;
  checksumSha256: string;
  privacyScanVersion: string | null;
  status: string;
  attemptCount: number;
  originatingRequestId: string;
};

class StableImportFailure extends Error {
  constructor(public readonly code: CareerImportFailureCode) {
    super(code);
  }
}

class StaleImportAttempt extends Error {}

class RetryableImportFailure extends Error {
  constructor() {
    super("career import temporarily unavailable");
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectKey(userId: string, documentId: string, privacyScanVersion?: string, sourceFormat: "markdown" | "docx" | "pdf" = "markdown"): string {
  const extension = sourceFormat === "markdown" ? "md" : "txt";
  const filename = privacyScanVersion ? `processing.${extension}` : `source.${extension}`;
  return `accounts/${userId}/career-documents/${documentId}/${filename}`;
}

function protectedObjectKey(userId: string, documentId: string, mediaType: "text/markdown" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/pdf" = "text/markdown"): string {
  const extension = mediaType === "application/pdf" ? "pdf" : mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? "docx" : "md";
  return `accounts/${userId}/protected-career-documents/${documentId}/original.${extension}`;
}

function privacyStatus(input: {
  privacyScanVersion: string | null | undefined;
  protectedOriginalStored: boolean;
}): CareerDocumentPrivacyStatus {
  if (input.privacyScanVersion !== CAREER_PRIVACY_SCAN_VERSION) return "legacy_unreviewed";
  return input.protectedOriginalStored
    ? "sanitized_with_protected_original"
    : "sanitized_only";
}

function protectedOriginalCount() {
  return sql<number>`(
    select count(*)::int from ${protectedCareerDocuments}
    where ${protectedCareerDocuments.processingDocumentId} = ${careerDocuments.id}
      and ${protectedCareerDocuments.userId} = ${careerDocuments.userId}
  )`;
}

function persistedPrivacyStatus(record: {
  privacyScanVersion: string | null;
  protectedOriginalCount: number;
}): CareerDocumentPrivacyStatus {
  return privacyStatus({
    privacyScanVersion: record.privacyScanVersion,
    protectedOriginalStored: record.protectedOriginalCount > 0,
  });
}

function toIso(value: Date): string {
  return value.toISOString();
}

function baseImport(record: {
  importId: string;
  documentId: string;
  sourceFilename: string;
  sourceFormat: string;
  privacyStatus: CareerDocumentPrivacyStatus;
  status: string;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Omit<CareerImportSummary, "candidateFactCount"> {
  return {
    importId: record.importId,
    documentId: record.documentId,
    sourceFilename: record.sourceFilename,
    sourceFormat: record.sourceFormat as "markdown" | "docx" | "pdf",
    privacyStatus: record.privacyStatus,
    status: record.status as CareerImportStatus,
    failureCode: record.failureCode as CareerImportFailureCode | null,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

function summary(record: Parameters<typeof baseImport>[0] & { candidateFactCount: number }): CareerImportSummary {
  return { ...baseImport(record), candidateFactCount: record.candidateFactCount };
}

function createResponse(record: Parameters<typeof baseImport>[0], reused: boolean): CreateCareerImportResponse {
  return {
    ...baseImport(record),
    reused,
    detailUrl: `/v1/career-documents/imports/${record.importId}`,
  };
}

function normalizeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizeJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${normalizeJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function factKey(input: { parserVersion: string; factType: string; factValue: unknown; startLine: number; endLine: number }): string {
  return sha256(`${input.parserVersion}:${input.factType}:${normalizeJson(input.factValue)}:${input.startLine}:${input.endLine}`);
}

function isMissingDocument(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && (error as { code?: unknown }).code === "CAREER_DOCUMENT_NOT_FOUND";
}

function exceedsCareerImportFactLimit(output: unknown): boolean {
  return typeof output === "object" && output !== null
    && "facts" in output
    && Array.isArray(output.facts)
    && output.facts.length > CAREER_IMPORT_MAX_FACTS;
}

async function findImport(db: Database, input: { userId: string; importId: string }): Promise<ImportRecord | undefined> {
  const [record] = await db.select({
    id: careerImports.id,
    userId: careerImports.userId,
    documentId: careerDocuments.id,
    objectKey: careerDocuments.objectKey,
    originalFilename: careerDocuments.originalFilename,
    sourceFormat: careerDocuments.sourceFormat,
    checksumSha256: careerDocuments.checksumSha256,
    privacyScanVersion: careerDocuments.privacyScanVersion,
    status: careerImports.status,
    attemptCount: careerImports.attemptCount,
    originatingRequestId: careerImports.originatingRequestId,
  }).from(careerImports)
    .innerJoin(careerDocuments, and(
      eq(careerDocuments.id, careerImports.careerDocumentId),
      eq(careerDocuments.userId, careerImports.userId),
    ))
    .where(and(eq(careerImports.id, input.importId), eq(careerImports.userId, input.userId)));
  return record;
}

export function createCareerImportCommands(deps: CommandDependencies): {
  createOrReuse(input: CreateOrReuseInput): Promise<CreateOrReuseResult>;
} {
  return {
    async createOrReuse(input): Promise<CreateOrReuseResult> {
      const checksumSha256 = sha256(input.bytes);
      const now = deps.clock();
      let [document] = await deps.db.select({
        id: careerDocuments.id,
        objectKey: careerDocuments.objectKey,
        originalFilename: careerDocuments.originalFilename,
        sourceFormat: careerDocuments.sourceFormat,
        privacyScanVersion: careerDocuments.privacyScanVersion,
      }).from(careerDocuments).where(and(
        eq(careerDocuments.userId, input.userId),
        eq(careerDocuments.checksumSha256, checksumSha256),
        eq(careerDocuments.sourceFormat, input.sourceFormat ?? "markdown"),
      ));
      let reused = false;

      if (!document) {
        const documentId = deps.id();
        const key = objectKey(input.userId, documentId, input.privacyScanVersion, input.sourceFormat ?? "markdown");
        document = await deps.db.transaction(async (transaction) => {
          const [created] = await transaction.insert(careerDocuments).values({
            id: documentId,
            userId: input.userId,
            checksumSha256,
            objectKey: key,
            originalFilename: input.originalFilename,
            sourceFormat: input.sourceFormat ?? "markdown",
            mediaType: input.mediaType,
            byteSize: input.bytes.byteLength,
            privacyScanVersion: input.privacyScanVersion,
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing().returning({
            id: careerDocuments.id,
            objectKey: careerDocuments.objectKey,
            originalFilename: careerDocuments.originalFilename,
            sourceFormat: careerDocuments.sourceFormat,
            privacyScanVersion: careerDocuments.privacyScanVersion,
          });
          if (created) {
            await deps.documentStore.put({ objectKey: key, bytes: input.bytes, mediaType: input.mediaType, documentId });
            return created;
          }
          const [existing] = await transaction.select({
            id: careerDocuments.id,
            objectKey: careerDocuments.objectKey,
            originalFilename: careerDocuments.originalFilename,
            sourceFormat: careerDocuments.sourceFormat,
            privacyScanVersion: careerDocuments.privacyScanVersion,
          }).from(careerDocuments).where(and(
            eq(careerDocuments.userId, input.userId),
            eq(careerDocuments.checksumSha256, checksumSha256),
            eq(careerDocuments.sourceFormat, input.sourceFormat ?? "markdown"),
          ));
          if (!existing) throw new Error("无法读取职业资料");
          reused = true;
          return existing;
        });
      }

      if (!document) throw new Error("无法创建职业资料");

      if (input.privacyScanVersion && !document.privacyScanVersion) {
        const [upgraded] = await deps.db.update(careerDocuments).set({
          privacyScanVersion: input.privacyScanVersion,
          updatedAt: now,
        }).where(and(
          eq(careerDocuments.id, document.id),
          eq(careerDocuments.userId, input.userId),
          sql`${careerDocuments.privacyScanVersion} is null`,
        )).returning({ privacyScanVersion: careerDocuments.privacyScanVersion });
        document.privacyScanVersion = upgraded?.privacyScanVersion ?? input.privacyScanVersion;
      }

      let protectedOriginalStored = false;
      if (input.protectedOriginal) {
        const originalChecksum = sha256(input.protectedOriginal.bytes);
        const [existingOriginal] = await deps.db.select({ id: protectedCareerDocuments.id })
          .from(protectedCareerDocuments).where(and(
            eq(protectedCareerDocuments.userId, input.userId),
            eq(protectedCareerDocuments.processingDocumentId, document.id),
            eq(protectedCareerDocuments.checksumSha256, originalChecksum),
          ));
        if (existingOriginal) {
          protectedOriginalStored = true;
        } else {
          const protectedDocumentId = deps.id();
          const key = protectedObjectKey(input.userId, protectedDocumentId, input.protectedOriginal.mediaType ?? "text/markdown");
          protectedOriginalStored = await deps.db.transaction(async (transaction) => {
            const [created] = await transaction.insert(protectedCareerDocuments).values({
              id: protectedDocumentId,
              userId: input.userId,
              processingDocumentId: document.id,
              checksumSha256: originalChecksum,
              objectKey: key,
              originalFilename: input.protectedOriginal!.originalFilename,
              mediaType: input.protectedOriginal!.mediaType ?? input.mediaType,
              byteSize: input.protectedOriginal!.bytes.byteLength,
              createdAt: now,
            }).onConflictDoNothing().returning({ id: protectedCareerDocuments.id });
            if (!created) return true;
            await deps.documentStore.put({
              objectKey: key,
              bytes: input.protectedOriginal!.bytes,
              mediaType: input.protectedOriginal!.mediaType ?? input.mediaType,
              documentId: protectedDocumentId,
            });
            return true;
          });
        }
      }
      if (!protectedOriginalStored) {
        const [persistedOriginal] = await deps.db.select({ id: protectedCareerDocuments.id })
          .from(protectedCareerDocuments).where(and(
            eq(protectedCareerDocuments.userId, input.userId),
            eq(protectedCareerDocuments.processingDocumentId, document.id),
          )).limit(1);
        protectedOriginalStored = Boolean(persistedOriginal);
      }

      let [storedImport] = await deps.db.select({
        id: careerImports.id,
        status: careerImports.status,
        failureCode: careerImports.failureCode,
        attemptCount: careerImports.attemptCount,
        createdAt: careerImports.createdAt,
        updatedAt: careerImports.updatedAt,
      }).from(careerImports).where(and(
        eq(careerImports.userId, input.userId),
        eq(careerImports.careerDocumentId, document.id),
        eq(careerImports.parserVersion, parserVersion),
        eq(careerImports.promptVersion, promptVersion),
        eq(careerImports.outputSchemaVersion, outputSchemaVersion),
      ));
      reused = Boolean(storedImport);
      let shouldEnqueue = false;
      let shouldReturnAccepted = false;

      if (!storedImport) {
        const importId = deps.id();
        storedImport = await deps.db.transaction(async (transaction) => {
          const [created] = await transaction.insert(careerImports).values({
            id: importId,
            userId: input.userId,
            careerDocumentId: document.id,
            status: "queued",
            parserAdapter,
            parserVersion,
            promptVersion,
            outputSchemaVersion,
            originatingRequestId: input.requestId,
            queuedAt: now,
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing().returning({
            id: careerImports.id,
            status: careerImports.status,
            failureCode: careerImports.failureCode,
            attemptCount: careerImports.attemptCount,
            createdAt: careerImports.createdAt,
            updatedAt: careerImports.updatedAt,
          });
          if (created) {
            await deps.auditTrail.bind(transaction).append({
              userId: input.userId,
              actorUserId: input.userId,
              eventType: "career.document_import_queued",
              occurredAt: now,
              requestId: input.requestId,
              outcome: "success",
              reasonCode: "CAREER_DOCUMENT_IMPORT_QUEUED",
              resourceType: "career_import",
              resourceId: importId,
              metadata: { documentId: document.id, importId },
            });
            return created;
          }
          const [existing] = await transaction.select({
            id: careerImports.id,
            status: careerImports.status,
            failureCode: careerImports.failureCode,
            attemptCount: careerImports.attemptCount,
            createdAt: careerImports.createdAt,
            updatedAt: careerImports.updatedAt,
          }).from(careerImports).where(and(
            eq(careerImports.userId, input.userId),
            eq(careerImports.careerDocumentId, document.id),
            eq(careerImports.parserVersion, parserVersion),
            eq(careerImports.promptVersion, promptVersion),
            eq(careerImports.outputSchemaVersion, outputSchemaVersion),
          ));
          if (!existing) throw new Error("无法读取职业资料导入");
          reused = true;
          return existing;
        });
        shouldEnqueue = true;
        shouldReturnAccepted = !reused;
      } else if (storedImport.status === "failed") {
        const requeued = await deps.db.transaction(async (transaction) => {
          const [updated] = await transaction.update(careerImports).set({
            status: "queued",
            failureCode: null,
            queuedAt: now,
            processingStartedAt: null,
            failedAt: null,
            updatedAt: now,
          }).where(and(eq(careerImports.id, storedImport.id), eq(careerImports.status, "failed"))).returning({
            id: careerImports.id,
            status: careerImports.status,
            failureCode: careerImports.failureCode,
            attemptCount: careerImports.attemptCount,
            createdAt: careerImports.createdAt,
            updatedAt: careerImports.updatedAt,
          });
          if (!updated) return undefined;
          await deps.auditTrail.bind(transaction).append({
            userId: input.userId,
            actorUserId: input.userId,
            eventType: "career.document_import_queued",
            occurredAt: now,
            requestId: input.requestId,
            outcome: "success",
            reasonCode: "CAREER_DOCUMENT_IMPORT_QUEUED",
            resourceType: "career_import",
            resourceId: storedImport.id,
            metadata: { documentId: document.id, importId: storedImport.id },
          });
          return updated;
        });
        if (requeued) {
          storedImport = requeued;
          shouldEnqueue = true;
          shouldReturnAccepted = true;
        } else {
          const [current] = await deps.db.select({
            id: careerImports.id,
            status: careerImports.status,
            failureCode: careerImports.failureCode,
            attemptCount: careerImports.attemptCount,
            createdAt: careerImports.createdAt,
            updatedAt: careerImports.updatedAt,
          }).from(careerImports).where(and(
            eq(careerImports.id, storedImport.id),
            eq(careerImports.userId, input.userId),
          ));
          if (!current) throw new Error("无法读取职业资料导入");
          storedImport = current;
          shouldEnqueue = current.status === "queued" || current.status === "processing";
        }
      } else if (storedImport.status === "queued" || storedImport.status === "processing") {
        shouldEnqueue = true;
      }

      if (shouldEnqueue) {
        try {
          await deps.queue.enqueue(CareerImportJobSchema.parse({ version: 1, importId: storedImport.id, userId: input.userId }));
        } catch (error) {
          await deps.db.transaction(async (transaction) => {
            const [failed] = await transaction.update(careerImports).set({
              status: "failed",
              failureCode: "CAREER_IMPORT_QUEUE_UNAVAILABLE",
              failedAt: now,
              updatedAt: now,
            }).where(and(eq(careerImports.id, storedImport.id), eq(careerImports.status, "queued"))).returning({ id: careerImports.id });
            if (failed) {
              await deps.auditTrail.bind(transaction).append({
                userId: input.userId,
                actorUserId: input.userId,
                eventType: "career.document_import_failed",
                occurredAt: now,
                requestId: input.requestId,
                outcome: "failure",
                reasonCode: "CAREER_IMPORT_QUEUE_UNAVAILABLE",
                resourceType: "career_import",
                resourceId: storedImport.id,
                metadata: { documentId: document.id, importId: storedImport.id, attemptCount: storedImport.attemptCount, failureCode: "CAREER_IMPORT_QUEUE_UNAVAILABLE" },
              });
            }
          });
          throw new CareerImportError("CAREER_IMPORT_QUEUE_UNAVAILABLE");
        }
      }

      return {
        ...createResponse({
          importId: storedImport.id,
          documentId: document.id,
          sourceFilename: document.originalFilename,
          sourceFormat: document.sourceFormat as CareerDocumentSourceFormat,
          privacyStatus: privacyStatus({
            privacyScanVersion: document.privacyScanVersion,
            protectedOriginalStored,
          }),
          status: storedImport.status,
          failureCode: storedImport.failureCode,
          createdAt: storedImport.createdAt,
          updatedAt: storedImport.updatedAt,
        }, reused),
        shouldReturnAccepted,
      };
    },
  };
}

export function createCareerImportQueries(deps: { db: Database }): {
  list(input: { userId: string }): Promise<CareerImportSummary[]>;
  get(input: { userId: string; importId: string }): Promise<CareerImportDetail | null>;
} {
  return {
    async list({ userId }): Promise<CareerImportSummary[]> {
      const records = await deps.db.select({
        importId: careerImports.id,
        documentId: careerDocuments.id,
        sourceFilename: careerDocuments.originalFilename,
        sourceFormat: careerDocuments.sourceFormat,
        privacyScanVersion: careerDocuments.privacyScanVersion,
        status: careerImports.status,
        failureCode: careerImports.failureCode,
        createdAt: careerImports.createdAt,
        updatedAt: careerImports.updatedAt,
        candidateFactCount: sql<number>`(
          select count(*)::int from ${candidateFacts}
          where ${candidateFacts.careerImportId} = ${careerImports.id}
            and ${candidateFacts.userId} = ${careerImports.userId}
        )`,
        protectedOriginalCount: protectedOriginalCount(),
      }).from(careerImports).innerJoin(careerDocuments, and(
        eq(careerDocuments.id, careerImports.careerDocumentId),
        eq(careerDocuments.userId, careerImports.userId),
      ))
        .where(eq(careerImports.userId, userId)).orderBy(desc(careerImports.createdAt)).limit(20);
      return records.map((record) => summary({
        ...record,
        privacyStatus: persistedPrivacyStatus(record),
      }));
    },

    async get({ userId, importId }): Promise<CareerImportDetail | null> {
      const [record] = await deps.db.select({
        importId: careerImports.id,
        documentId: careerDocuments.id,
        sourceFilename: careerDocuments.originalFilename,
        sourceFormat: careerDocuments.sourceFormat,
        privacyScanVersion: careerDocuments.privacyScanVersion,
        status: careerImports.status,
        failureCode: careerImports.failureCode,
        createdAt: careerImports.createdAt,
        updatedAt: careerImports.updatedAt,
        protectedOriginalCount: protectedOriginalCount(),
      }).from(careerImports).innerJoin(careerDocuments, and(
        eq(careerDocuments.id, careerImports.careerDocumentId),
        eq(careerDocuments.userId, careerImports.userId),
      ))
        .where(and(eq(careerImports.userId, userId), eq(careerImports.id, importId)));
      if (!record) return null;

      const facts = record.status === "completed"
        ? await deps.db.select({
          factId: candidateFacts.id,
          factType: candidateFacts.factType,
          factValue: candidateFacts.factValue,
          confidenceBasisPoints: candidateFacts.confidenceBasisPoints,
          confirmationStatus: candidateFacts.confirmationStatus,
          createdAt: candidateFacts.createdAt,
          locatorType: candidateFactEvidence.locatorType,
          startLine: candidateFactEvidence.startLine,
          endLine: candidateFactEvidence.endLine,
          excerpt: candidateFactEvidence.excerpt,
        }).from(candidateFacts).innerJoin(candidateFactEvidence, and(
          eq(candidateFactEvidence.candidateFactId, candidateFacts.id),
          eq(candidateFactEvidence.userId, candidateFacts.userId),
          eq(candidateFactEvidence.careerDocumentId, candidateFacts.careerDocumentId),
        ))
          .where(and(
            eq(candidateFacts.userId, userId),
            eq(candidateFacts.careerImportId, importId),
            sql`not exists (
              select 1 from ${candidateFactDecisions}
              where ${candidateFactDecisions.userId} = ${candidateFacts.userId}
                and ${candidateFactDecisions.candidateFactId} = ${candidateFacts.id}
            )`,
          ))
          .orderBy(asc(candidateFacts.createdAt))
        : [];
      const conflicts = record.status === "completed" ? await deps.db.select({
        conflictId: careerFactConflicts.id, kind: careerFactConflicts.kind, status: careerFactConflicts.status,
        existingFactId: careerFactConflicts.existingCandidateFactId, incomingFactId: careerFactConflicts.incomingCandidateFactId,
        resolution: careerFactConflicts.resolution, profileVersion: careerFactConflicts.profileVersion, resolvedAt: careerFactConflicts.resolvedAt,
      }).from(careerFactConflicts).where(and(eq(careerFactConflicts.userId, userId), sql`(
        ${careerFactConflicts.incomingCandidateFactId} in (select ${candidateFacts.id} from ${candidateFacts} where ${candidateFacts.careerImportId} = ${importId})
        or ${careerFactConflicts.existingCandidateFactId} in (select ${candidateFacts.id} from ${candidateFacts} where ${candidateFacts.careerImportId} = ${importId})
      )`)) : [];

      return {
        ...baseImport({
          ...record,
          privacyStatus: persistedPrivacyStatus(record),
        }),
        facts: facts.map((fact) => {
          if ((record.sourceFormat === "docx") !== (fact.locatorType === "docx_paragraphs")
            || (record.sourceFormat === "pdf") !== (fact.locatorType === "pdf_pages")) throw new Error("职业资料证据定位格式不一致");
          return {
          factId: fact.factId,
          factType: fact.factType as CareerImportDetail["facts"][number]["factType"],
          factValue: fact.factValue as CareerImportDetail["facts"][number]["factValue"],
          confidenceBasisPoints: fact.confidenceBasisPoints,
          confirmationStatus: "pending",
          createdAt: toIso(fact.createdAt),
          evidence: fact.locatorType === "pdf_pages" ? {
            documentId: record.documentId, sourceFilename: record.sourceFilename,
            locatorType: "pdf_pages" as const, startPage: fact.startLine, endPage: fact.endLine, excerpt: fact.excerpt,
          } : fact.locatorType === "docx_paragraphs" ? {
            documentId: record.documentId,
            sourceFilename: record.sourceFilename,
            locatorType: "docx_paragraphs" as const,
            startParagraph: fact.startLine,
            endParagraph: fact.endLine,
            excerpt: fact.excerpt,
          } : {
            documentId: record.documentId,
            sourceFilename: record.sourceFilename,
            locatorType: "markdown_lines" as const,
            startLine: fact.startLine,
            endLine: fact.endLine,
            excerpt: fact.excerpt,
          },
          };
        }),
        conflicts: await Promise.all(conflicts.map(async (conflict) => {
          const loadFact = async (factId: string) => {
            const [fact] = await deps.db.select({
              factId: candidateFacts.id, factType: candidateFacts.factType, factValue: candidateFacts.factValue,
              confidenceBasisPoints: candidateFacts.confidenceBasisPoints, createdAt: candidateFacts.createdAt,
              documentId: careerDocuments.id, sourceFilename: careerDocuments.originalFilename, sourceFormat: careerDocuments.sourceFormat,
              locatorType: candidateFactEvidence.locatorType, startLine: candidateFactEvidence.startLine, endLine: candidateFactEvidence.endLine, excerpt: candidateFactEvidence.excerpt,
            }).from(candidateFacts).innerJoin(candidateFactEvidence, eq(candidateFactEvidence.candidateFactId, candidateFacts.id))
              .innerJoin(careerDocuments, eq(careerDocuments.id, candidateFacts.careerDocumentId))
              .where(and(eq(candidateFacts.userId, userId), eq(candidateFacts.id, factId)));
            if (!fact) throw new Error("职业事实冲突引用不存在");
            if ((fact.sourceFormat === "docx") !== (fact.locatorType === "docx_paragraphs")
              || (fact.sourceFormat === "pdf") !== (fact.locatorType === "pdf_pages")) throw new Error("职业资料证据定位格式不一致");
            return {
              factId: fact.factId, factType: fact.factType as CareerImportDetail["facts"][number]["factType"], factValue: fact.factValue as CareerImportDetail["facts"][number]["factValue"],
              confidenceBasisPoints: fact.confidenceBasisPoints, confirmationStatus: "pending" as const, createdAt: toIso(fact.createdAt),
              evidence: fact.locatorType === "pdf_pages" ? { documentId: fact.documentId, sourceFilename: fact.sourceFilename, locatorType: "pdf_pages" as const, startPage: fact.startLine, endPage: fact.endLine, excerpt: fact.excerpt }
                : fact.locatorType === "docx_paragraphs" ? { documentId: fact.documentId, sourceFilename: fact.sourceFilename, locatorType: "docx_paragraphs" as const, startParagraph: fact.startLine, endParagraph: fact.endLine, excerpt: fact.excerpt }
                : { documentId: fact.documentId, sourceFilename: fact.sourceFilename, locatorType: "markdown_lines" as const, startLine: fact.startLine, endLine: fact.endLine, excerpt: fact.excerpt },
            };
          };
          const facts = { existingFact: await loadFact(conflict.existingFactId), incomingFact: await loadFact(conflict.incomingFactId) };
          if (conflict.status === "pending") {
            return { conflictId: conflict.conflictId, kind: conflict.kind as "date" | "role" | "organization" | "metric", status: "pending" as const,
              ...facts, resolution: null, profileVersion: null, resolvedAt: null };
          }
          if (conflict.status === "resolved" && conflict.resolution && conflict.profileVersion && conflict.resolvedAt) {
            return { conflictId: conflict.conflictId, kind: conflict.kind as "date" | "role" | "organization" | "metric", status: "resolved" as const,
              ...facts, resolution: conflict.resolution as "use_existing" | "use_incoming" | "keep_both", profileVersion: conflict.profileVersion, resolvedAt: toIso(conflict.resolvedAt) };
          }
          throw new Error("职业事实冲突状态无效");
        })),
      };
    },
  };
}

export function createCareerImportProcessor(deps: ProcessorDependencies): {
  process(input: CareerImportJob & { finalAttempt: boolean }): Promise<"completed" | "failed" | "noop">;
} {
  async function fail(
    record: ImportRecord,
    attemptToken: number,
    code: CareerImportFailureCode,
  ): Promise<"failed" | "noop"> {
    const now = deps.clock();
    const failed = await deps.db.transaction(async (transaction) => {
      const [updated] = await transaction.update(careerImports).set({
        status: "failed",
        failureCode: code,
        failedAt: now,
        updatedAt: now,
      }).where(and(
        eq(careerImports.id, record.id),
        eq(careerImports.userId, record.userId),
        eq(careerImports.status, "processing"),
        eq(careerImports.attemptCount, attemptToken),
      )).returning({ id: careerImports.id });
      if (!updated) return false;
      await deps.auditTrail.bind(transaction).append({
        userId: record.userId,
        actorUserId: record.userId,
        eventType: "career.document_import_failed",
        occurredAt: now,
        requestId: record.originatingRequestId,
        outcome: "failure",
        reasonCode: code,
        resourceType: "career_import",
        resourceId: record.id,
        metadata: { documentId: record.documentId, importId: record.id, attemptCount: record.attemptCount, failureCode: code },
      });
      return true;
    });
    return failed ? "failed" : "noop";
  }

  return {
    async process(input): Promise<"completed" | "failed" | "noop"> {
      const record = await findImport(deps.db, input);
      if (!record || record.status === "completed" || record.status === "failed") return "noop";
      const now = deps.clock();
      let attemptToken: number;

      if (record.status === "queued") {
        const [claimed] = await deps.db.update(careerImports).set({
          status: "processing",
          processingStartedAt: now,
          attemptCount: sql`${careerImports.attemptCount} + 1`,
          updatedAt: now,
        }).where(and(
          eq(careerImports.id, record.id),
          eq(careerImports.userId, record.userId),
          eq(careerImports.status, "queued"),
        )).returning({ attemptCount: careerImports.attemptCount });
        if (!claimed) return "noop";
        attemptToken = claimed.attemptCount;
      } else if (record.status === "processing") {
        const [retried] = await deps.db.update(careerImports).set({
          attemptCount: sql`${careerImports.attemptCount} + 1`,
          updatedAt: now,
        }).where(and(
          eq(careerImports.id, record.id),
          eq(careerImports.userId, record.userId),
          eq(careerImports.status, "processing"),
        ))
          .returning({ attemptCount: careerImports.attemptCount });
        if (!retried) {
          await findImport(deps.db, { userId: record.userId, importId: record.id });
          return "noop";
        }
        attemptToken = retried.attemptCount;
      } else {
        return "noop";
      }
      record.attemptCount = attemptToken;

      if (record.privacyScanVersion !== CAREER_PRIVACY_SCAN_VERSION) {
        return fail(record, attemptToken, "CAREER_DOCUMENT_PRIVACY_UNVERIFIED");
      }

      let rawBytes: Uint8Array;
      try {
        rawBytes = await deps.documentStore.get({ objectKey: record.objectKey });
      } catch (error) {
        if (isMissingDocument(error)) return fail(record, attemptToken, "CAREER_DOCUMENT_NOT_FOUND");
        if (input.finalAttempt) return fail(record, attemptToken, "CAREER_DOCUMENT_READ_FAILED");
        throw new RetryableImportFailure();
      }

      try {
        if (sha256(rawBytes) !== record.checksumSha256) {
          throw new StableImportFailure("CAREER_DOCUMENT_CHECKSUM_MISMATCH");
        }
        let markdown: string;
        try {
          markdown = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes).replace(/\r\n?/g, "\n");
        } catch {
          throw new StableImportFailure("CAREER_PARSER_OUTPUT_INVALID");
        }
        const rawOutput = await deps.parser.parse(markdown);
        if (exceedsCareerImportFactLimit(rawOutput)) {
          throw new StableImportFailure("CAREER_IMPORT_FACT_LIMIT_EXCEEDED");
        }
        const outputResult = CareerParserOutputSchema.safeParse(rawOutput);
        if (!outputResult.success) throw new StableImportFailure("CAREER_PARSER_OUTPUT_INVALID");
        const output = outputResult.data;
        const markdownFacts = output.facts.filter((fact) => fact.evidence.locatorType === "markdown_lines") as Array<CareerParserFact & {
          evidence: { locatorType: "markdown_lines"; startLine: number; endLine: number; excerpt: string };
        }>;
        if (markdownFacts.length !== output.facts.length) {
          throw new StableImportFailure("CAREER_PARSER_EVIDENCE_INVALID");
        }
        const lines = markdown.split("\n");
        const acceptedFacts = markdownFacts.filter((fact) => {
          if (fact.evidence.startLine < 1 || fact.evidence.startLine > fact.evidence.endLine
            || fact.evidence.endLine > lines.length) return false;
          const quoted = lines.slice(fact.evidence.startLine - 1, fact.evidence.endLine).join("\n");
          const parsedFactValue = parseQuotedCareerFactValue(fact.factType, quoted);
          return quoted === fact.evidence.excerpt
            && parsedFactValue !== null
            && normalizeJson(parsedFactValue) === normalizeJson(fact.factValue);
        });
        if (acceptedFacts.length === 0) {
          throw new StableImportFailure("NO_SUPPORTED_FACTS");
        }

        await deps.db.transaction(async (transaction) => {
          const [ownedAttempt] = await transaction.update(careerImports).set({ updatedAt: now }).where(and(
            eq(careerImports.id, record.id),
            eq(careerImports.userId, record.userId),
            eq(careerImports.status, "processing"),
            eq(careerImports.attemptCount, attemptToken),
          )).returning({ id: careerImports.id });
          if (!ownedAttempt) throw new StaleImportAttempt();
          await acquireAccountAdvisoryLock(transaction, record.userId);
          for (const fact of acceptedFacts) {
            const pdfPages = record.sourceFormat === "pdf"
              ? mapPdfTextLineRangeToPages(markdown, fact.evidence.startLine, fact.evidence.endLine)
              : null;
            if (record.sourceFormat === "pdf" && !pdfPages) throw new StableImportFailure("CAREER_PARSER_EVIDENCE_INVALID");
            const candidateFactId = deps.id();
            await transaction.insert(candidateFacts).values({
              id: candidateFactId,
              userId: record.userId,
              careerImportId: record.id,
              careerDocumentId: record.documentId,
              factKey: factKey({
                parserVersion: output.parserVersion,
                factType: fact.factType,
                factValue: fact.factValue,
                startLine: fact.evidence.startLine,
                endLine: fact.evidence.endLine,
              }),
              factType: fact.factType,
              factValue: fact.factValue,
              confidenceBasisPoints: fact.confidenceBasisPoints,
              confirmationStatus: "pending",
              createdAt: now,
            });
            await transaction.insert(candidateFactEvidence).values({
              id: deps.id(),
              userId: record.userId,
              candidateFactId,
              careerDocumentId: record.documentId,
              locatorType: record.sourceFormat === "pdf" ? "pdf_pages" : record.sourceFormat === "docx" ? "docx_paragraphs" : fact.evidence.locatorType,
              startLine: pdfPages?.startPage ?? fact.evidence.startLine,
              endLine: pdfPages?.endPage ?? fact.evidence.endLine,
              excerpt: fact.evidence.excerpt,
              excerptSha256: sha256(fact.evidence.excerpt),
              createdAt: now,
            });
            const existingFacts = await transaction.select({ id: candidateFacts.id, factType: candidateFacts.factType, factValue: candidateFacts.factValue })
              .from(candidateFacts).where(and(
                eq(candidateFacts.userId, record.userId), ne(candidateFacts.careerImportId, record.id), eq(candidateFacts.factType, fact.factType),
                sql`not exists (
                  select 1 from ${candidateFactDecisions}
                  where ${candidateFactDecisions.userId} = ${candidateFacts.userId}
                    and ${candidateFactDecisions.candidateFactId} = ${candidateFacts.id}
                    and ${candidateFactDecisions.decision} in ('rejected', 'corrected')
                )`,
              ));
            for (const existing of existingFacts) {
              const conflict = detectCareerFactConflict(
                { factType: existing.factType, factValue: existing.factValue as { summary?: string; name?: string } },
                { factType: fact.factType, factValue: fact.factValue },
              );
              if (conflict) await transaction.insert(careerFactConflicts).values({
                id: deps.id(), userId: record.userId, existingCandidateFactId: existing.id, incomingCandidateFactId: candidateFactId,
                kind: conflict.kind, status: "pending", createdAt: now,
              }).onConflictDoNothing();
            }
          }
          const [completed] = await transaction.update(careerImports).set({
            status: "completed",
            failureCode: null,
            completedAt: now,
            updatedAt: now,
          }).where(and(
            eq(careerImports.id, record.id),
            eq(careerImports.userId, record.userId),
            eq(careerImports.status, "processing"),
            eq(careerImports.attemptCount, attemptToken),
          )).returning({ id: careerImports.id });
          if (!completed) throw new StaleImportAttempt();
          await deps.auditTrail.bind(transaction).append({
            userId: record.userId,
            actorUserId: record.userId,
            eventType: "career.document_import_completed",
            occurredAt: now,
            requestId: record.originatingRequestId,
            outcome: "success",
            reasonCode: "CAREER_DOCUMENT_IMPORT_COMPLETED",
            resourceType: "career_import",
            resourceId: record.id,
            metadata: { documentId: record.documentId, importId: record.id, attemptCount: record.attemptCount, factCount: acceptedFacts.length },
          });
        });
        return "completed";
      } catch (error) {
        if (error instanceof StaleImportAttempt) return "noop";
        if (error instanceof StableImportFailure) return fail(record, attemptToken, error.code);
        if (input.finalAttempt) return fail(record, attemptToken, "CAREER_IMPORT_PERSIST_FAILED");
        throw new RetryableImportFailure();
      }
    },
  };
}
