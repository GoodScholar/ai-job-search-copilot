import { basename } from "node:path";
import type { Multipart, MultipartFile } from "@fastify/multipart";
import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import {
  CAREER_PRIVACY_SCAN_VERSION,
  DOCX_EMBEDDED_MEDIA_MARKER,
  isDocxArchiveWithinBudget,
  inspectCareerDocumentPrivacy,
  isCareerPrivacyMode,
  type CareerPrivacyMode,
} from "@job-copilot/contracts/career-document-privacy";
import {
  extractCanonicalPdfPageText,
  PdfCareerDocumentError,
  PdfCareerProcessorUnavailableError,
} from "./pdf-career-processing.js";

export class CareerDocumentUploadError extends Error {
  constructor(public readonly code:
    | "CAREER_DOCUMENT_REQUIRED"
    | "TOO_MANY_CAREER_DOCUMENTS"
    | "UNSUPPORTED_CAREER_DOCUMENT_TYPE"
    | "CAREER_DOCUMENT_TOO_LARGE"
    | "CAREER_DOCUMENT_INVALID_UTF8"
    | "CAREER_DOCUMENT_EMPTY"
    | "CAREER_DOCUMENT_INVALID_DOCX"
    | "CAREER_DOCUMENT_INVALID_PDF"
    | "CAREER_DOCUMENT_ENCRYPTED_PDF"
    | "CAREER_DOCUMENT_PDF_NO_TEXT"
    | "CAREER_DOCUMENT_PDF_TOO_COMPLEX"
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
  mediaType: "text/markdown" | "text/plain";
  sourceFormat: "markdown" | "docx" | "pdf";
  privacyScanVersion: typeof CAREER_PRIVACY_SCAN_VERSION;
  protectedOriginal?: {
    bytes: Uint8Array;
    originalFilename: string;
    mediaType: "text/markdown" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/pdf";
  };
};

type ParsedMarkdownFile = {
  bytes: Uint8Array;
  originalFilename: string;
  text: string;
};
type ParsedProtectedOriginal = { bytes: Uint8Array; originalFilename: string; mediaType: CareerDocumentMediaType; canonicalText: string };

type CareerDocumentMediaType = "text/markdown" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/pdf";
type PdfTextExtractor = (bytes: Uint8Array) => Promise<string>;

export type ParseCareerDocumentUploadOptions = {
  extractPdfPageText?: PdfTextExtractor;
};
type ZipEntryWithBudgetMetadata = { dir: boolean; name: string; _data?: { compressedSize?: number; uncompressedSize?: number } };

function hasSafeDocxArchiveBudget(entries: readonly ZipEntryWithBudgetMetadata[], archiveByteLength: number): boolean {
  return isDocxArchiveWithinBudget(entries.map((entry) => ({
    dir: entry.dir,
    compressedSize: entry._data?.compressedSize ?? -1,
    uncompressedSize: entry._data?.uncompressedSize ?? -1,
  })), archiveByteLength);
}

function normalizedFilename(filename: string | undefined): string {
  const value = basename((filename ?? "").replace(/\\/g, "/")).normalize("NFC");
  if (!value || Array.from(value).length > 255 || !/\.(?:md|docx|pdf)$/i.test(value)) {
    throw new CareerDocumentUploadError("UNSUPPORTED_CAREER_DOCUMENT_TYPE");
  }
  return value;
}

function mediaTypeFor(filename: string): CareerDocumentMediaType {
  return /\.pdf$/i.test(filename) ? "application/pdf" : /\.docx$/i.test(filename)
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "text/markdown";
}

function supportedMimeType(mimetype: string, mediaType: CareerDocumentMediaType): boolean {
  const normalized = mimetype.toLowerCase();
  return mediaType === "text/markdown"
    ? ["text/markdown", "text/plain", "", "application/octet-stream"].includes(normalized)
    : mediaType === "application/pdf"
      ? ["application/pdf", "", "application/octet-stream"].includes(normalized)
      : ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "", "application/octet-stream"].includes(normalized);
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
  const mediaType = mediaTypeFor(originalFilename);
  if (!supportedMimeType(file.mimetype, mediaType)) {
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

async function canonicalDocxText(bytes: Uint8Array): Promise<string> {
  try {
    const JSZip = (await import("jszip")).default;
    const archive = await JSZip.loadAsync(bytes);
    const entries = Object.values(archive.files) as ZipEntryWithBudgetMetadata[];
    if (!hasSafeDocxArchiveBudget(entries, bytes.byteLength)) throw new Error("unsafe DOCX archive budget");
    const hasEmbeddedMedia = entries.some((entry) => entry.name.startsWith("word/media/") && !entry.dir);
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const paragraphs = result.value.replace(/\r\n?/g, "\n").split("\n")
      .map((paragraph) => paragraph.trimEnd()).filter((paragraph) => paragraph.trim().length > 0);
    if (hasEmbeddedMedia) paragraphs.push(DOCX_EMBEDDED_MEDIA_MARKER);
    const canonical = paragraphs.join("\n").trim();
    if (!canonical) throw new Error("empty");
    return canonical;
  } catch {
    throw new CareerDocumentUploadError("CAREER_DOCUMENT_INVALID_DOCX");
  }
}

async function parseProtectedOriginal(file: MultipartFile, extractPdfPageText: PdfTextExtractor): Promise<ParsedProtectedOriginal> {
  const bytes = await readLimitedFile(file);
  const originalFilename = normalizedFilename(file.filename);
  const mediaType = mediaTypeFor(originalFilename);
  if (!supportedMimeType(file.mimetype, mediaType)) throw new CareerDocumentUploadError("UNSUPPORTED_CAREER_DOCUMENT_TYPE");
  let canonicalText: string;
  if (mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") canonicalText = await canonicalDocxText(bytes);
  else if (mediaType === "application/pdf") {
    try { canonicalText = await extractPdfPageText(bytes); } catch (error) {
      if (error instanceof PdfCareerProcessorUnavailableError) throw error;
      if (error instanceof PdfCareerDocumentError) throw new CareerDocumentUploadError(error.code);
      throw new CareerDocumentUploadError("CAREER_DOCUMENT_INVALID_PDF");
    }
  }
  else {
    try { canonicalText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new CareerDocumentUploadError("CAREER_DOCUMENT_INVALID_UTF8"); }
  }
  return { bytes, originalFilename, mediaType, canonicalText };
}

export async function parseCareerDocumentUpload(
  parts: AsyncIterable<Multipart>,
  options: ParseCareerDocumentUploadOptions = {},
): Promise<ParsedCareerDocumentUpload> {
  const extractPdfPageText = options.extractPdfPageText ?? extractCanonicalPdfPageText;
  let processingFile: ParsedMarkdownFile | undefined;
  let protectedOriginalFile: ParsedProtectedOriginal | undefined;
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
      if (part.fieldname === "file") processingFile = await parseMarkdownFile(part);
      else protectedOriginalFile = await parseProtectedOriginal(part, extractPdfPageText);
    } catch (error) {
      if (error instanceof PdfCareerProcessorUnavailableError) throw error;
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
    const processingSourceFormat = /\.pdf$/i.test(processingFile.originalFilename) ? "pdf" : /\.docx$/i.test(processingFile.originalFilename) ? "docx" : "markdown";
    const protectedSourceFormat = protectedOriginalFile.mediaType === "application/pdf" ? "pdf" : protectedOriginalFile.mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? "docx" : "markdown";
    if (processingSourceFormat !== protectedSourceFormat) {
      throw new CareerDocumentUploadError("CAREER_PROCESSING_COPY_MISMATCH");
    }
    const originalInspection = inspectCareerDocumentPrivacy(protectedOriginalFile.canonicalText);
    if (originalInspection.sanitizedMarkdown.trim() !== processingFile.text.trim()) {
      throw new CareerDocumentUploadError("CAREER_PROCESSING_COPY_MISMATCH");
    }
  } else if (protectedOriginalFile) {
    throw new CareerDocumentUploadError("CAREER_PRIVACY_DECISION_REQUIRED");
  }

  return {
    bytes: processingFile.bytes,
    originalFilename: processingFile.originalFilename,
    mediaType: /\.(?:docx|pdf)$/i.test(processingFile.originalFilename) ? "text/plain" : "text/markdown",
    sourceFormat: /\.pdf$/i.test(processingFile.originalFilename) ? "pdf" : /\.docx$/i.test(processingFile.originalFilename) ? "docx" : "markdown",
    privacyScanVersion: CAREER_PRIVACY_SCAN_VERSION,
    protectedOriginal: protectedOriginalFile
      ? { bytes: protectedOriginalFile.bytes, originalFilename: protectedOriginalFile.originalFilename, mediaType: protectedOriginalFile.mediaType }
      : undefined,
  };
}
