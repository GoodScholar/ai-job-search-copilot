import { basename } from "node:path";
import type { Multipart, MultipartFile } from "@fastify/multipart";
import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import {
  CAREER_PRIVACY_SCAN_VERSION,
  inspectCareerDocumentPrivacy,
  isCareerPrivacyMode,
  type CareerPrivacyMode,
} from "@job-copilot/contracts/career-document-privacy";

export class CareerDocumentUploadError extends Error {
  constructor(public readonly code:
    | "CAREER_DOCUMENT_REQUIRED"
    | "TOO_MANY_CAREER_DOCUMENTS"
    | "UNSUPPORTED_CAREER_DOCUMENT_TYPE"
    | "CAREER_DOCUMENT_TOO_LARGE"
    | "CAREER_DOCUMENT_INVALID_UTF8"
    | "CAREER_DOCUMENT_EMPTY"
    | "CAREER_PRIVACY_DECISION_REQUIRED"
    | "PROTECTED_CAREER_DOCUMENT_REQUIRED"
    | "CAREER_PROCESSING_COPY_NOT_SANITIZED"
    | "CAREER_PROCESSING_COPY_MISMATCH") {
    super(code);
  }
}

export type ParsedCareerDocumentUpload = {
  bytes: Uint8Array;
  originalFilename: string;
  mediaType: "text/markdown";
  privacyScanVersion: typeof CAREER_PRIVACY_SCAN_VERSION;
  protectedOriginal?: {
    bytes: Uint8Array;
    originalFilename: string;
  };
};

type ParsedMarkdownFile = {
  bytes: Uint8Array;
  originalFilename: string;
  text: string;
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

async function parseMarkdownFile(file: MultipartFile): Promise<ParsedMarkdownFile> {
  const bytes = await readLimitedFile(file);
  const originalFilename = normalizedFilename(file.filename);
  if (!supportedMimeType(file.mimetype)) {
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
  return { bytes, originalFilename, text };
}

export async function parseCareerDocumentUpload(parts: AsyncIterable<Multipart>): Promise<ParsedCareerDocumentUpload> {
  let processingFile: ParsedMarkdownFile | undefined;
  let protectedOriginalFile: ParsedMarkdownFile | undefined;
  let mode: CareerPrivacyMode | undefined;
  let failure: CareerDocumentUploadError | undefined;
  for await (const part of parts) {
    if (part.type !== "file") {
      if (part.fieldname === "privacyMode"
        && !part.valueTruncated
        && isCareerPrivacyMode(part.value)
        && !mode) {
        mode = part.value;
      } else {
        failure ??= new CareerDocumentUploadError("CAREER_PRIVACY_DECISION_REQUIRED");
      }
      continue;
    }
    if (part.fieldname !== "file" && part.fieldname !== "protectedOriginal") {
      await discardFile(part);
      failure ??= new CareerDocumentUploadError("CAREER_DOCUMENT_REQUIRED");
      continue;
    }
    if ((part.fieldname === "file" && processingFile)
      || (part.fieldname === "protectedOriginal" && protectedOriginalFile)) {
      await discardFile(part);
      failure ??= new CareerDocumentUploadError("TOO_MANY_CAREER_DOCUMENTS");
      continue;
    }
    try {
      const parsed = await parseMarkdownFile(part);
      if (part.fieldname === "file") processingFile = parsed;
      else protectedOriginalFile = parsed;
    } catch (error) {
      failure ??= error instanceof CareerDocumentUploadError
        ? error
        : new CareerDocumentUploadError("CAREER_DOCUMENT_REQUIRED");
    }
  }
  if (failure) throw failure;
  if (!mode) throw new CareerDocumentUploadError("CAREER_PRIVACY_DECISION_REQUIRED");
  if (!processingFile) throw new CareerDocumentUploadError("CAREER_DOCUMENT_REQUIRED");
  const processingInspection = inspectCareerDocumentPrivacy(processingFile.text);
  if (processingInspection.findings.length > 0) {
    throw new CareerDocumentUploadError("CAREER_PROCESSING_COPY_NOT_SANITIZED");
  }

  if (mode === "retain_protected_original") {
    if (!protectedOriginalFile) throw new CareerDocumentUploadError("PROTECTED_CAREER_DOCUMENT_REQUIRED");
    const originalInspection = inspectCareerDocumentPrivacy(protectedOriginalFile.text);
    if (originalInspection.sanitizedMarkdown !== processingFile.text) {
      throw new CareerDocumentUploadError("CAREER_PROCESSING_COPY_MISMATCH");
    }
  } else if (protectedOriginalFile) {
    throw new CareerDocumentUploadError("CAREER_PRIVACY_DECISION_REQUIRED");
  }

  return {
    bytes: processingFile.bytes,
    originalFilename: processingFile.originalFilename,
    mediaType: "text/markdown",
    privacyScanVersion: CAREER_PRIVACY_SCAN_VERSION,
    protectedOriginal: protectedOriginalFile
      ? { bytes: protectedOriginalFile.bytes, originalFilename: protectedOriginalFile.originalFilename }
      : undefined,
  };
}
