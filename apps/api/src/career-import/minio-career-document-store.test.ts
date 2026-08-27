import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Client as MinioClient } from "minio";
import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import { MinioCareerDocumentStore } from "./minio-career-document-store.js";

function client(input: { stream?: Readable; error?: unknown } = {}) {
  return {
    putObject: vi.fn().mockResolvedValue(undefined),
    getObject: vi.fn().mockImplementation(async () => {
      if (input.error) throw input.error;
      return input.stream!;
    }),
  } as unknown as MinioClient;
}

describe("MinioCareerDocumentStore", () => {
  it("stores only the internal document metadata alongside original bytes", async () => {
    const minio = client();
    const store = new MinioCareerDocumentStore(minio, "career-documents-test");
    const bytes = new TextEncoder().encode("## 技能\n- TypeScript");

    await store.put({ objectKey: "accounts/user/career-documents/document/source.md", bytes, mediaType: "text/markdown", documentId: "document" });

    expect(minio.putObject).toHaveBeenCalledWith(
      "career-documents-test",
      "accounts/user/career-documents/document/source.md",
      expect.any(Readable),
      bytes.byteLength,
      {
        "content-type": "text/markdown",
        "x-amz-meta-document-id": "document",
        "x-amz-meta-byte-size": String(bytes.byteLength),
      },
    );
  });

  it("returns exactly 512 KiB and rejects a larger stored object", async () => {
    const maximum = new Uint8Array(CAREER_DOCUMENT_MAX_BYTES);
    const store = new MinioCareerDocumentStore(client({ stream: Readable.from([maximum]) }));
    await expect(store.get({ objectKey: "safe" })).resolves.toEqual(maximum);

    const tooLarge = new MinioCareerDocumentStore(client({ stream: Readable.from([new Uint8Array(CAREER_DOCUMENT_MAX_BYTES + 1)]) }));
    await expect(tooLarge.get({ objectKey: "too-large" })).rejects.toThrow("career document exceeds configured size");
  });

  it("maps MinIO NoSuchKey to the domain's stable missing-document code", async () => {
    const store = new MinioCareerDocumentStore(client({ error: { code: "NoSuchKey" } }));
    await expect(store.get({ objectKey: "missing" })).rejects.toMatchObject({ code: "CAREER_DOCUMENT_NOT_FOUND" });
  });
});
