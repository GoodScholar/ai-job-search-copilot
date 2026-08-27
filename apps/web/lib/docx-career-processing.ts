import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import { DOCX_EMBEDDED_MEDIA_MARKER, isDocxArchiveWithinBudget } from "@job-copilot/contracts/career-document-privacy";

type ZipEntryWithBudgetMetadata = { dir: boolean; name: string; _data?: { compressedSize?: number; uncompressedSize?: number } };

function hasSafeDocxArchiveBudget(entries: readonly ZipEntryWithBudgetMetadata[], archiveByteLength: number): boolean {
  return isDocxArchiveWithinBudget(entries.map((entry) => ({
    dir: entry.dir,
    compressedSize: entry._data?.compressedSize ?? -1,
    uncompressedSize: entry._data?.uncompressedSize ?? -1,
  })), archiveByteLength);
}

export class DocxCareerProcessingError extends Error {
  constructor(public readonly code: "TOO_LARGE" | "INVALID_DOCX" | "EMPTY") {
    super(code === "TOO_LARGE" ? "职业资料不能超过 512 KiB" : code);
  }
}

export async function extractCanonicalDocxParagraphText(file: Blob): Promise<string> {
  if (file.size > CAREER_DOCUMENT_MAX_BYTES) {
    throw new DocxCareerProcessingError("TOO_LARGE");
  }
  const arrayBuffer = await file.arrayBuffer();
  let hasEmbeddedMedia: boolean;
  try {
    const JSZip = (await import("jszip")).default;
    const archive = await JSZip.loadAsync(arrayBuffer);
    const entries = Object.values(archive.files) as ZipEntryWithBudgetMetadata[];
    if (!hasSafeDocxArchiveBudget(entries, arrayBuffer.byteLength)) throw new Error("unsafe DOCX archive budget");
    hasEmbeddedMedia = entries.some((entry) => entry.name.startsWith("word/media/") && !entry.dir);
  } catch {
    throw new DocxCareerProcessingError("INVALID_DOCX");
  }
  let result: { value: string };
  try {
    const mammoth = await import("mammoth");
  // mammoth 的 browser build 读取 arrayBuffer；Vitest/Node 解析到的 build 读取 buffer。
  // 两者指向相同的字节，避免客户端与测试/服务端走出不同的 DOCX 内容。
    const input = { arrayBuffer, buffer: new Uint8Array(arrayBuffer) } as unknown as Parameters<typeof mammoth.extractRawText>[0];
    result = await mammoth.extractRawText(input);
  } catch {
    throw new DocxCareerProcessingError("INVALID_DOCX");
  }
  // mammoth 用空行分隔 Word 段落；处理副本一行对应一个有内容的段落，
  // 以便后续 parser 的 1-based 位置可直接作为 docx_paragraphs 证据定位。
  const paragraphs = result.value.replace(/\r\n?/g, "\n").split("\n")
    .map((paragraph) => paragraph.trimEnd()).filter((paragraph) => paragraph.trim().length > 0);
  if (hasEmbeddedMedia) paragraphs.push(DOCX_EMBEDDED_MEDIA_MARKER);
  const canonical = paragraphs.join("\n").trim();
  if (!canonical) throw new DocxCareerProcessingError("EMPTY");
  return canonical;
}
