import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  candidateFactEvidence,
  candidateFacts,
  careerDocuments,
  careerImports,
  type Database,
} from "@job-copilot/database";
import {
  CareerImportJobSchema,
  CareerParserOutputSchema,
  type CareerImportDetail,
  type CareerImportFailureCode,
  type CareerImportJob,
  type CareerImportStatus,
  type CareerImportSummary,
} from "@job-copilot/contracts/career-import";
import type { AuditTrail } from "./audit-trail";

const parserAdapter = "fake";
const parserVersion = "fake-career-parser-v1";
const promptVersion = "career-import-prompt-v1";
const outputSchemaVersion = "career-facts-v1";

export interface CareerDocumentStore {
  put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown"; documentId: string }): Promise<void>;
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
  mediaType: "text/markdown";
};

export type CreateOrReuseResult = CareerImportSummary & {
  reused: boolean;
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
  checksumSha256: string;
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

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function objectKey(userId: string, documentId: string): string {
  return `accounts/${userId}/career-documents/${documentId}/source.md`;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function summary(record: {
  importId: string;
  documentId: string;
  sourceFilename: string;
  status: string;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CareerImportSummary {
  return {
    importId: record.importId,
    documentId: record.documentId,
    sourceFilename: record.sourceFilename,
    status: record.status as CareerImportStatus,
    failureCode: record.failureCode as CareerImportFailureCode | null,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
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

async function findImport(db: Database, input: { userId: string; importId: string }): Promise<ImportRecord | undefined> {
  const [record] = await db.select({
    id: careerImports.id,
    userId: careerImports.userId,
    documentId: careerDocuments.id,
    objectKey: careerDocuments.objectKey,
    originalFilename: careerDocuments.originalFilename,
    checksumSha256: careerDocuments.checksumSha256,
    status: careerImports.status,
    attemptCount: careerImports.attemptCount,
    originatingRequestId: careerImports.originatingRequestId,
  }).from(careerImports)
    .innerJoin(careerDocuments, eq(careerDocuments.id, careerImports.careerDocumentId))
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
      }).from(careerDocuments).where(and(
        eq(careerDocuments.userId, input.userId),
        eq(careerDocuments.checksumSha256, checksumSha256),
      ));
      let reused = Boolean(document);

      if (!document) {
        const documentId = deps.id();
        const key = objectKey(input.userId, documentId);
        document = await deps.db.transaction(async (transaction) => {
          const [created] = await transaction.insert(careerDocuments).values({
            id: documentId,
            userId: input.userId,
            checksumSha256,
            objectKey: key,
            originalFilename: input.originalFilename,
            mediaType: input.mediaType,
            byteSize: input.bytes.byteLength,
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing().returning({
            id: careerDocuments.id,
            objectKey: careerDocuments.objectKey,
            originalFilename: careerDocuments.originalFilename,
          });
          if (created) {
            await deps.documentStore.put({ objectKey: key, bytes: input.bytes, mediaType: input.mediaType, documentId });
            return created;
          }
          const [existing] = await transaction.select({
            id: careerDocuments.id,
            objectKey: careerDocuments.objectKey,
            originalFilename: careerDocuments.originalFilename,
          }).from(careerDocuments).where(and(
            eq(careerDocuments.userId, input.userId),
            eq(careerDocuments.checksumSha256, checksumSha256),
          ));
          if (!existing) throw new Error("无法读取职业资料");
          reused = true;
          return existing;
        });
      }

      if (!document) throw new Error("无法创建职业资料");

      let [storedImport] = await deps.db.select({
        id: careerImports.id,
        status: careerImports.status,
        failureCode: careerImports.failureCode,
        createdAt: careerImports.createdAt,
        updatedAt: careerImports.updatedAt,
      }).from(careerImports).where(and(
        eq(careerImports.userId, input.userId),
        eq(careerImports.careerDocumentId, document.id),
        eq(careerImports.parserVersion, parserVersion),
        eq(careerImports.promptVersion, promptVersion),
        eq(careerImports.outputSchemaVersion, outputSchemaVersion),
      ));
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
                metadata: { documentId: document.id, importId: storedImport.id, attemptCount: 0, failureCode: "CAREER_IMPORT_QUEUE_UNAVAILABLE" },
              });
            }
          });
          throw new CareerImportError("CAREER_IMPORT_QUEUE_UNAVAILABLE");
        }
      }

      return {
        ...summary({
          importId: storedImport.id,
          documentId: document.id,
          sourceFilename: document.originalFilename,
          status: storedImport.status,
          failureCode: storedImport.failureCode,
          createdAt: storedImport.createdAt,
          updatedAt: storedImport.updatedAt,
        }),
        reused,
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
        status: careerImports.status,
        failureCode: careerImports.failureCode,
        createdAt: careerImports.createdAt,
        updatedAt: careerImports.updatedAt,
      }).from(careerImports).innerJoin(careerDocuments, eq(careerDocuments.id, careerImports.careerDocumentId))
        .where(eq(careerImports.userId, userId)).orderBy(desc(careerImports.createdAt)).limit(20);
      return records.map(summary);
    },

    async get({ userId, importId }): Promise<CareerImportDetail | null> {
      const [record] = await deps.db.select({
        importId: careerImports.id,
        documentId: careerDocuments.id,
        sourceFilename: careerDocuments.originalFilename,
        status: careerImports.status,
        failureCode: careerImports.failureCode,
        createdAt: careerImports.createdAt,
        updatedAt: careerImports.updatedAt,
      }).from(careerImports).innerJoin(careerDocuments, eq(careerDocuments.id, careerImports.careerDocumentId))
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
        }).from(candidateFacts).innerJoin(candidateFactEvidence, eq(candidateFactEvidence.candidateFactId, candidateFacts.id))
          .where(and(eq(candidateFacts.userId, userId), eq(candidateFacts.careerImportId, importId)))
          .orderBy(asc(candidateFacts.createdAt))
        : [];

      return {
        ...summary(record),
        facts: facts.map((fact) => ({
          factId: fact.factId,
          factType: fact.factType as CareerImportDetail["facts"][number]["factType"],
          factValue: fact.factValue as CareerImportDetail["facts"][number]["factValue"],
          confidenceBasisPoints: fact.confidenceBasisPoints,
          confirmationStatus: "pending",
          createdAt: toIso(fact.createdAt),
          evidence: {
            documentId: record.documentId,
            sourceFilename: record.sourceFilename,
            locatorType: fact.locatorType as "markdown_lines",
            startLine: fact.startLine,
            endLine: fact.endLine,
            excerpt: fact.excerpt,
          },
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

      let rawBytes: Uint8Array;
      try {
        rawBytes = await deps.documentStore.get({ objectKey: record.objectKey });
      } catch (error) {
        if (isMissingDocument(error)) return fail(record, attemptToken, "CAREER_DOCUMENT_NOT_FOUND");
        if (input.finalAttempt) return fail(record, attemptToken, "CAREER_DOCUMENT_READ_FAILED");
        throw error;
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
        const outputResult = CareerParserOutputSchema.safeParse(await deps.parser.parse(markdown));
        if (!outputResult.success) throw new StableImportFailure("CAREER_PARSER_OUTPUT_INVALID");
        const output = outputResult.data;
        const lines = markdown.split("\n");
        const acceptedFacts = output.facts.filter((fact) => {
          if (fact.evidence.startLine < 1 || fact.evidence.startLine > fact.evidence.endLine
            || fact.evidence.endLine > lines.length) return false;
          const quoted = lines.slice(fact.evidence.startLine - 1, fact.evidence.endLine).join("\n");
          return quoted === fact.evidence.excerpt;
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
          for (const fact of acceptedFacts) {
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
              locatorType: fact.evidence.locatorType,
              startLine: fact.evidence.startLine,
              endLine: fact.evidence.endLine,
              excerpt: fact.evidence.excerpt,
              excerptSha256: sha256(fact.evidence.excerpt),
              createdAt: now,
            });
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
        throw error;
      }
    },
  };
}
