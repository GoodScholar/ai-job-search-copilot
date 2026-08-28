import type { CareerDocumentStore, CareerImportQueue, CreateOrReuseResult } from "@job-copilot/domain/career-imports";
import type { CareerImportDetail, CareerImportSummary } from "@job-copilot/contracts/career-import";

export const CAREER_DOCUMENT_STORE = Symbol("CAREER_DOCUMENT_STORE");
export const CAREER_IMPORT_QUEUE = Symbol("CAREER_IMPORT_QUEUE");
export const CAREER_IMPORT_COMMANDS = Symbol("CAREER_IMPORT_COMMANDS");
export const CAREER_IMPORT_QUERIES = Symbol("CAREER_IMPORT_QUERIES");

export type CareerImportCommands = {
  createOrReuse(input: {
    userId: string;
    requestId: string;
    bytes: Uint8Array;
    originalFilename: string;
    mediaType: "text/markdown" | "text/plain";
    sourceFormat: "markdown" | "docx" | "pdf";
  }): Promise<CreateOrReuseResult>;
};

export type CareerImportQueries = {
  list(input: { userId: string }): Promise<CareerImportSummary[]>;
  get(input: { userId: string; importId: string }): Promise<CareerImportDetail | null>;
};

export type { CareerDocumentStore, CareerImportQueue };
