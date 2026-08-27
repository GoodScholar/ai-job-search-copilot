import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { MultipartFile } from "@fastify/multipart";
import { parseCareerDocumentUpload } from "./parse-career-document-upload.js";

function markdownPart(input: {
  filename?: string;
  fieldname?: string;
  mimetype?: string;
  bytes?: Uint8Array;
} = {}): MultipartFile {
  const bytes = input.bytes ?? new TextEncoder().encode("## 技能\n- TypeScript");
  return {
    type: "file",
    fieldname: input.fieldname ?? "file",
    filename: input.filename ?? "resume.md",
    mimetype: input.mimetype ?? "text/markdown",
    encoding: "7bit",
    file: Readable.from([bytes]),
    fields: {},
  } as MultipartFile;
}

async function* parts(...items: MultipartFile[]): AsyncIterable<MultipartFile> {
  yield* items;
}

describe("parseCareerDocumentUpload", () => {
  it.each(["text/markdown", "text/plain", "", "application/octet-stream"])("接受允许的 MIME %s", async (mimetype) => {
    await expect(parseCareerDocumentUpload(parts(markdownPart({ mimetype })))).resolves.toMatchObject({
      originalFilename: "resume.md",
      mediaType: "text/markdown",
      bytes: expect.any(Uint8Array),
    });
  });

  it("接受大写扩展名", async () => {
    await expect(parseCareerDocumentUpload(parts(markdownPart({ filename: "resume.MD" })))).resolves.toMatchObject({
      originalFilename: "resume.MD",
    });
  });

  it.each([
    ["缺少文件", parts(), "CAREER_DOCUMENT_REQUIRED"],
    ["多个文件", parts(markdownPart(), markdownPart()), "TOO_MANY_CAREER_DOCUMENTS"],
    ["错误字段", parts(markdownPart({ fieldname: "document" })), "CAREER_DOCUMENT_REQUIRED"],
    ["非 Markdown 扩展名", parts(markdownPart({ filename: "resume.txt" })), "UNSUPPORTED_CAREER_DOCUMENT_TYPE"],
    ["错误 MIME", parts(markdownPart({ mimetype: "application/pdf" })), "UNSUPPORTED_CAREER_DOCUMENT_TYPE"],
    ["超出字节上限", parts(markdownPart({ bytes: new Uint8Array(524_289) })), "CAREER_DOCUMENT_TOO_LARGE"],
    ["非法 UTF-8", parts(markdownPart({ bytes: new Uint8Array([0xc3, 0x28]) })), "CAREER_DOCUMENT_INVALID_UTF8"],
    ["NUL 字节", parts(markdownPart({ bytes: new Uint8Array([0x61, 0x00]) })), "CAREER_DOCUMENT_EMPTY"],
    ["空白正文", parts(markdownPart({ bytes: new TextEncoder().encode(" \n\t") })), "CAREER_DOCUMENT_EMPTY"],
  ])("拒绝%s", async (_label, uploadParts, code) => {
    await expect(parseCareerDocumentUpload(uploadParts)).rejects.toMatchObject({ code });
  });
});
