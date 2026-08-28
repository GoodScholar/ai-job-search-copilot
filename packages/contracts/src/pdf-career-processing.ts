const pageMarker = /^\[PDF 第 (\d+) 页\]$/u;

export const CAREER_DOCUMENT_PDF_MAX_PAGES = 50;
export const CAREER_DOCUMENT_PDF_MAX_TEXT_ITEMS = 10_000;
export const CAREER_DOCUMENT_PDF_MAX_TEXT_BYTES = 262_144;

export type PdfTextItem = { str?: string; transform?: readonly number[]; hasEOL?: boolean };

export function isPdfPageCountWithinBudget(pageCount: number): boolean {
  return Number.isInteger(pageCount) && pageCount >= 0 && pageCount <= CAREER_DOCUMENT_PDF_MAX_PAGES;
}

export function isPdfTextItemCountWithinBudget(itemCount: number): boolean {
  return Number.isInteger(itemCount) && itemCount >= 0 && itemCount <= CAREER_DOCUMENT_PDF_MAX_TEXT_ITEMS;
}

export function pdfTextUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function isPdfTextByteCountWithinBudget(byteCount: number): boolean {
  return Number.isInteger(byteCount) && byteCount >= 0 && byteCount <= CAREER_DOCUMENT_PDF_MAX_TEXT_BYTES;
}

export function isPdfPageTextWithinBudget(pages: readonly string[]): boolean {
  let byteCount = 0;
  for (const [index, page] of pages.entries()) {
    if (typeof page !== "string") return false;
    byteCount += pdfTextUtf8Bytes(page) + (index === 0 ? 0 : 1);
    if (!isPdfTextByteCountWithinBudget(byteCount)) return false;
  }
  return true;
}

export function reconstructPdfPageLines(items: readonly PdfTextItem[]): string {
  const lines: string[] = [];
  let line = "";
  let baseline: number | undefined;
  const flush = () => {
    if (line) lines.push(line);
    line = "";
    baseline = undefined;
  };
  for (const item of items) {
    if (!item.str) continue;
    const nextBaseline = item.transform?.[5];
    if (line && baseline !== undefined && nextBaseline !== undefined && Math.abs(baseline - nextBaseline) > 0.5) flush();
    line += item.str;
    baseline ??= nextBaseline;
    if (item.hasEOL) flush();
  }
  flush();
  return lines.join("\n");
}

export function serializePdfPageText(pages: readonly string[]): string {
  return pages.map((page, index) => {
    const normalized = page.replace(/\r\n?/g, "\n").trim()
      .split("\n").map((line) => pageMarker.test(line) ? `\\${line}` : line).join("\n");
    return normalized ? `[PDF 第 ${index + 1} 页]\n${normalized}` : `[PDF 第 ${index + 1} 页]`;
  }).join("\n");
}

export function mapPdfTextLineRangeToPages(
  processingText: string,
  startLine: number,
  endLine: number,
): { startPage: number; endPage: number } | null {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) return null;
  const pagesByLine: number[] = [];
  let page = 0;
  for (const line of processingText.split("\n")) {
    const marker = line.match(pageMarker);
    if (marker) page = Number(marker[1]);
    pagesByLine.push(page);
  }
  const startPage = pagesByLine[startLine - 1];
  const endPage = pagesByLine[endLine - 1];
  return startPage && endPage ? { startPage, endPage } : null;
}
