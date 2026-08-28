import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import {
  isPdfPageCountWithinBudget,
  isPdfPageTextWithinBudget,
  isPdfTextByteCountWithinBudget,
  isPdfTextItemCountWithinBudget,
  pdfTextUtf8Bytes,
  reconstructPdfPageLines,
  serializePdfPageText,
  type PdfTextItem,
} from "@job-copilot/contracts/pdf-career-processing";

export class PdfCareerProcessingError extends Error {
  constructor(public readonly code: "TOO_LARGE" | "INVALID_PDF" | "ENCRYPTED_PDF" | "NO_TEXT" | "TOO_COMPLEX") {
    super(code === "TOO_LARGE" ? "职业资料不能超过 512 KiB" : code);
  }
}

function isEncryptedPdf(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error
    && (error as { name?: unknown }).name === "PasswordException";
}

export async function extractCanonicalPdfPageText(file: Blob): Promise<string> {
  if (file.size > CAREER_DOCUMENT_MAX_BYTES) throw new PdfCareerProcessingError("TOO_LARGE");
  const pdfjs = await import("pdfjs-dist/legacy/webpack.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    let document;
    try {
      document = await loadingTask.promise;
    } catch (error) {
      throw new PdfCareerProcessingError(isEncryptedPdf(error) ? "ENCRYPTED_PDF" : "INVALID_PDF");
    }
    if (!isPdfPageCountWithinBudget(document.numPages)) throw new PdfCareerProcessingError("TOO_COMPLEX");
    const pages: string[] = [];
    let textItemCount = 0;
    let textByteCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      textItemCount += content.items.length;
      if (!isPdfTextItemCountWithinBudget(textItemCount)) throw new PdfCareerProcessingError("TOO_COMPLEX");
      const items = content.items.map((item: unknown) => typeof item === "object" && item !== null && "str" in item ? item as PdfTextItem : {});
      for (const item of items) {
        textByteCount += pdfTextUtf8Bytes(item.str ?? "");
        if (!isPdfTextByteCountWithinBudget(textByteCount)) throw new PdfCareerProcessingError("TOO_COMPLEX");
      }
      pages.push(reconstructPdfPageLines(items));
      if (!isPdfPageTextWithinBudget(pages)) throw new PdfCareerProcessingError("TOO_COMPLEX");
    }
    if (!pages.some((page) => page.trim().length > 0)) throw new PdfCareerProcessingError("NO_TEXT");
    return serializePdfPageText(pages);
  } catch (error) {
    if (error instanceof PdfCareerProcessingError) throw error;
    throw new PdfCareerProcessingError("INVALID_PDF");
  } finally {
    await loadingTask.destroy();
  }
}
