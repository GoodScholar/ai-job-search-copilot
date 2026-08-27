import { basename } from "node:path";
import type { Multipart, MultipartFile } from "@fastify/multipart";
import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";

export class CareerDocumentUploadError extends Error {
  constructor(public readonly code:
    | "CAREER_DOCUMENT_REQUIRED"
    | "TOO_MANY_CAREER_DOCUMENTS"
    | "UNSUPPORTED_CAREER_DOCUMENT_TYPE"
    | "CAREER_DOCUMENT_TOO_LARGE"
    | "CAREER_DOCUMENT_INVALID_UTF8"
    | "CAREER_DOCUMENT_EMPTY") {
    super(code);
  }
}

export type ParsedCareerDocumentUpload = {
  bytes: Uint8Array;
  originalFilename: string;
  mediaType: "text/markdown";
};

function normalizedFilename(filename: string | undefined): string {
  const value = basename((filename ?? "").replace(/\\/g, "/")).normalize("NFC");
  if (!value || Array.from(value).length > 255 || !/\.md$/i.test(value)) {
    throw new CareerDocumentUploadError("UNSUPPORTED_CAREER_DOCUMENT_TYPE");
  }
  return value;
}

function supportedMimeType(mimetype: string): boolean {
  return ["text/markdown", "text/plain", "", "application/octet-stream"].includes(mimetype.toLowerCase());
}

async function readLimitedFile(file: MultipartFile): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of file.file) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > CAREER_DOCUMENT_MAX_BYTES) tooLarge = true;
    else chunks.push(bytes);
  }
  if (tooLarge || file.file.truncated) throw new CareerDocumentUploadError("CAREER_DOCUMENT_TOO_LARGE");
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function discardFile(file: MultipartFile): Promise<void> {
  for await (const _chunk of file.file) {
    // Drain invalid parts so Fastify can complete the multipart request safely.
  }
}

export async function parseCareerDocumentUpload(parts: AsyncIterable<Multipart>): Promise<ParsedCareerDocumentUpload> {
  let parsed: ParsedCareerDocumentUpload | undefined;
  let failure: CareerDocumentUploadError | undefined;
  for await (const part of parts) {
    if (part.type !== "file") {
      failure ??= new CareerDocumentUploadError("CAREER_DOCUMENT_REQUIRED");
      continue;
    }
    if (part.fieldname !== "file") {
      await discardFile(part);
      failure ??= new CareerDocumentUploadError("CAREER_DOCUMENT_REQUIRED");
      continue;
    }
    if (parsed) {
      await discardFile(part);
      failure ??= new CareerDocumentUploadError("TOO_MANY_CAREER_DOCUMENTS");
      continue;
    }
    try {
      const bytes = await readLimitedFile(part);
      const originalFilename = normalizedFilename(part.filename);
      if (!supportedMimeType(part.mimetype)) {
        throw new CareerDocumentUploadError("UNSUPPORTED_CAREER_DOCUMENT_TYPE");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new CareerDocumentUploadError("CAREER_DOCUMENT_INVALID_UTF8");
      }
      if (text.includes("\0") || text.trim().length === 0) {
        throw new CareerDocumentUploadError("CAREER_DOCUMENT_EMPTY");
      }
      parsed = { bytes, originalFilename, mediaType: "text/markdown" };
    } catch (error) {
      failure ??= error instanceof CareerDocumentUploadError
        ? error
        : new CareerDocumentUploadError("CAREER_DOCUMENT_REQUIRED");
    }
  }
  if (failure) throw failure;
  if (!parsed) throw new CareerDocumentUploadError("CAREER_DOCUMENT_REQUIRED");
  return parsed;
}
