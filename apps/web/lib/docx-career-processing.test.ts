import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import { inspectCareerDocumentPrivacy } from "@job-copilot/contracts/career-document-privacy";
import { extractCanonicalDocxParagraphText } from "./docx-career-processing";

async function minimalDocx(paragraphs: string[]): Promise<Blob> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels")!.file(".rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  zip.folder("word")!.file("document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${escaped(text)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return new Blob([await zip.generateAsync({ type: "arraybuffer" })], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

async function docxWithEmbeddedMedia(paragraphs: string[]): Promise<Blob> {
  const source = await minimalDocx(paragraphs);
  const zip = await JSZip.loadAsync(await source.arrayBuffer());
  zip.folder("word/media")!.file("private-photo.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]));
  return new Blob([await zip.generateAsync({ type: "arraybuffer" })], { type: source.type });
}

async function docxBeyondArchiveBudget(kind: "oversized_entry" | "entry_fanout"): Promise<Blob> {
  const source = await minimalDocx(["## 技能", "- TypeScript"]);
  const zip = await JSZip.loadAsync(await source.arrayBuffer());
  if (kind === "oversized_entry") zip.file("word/bomb.xml", "x".repeat(1_048_577));
  else for (let index = 0; index < 65; index += 1) zip.file(`word/parts/${index}.xml`, "x");
  return new Blob([await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })], { type: source.type });
}

describe("extractCanonicalDocxParagraphText", () => {
  it("extracts deterministic paragraphs from a runtime-generated DOCX", async () => {
    await expect(extractCanonicalDocxParagraphText(await minimalDocx(["## 工作经历", "- AI 工程师｜示例科技｜2024"])))
      .resolves.toBe("## 工作经历\n- AI 工程师｜示例科技｜2024");
  });

  it("在调用 DOCX 解析器前拒绝超过职业资料上限的文件", async () => {
    await expect(extractCanonicalDocxParagraphText(new Blob(["x".repeat(CAREER_DOCUMENT_MAX_BYTES + 1)])))
      .rejects.toThrow("职业资料不能超过 512 KiB");
  });

  it("把嵌入媒体标记为隐私扫描可见的稳定段落，而不保留图片字节", async () => {
    const canonical = await extractCanonicalDocxParagraphText(await docxWithEmbeddedMedia(["## 技能", "- TypeScript"]));
    expect(canonical).toBe("## 技能\n- TypeScript\n[DOCX 嵌入照片或二维码]");
    expect(canonical).not.toContain("private-photo.png");
    expect(inspectCareerDocumentPrivacy(canonical)).toMatchObject({
      findings: [expect.objectContaining({ kind: "image_or_qr" })],
      sanitizedMarkdown: "## 技能\n- TypeScript\n[照片或二维码]",
    });
  });

  it("纯图片 DOCX 仍生成隐私确认标记", async () => {
    await expect(extractCanonicalDocxParagraphText(await docxWithEmbeddedMedia([]))).resolves.toBe("[DOCX 嵌入照片或二维码]");
  });

  it.each(["oversized_entry", "entry_fanout"] as const)("在调用 Mammoth 前拒绝超出解压预算的 %s DOCX", async (kind) => {
    const source = await docxBeyondArchiveBudget(kind);
    expect(source.size).toBeLessThan(CAREER_DOCUMENT_MAX_BYTES);
    await expect(extractCanonicalDocxParagraphText(source)).rejects.toMatchObject({ code: "INVALID_DOCX" });
  });
});
