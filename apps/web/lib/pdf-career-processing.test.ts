import { describe, expect, it } from "vitest";
import { extractCanonicalPdfPageText } from "./pdf-career-processing";

function createPdf(pages: readonly (string | readonly string[])[]): Blob {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const pageObjectNumbers: number[] = [];
  for (const pageText of pages) {
    const pageNumber = objects.length + 1;
    const contentNumber = pageNumber + 1;
    pageObjectNumbers.push(pageNumber);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${contentNumber + 1} 0 R >> >> /Contents ${contentNumber} 0 R >>`);
    const lines = Array.isArray(pageText) ? pageText : [pageText];
    const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((text, index) => `${index ? "0 -16 Td " : ""}(${text.replace(/[\\()]/g, "\\$&")}) Tj`).join(" ")} ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  }
  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(output.length);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([output], { type: "application/pdf" });
}

describe("extractCanonicalPdfPageText", () => {
  it("从真实 PDF 逐页生成保留页边界的规范化文本", async () => {
    await expect(extractCanonicalPdfPageText(createPdf(["## Skills", "- TypeScript"])))
      .resolves.toBe("[PDF 第 1 页]\n## Skills\n[PDF 第 2 页]\n- TypeScript");
  });

  it("保留同页多个 PDF 文本片段形成的 Markdown 行", async () => {
    await expect(extractCanonicalPdfPageText(createPdf([["## Skills", "- TypeScript"]])))
      .resolves.toBe("[PDF 第 1 页]\n## Skills\n- TypeScript");
  });

  it("对没有文本层的 PDF 返回稳定失败", async () => {
    await expect(extractCanonicalPdfPageText(createPdf([]))).rejects.toMatchObject({ code: "NO_TEXT" });
  });

  it("对损坏的 PDF 返回稳定失败", async () => {
    await expect(extractCanonicalPdfPageText(new Blob(["not a PDF"], { type: "application/pdf" })))
      .rejects.toMatchObject({ code: "INVALID_PDF" });
  });

  it("在读取前拒绝超过上限的 PDF", async () => {
    await expect(extractCanonicalPdfPageText(new Blob([new Uint8Array(524_289)], { type: "application/pdf" })))
      .rejects.toMatchObject({ code: "TOO_LARGE" });
  });

  it("拒绝小于文件上限但页数过多的 PDF", async () => {
    const pdf = createPdf(Array.from({ length: 51 }, (_, index) => `第 ${index + 1} 页`));
    expect(pdf.size).toBeLessThan(524_288);

    await expect(extractCanonicalPdfPageText(pdf)).rejects.toMatchObject({ code: "TOO_COMPLEX" });
  });
});
