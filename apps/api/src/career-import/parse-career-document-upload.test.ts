import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Multipart, MultipartFile, MultipartValue } from "@fastify/multipart";
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

function privacyMode(value: "sanitized_only" | "retain_protected_original"): MultipartValue<string> {
  return {
    type: "field",
    fieldname: "privacyMode",
    value,
    mimetype: "text/plain",
    encoding: "7bit",
    fieldnameTruncated: false,
    valueTruncated: false,
    fields: {},
  };
}

async function* parts(...items: Multipart[]): AsyncIterable<Multipart> {
  yield* items;
}

function sanitizedParts(...items: MultipartFile[]): AsyncIterable<Multipart> {
  return parts(privacyMode("sanitized_only"), ...items);
}

describe("parseCareerDocumentUpload", () => {
  it.each(["text/markdown", "text/plain", "", "application/octet-stream"])("接受允许的 MIME %s", async (mimetype) => {
    await expect(parseCareerDocumentUpload(sanitizedParts(markdownPart({ mimetype })))).resolves.toMatchObject({
      originalFilename: "resume.md",
      mediaType: "text/markdown",
      privacyScanVersion: "career-privacy-v1",
      protectedOriginal: undefined,
      bytes: expect.any(Uint8Array),
    });
  });

  it("接受大写扩展名", async () => {
    await expect(parseCareerDocumentUpload(sanitizedParts(markdownPart({ filename: "resume.MD" })))).resolves.toMatchObject({
      originalFilename: "resume.MD",
    });
  });

  it("将显示文件名限制为规范化 basename 的 255 个 Unicode code point", async () => {
    const decomposed = `folder/ren\u0065\u0301sume.md`;
    const accepted = await parseCareerDocumentUpload(sanitizedParts(markdownPart({ filename: decomposed })));
    expect(accepted.originalFilename).toBe("renésume.md");
    await expect(parseCareerDocumentUpload(sanitizedParts(markdownPart({ filename: `${"中".repeat(252)}.md` })))).resolves.toMatchObject({
      originalFilename: `${"中".repeat(252)}.md`,
    });
    await expect(parseCareerDocumentUpload(sanitizedParts(markdownPart({ filename: `${"中".repeat(253)}.md` })))).rejects.toMatchObject({
      code: "UNSUPPORTED_CAREER_DOCUMENT_TYPE",
    });
  });

  it.each([
    ["缺少文件", sanitizedParts(), "CAREER_DOCUMENT_REQUIRED"],
    ["多个文件", sanitizedParts(markdownPart(), markdownPart()), "TOO_MANY_CAREER_DOCUMENTS"],
    ["错误字段", sanitizedParts(markdownPart({ fieldname: "document" })), "CAREER_DOCUMENT_REQUIRED"],
    ["非 Markdown 扩展名", sanitizedParts(markdownPart({ filename: "resume.txt" })), "UNSUPPORTED_CAREER_DOCUMENT_TYPE"],
    ["错误 MIME", sanitizedParts(markdownPart({ mimetype: "application/pdf" })), "UNSUPPORTED_CAREER_DOCUMENT_TYPE"],
    ["超出字节上限", sanitizedParts(markdownPart({ bytes: new Uint8Array(524_289) })), "CAREER_DOCUMENT_TOO_LARGE"],
    ["非法 UTF-8", sanitizedParts(markdownPart({ bytes: new Uint8Array([0xc3, 0x28]) })), "CAREER_DOCUMENT_INVALID_UTF8"],
    ["NUL 字节", sanitizedParts(markdownPart({ bytes: new Uint8Array([0x61, 0x00]) })), "CAREER_DOCUMENT_EMPTY"],
    ["空白正文", sanitizedParts(markdownPart({ bytes: new TextEncoder().encode(" \n\t") })), "CAREER_DOCUMENT_EMPTY"],
  ])("拒绝%s", async (_label, uploadParts, code) => {
    await expect(parseCareerDocumentUpload(uploadParts)).rejects.toMatchObject({ code });
  });

  it("rejects an unredacted processing copy even when sanitized-only mode is selected", async () => {
    await expect(parseCareerDocumentUpload(sanitizedParts(markdownPart({
      bytes: new TextEncoder().encode("邮箱：secret@example.com\n## 技能\n- TypeScript"),
    })))).rejects.toMatchObject({ code: "CAREER_PROCESSING_COPY_NOT_SANITIZED" });
  });

  it("accepts a protected original only when its deterministic sanitized copy matches", async () => {
    const original = markdownPart({
      fieldname: "protectedOriginal",
      bytes: new TextEncoder().encode("姓名：张三\n邮箱：secret@example.com\n## 技能\n- TypeScript"),
    });
    const processing = markdownPart({
      bytes: new TextEncoder().encode("姓名：[姓名]\n邮箱：[邮箱]\n## 技能\n- TypeScript"),
    });

    await expect(parseCareerDocumentUpload(parts(
      privacyMode("retain_protected_original"), processing, original,
    ))).resolves.toMatchObject({
      privacyScanVersion: "career-privacy-v1",
      bytes: expect.any(Uint8Array),
      protectedOriginal: { bytes: expect.any(Uint8Array), originalFilename: "resume.md" },
    });

    const mismatched = markdownPart({ bytes: new TextEncoder().encode("姓名：[姓名]\n邮箱：[邮箱]\n- Rust") });
    await expect(parseCareerDocumentUpload(parts(
      privacyMode("retain_protected_original"), mismatched, markdownPart({
        fieldname: "protectedOriginal",
        bytes: new TextEncoder().encode("姓名：张三\n邮箱：secret@example.com\n- TypeScript"),
      }),
    ))).rejects.toMatchObject({ code: "CAREER_PROCESSING_COPY_MISMATCH" });
  });

  it("requires an explicit privacy decision", async () => {
    await expect(parseCareerDocumentUpload(parts(markdownPart())))
      .rejects.toMatchObject({ code: "CAREER_PRIVACY_DECISION_REQUIRED" });
  });
});
