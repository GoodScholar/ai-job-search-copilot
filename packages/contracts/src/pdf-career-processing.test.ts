import { describe, expect, it } from "vitest";
import {
  CAREER_DOCUMENT_PDF_MAX_PAGES,
  CAREER_DOCUMENT_PDF_MAX_TEXT_BYTES,
  isPdfPageCountWithinBudget,
  isPdfPageTextWithinBudget,
  isPdfTextByteCountWithinBudget,
  isPdfTextItemCountWithinBudget,
  mapPdfTextLineRangeToPages,
  reconstructPdfPageLines,
  serializePdfPageText,
} from "./pdf-career-processing";

describe("PDF 职业资料处理文本", () => {
  it("保留每一页边界，并将解析器行范围映射回原始页码", () => {
    const text = serializePdfPageText([
      "## 技能\r\n- TypeScript",
      "## 工作经历\n- AI 工程师｜示例科技｜2024",
    ]);

    expect(text).toBe("[PDF 第 1 页]\n## 技能\n- TypeScript\n[PDF 第 2 页]\n## 工作经历\n- AI 工程师｜示例科技｜2024");
    expect(mapPdfTextLineRangeToPages(text, 3, 6)).toEqual({ startPage: 1, endPage: 2 });
  });

  it("转义与页标记相同的 PDF 原文，避免伪造页码", () => {
    const text = serializePdfPageText(["[PDF 第 99 页]\n## 技能", "- TypeScript"]);

    expect(text).toContain("\\[PDF 第 99 页]");
    expect(mapPdfTextLineRangeToPages(text, 4, 4)).toEqual({ startPage: 2, endPage: 2 });
  });

  it("按 PDF 文本基线重建同页逻辑行", () => {
    expect(reconstructPdfPageLines([
      { str: "## Skills", transform: [1, 0, 0, 1, 72, 720], hasEOL: false },
      { str: "- TypeScript", transform: [1, 0, 0, 1, 72, 704], hasEOL: false },
    ])).toBe("## Skills\n- TypeScript");
  });

  it("为 PDF 提取设定页数、文本项和展开文本预算", () => {
    expect(isPdfPageCountWithinBudget(0)).toBe(true);
    expect(isPdfPageCountWithinBudget(CAREER_DOCUMENT_PDF_MAX_PAGES)).toBe(true);
    expect(isPdfPageCountWithinBudget(CAREER_DOCUMENT_PDF_MAX_PAGES + 1)).toBe(false);
    expect(isPdfTextItemCountWithinBudget(10_000)).toBe(true);
    expect(isPdfTextItemCountWithinBudget(10_001)).toBe(false);
    expect(isPdfTextByteCountWithinBudget(CAREER_DOCUMENT_PDF_MAX_TEXT_BYTES)).toBe(true);
    expect(isPdfTextByteCountWithinBudget(CAREER_DOCUMENT_PDF_MAX_TEXT_BYTES + 1)).toBe(false);
    expect(isPdfPageTextWithinBudget(["x".repeat(CAREER_DOCUMENT_PDF_MAX_TEXT_BYTES)])).toBe(true);
    expect(isPdfPageTextWithinBudget(["x".repeat(CAREER_DOCUMENT_PDF_MAX_TEXT_BYTES + 1)])).toBe(false);
  });
});
