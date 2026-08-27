import JSZip from "jszip";

/** 运行时生成的最小 OOXML fixture，避免在仓库中存放不透明二进制文件。 */
export async function createMinimalDocx(paragraphs: string[], options: { embeddedMedia?: boolean; unsafeArchive?: "oversized_entry" | "entry_fanout" } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels")!.file(".rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const word = zip.folder("word")!;
  word.file("document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((paragraph) => `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  if (options.embeddedMedia) word.folder("media")!.file("private-photo.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]));
  if (options.unsafeArchive === "oversized_entry") word.file("bomb.xml", "x".repeat(1_048_577));
  if (options.unsafeArchive === "entry_fanout") {
    for (let index = 0; index < 65; index += 1) word.file(`parts/${index}.xml`, "x");
  }
  return zip.generateAsync({ type: "uint8array", compression: options.unsafeArchive ? "DEFLATE" : "STORE" });
}
