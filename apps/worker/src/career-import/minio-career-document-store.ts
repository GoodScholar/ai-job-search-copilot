import { Readable } from "node:stream";
import { Client as MinioClient } from "minio";
import { CAREER_DOCUMENT_MAX_BYTES } from "@job-copilot/contracts/career-import";
import type { CareerDocumentStore } from "@job-copilot/domain/career-imports";

export class MinioCareerDocumentStore implements CareerDocumentStore {
  constructor(private readonly client: MinioClient, private readonly bucket = process.env.MINIO_BUCKET ?? "career-documents") {}

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown" | "text/plain" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; documentId: string }): Promise<void> {
    await this.client.putObject(this.bucket, input.objectKey, Readable.from([input.bytes]), input.bytes.byteLength, {
      "content-type": input.mediaType,
      "x-amz-meta-document-id": input.documentId,
      "x-amz-meta-byte-size": String(input.bytes.byteLength),
    });
  }

  async get({ objectKey }: { objectKey: string }): Promise<Uint8Array> {
    let stream;
    try {
      stream = await this.client.getObject(this.bucket, objectKey);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "NoSuchKey") {
        throw Object.assign(new Error("career document not found"), { code: "CAREER_DOCUMENT_NOT_FOUND" });
      }
      throw error;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = new Uint8Array(chunk);
      size += bytes.byteLength;
      if (size > CAREER_DOCUMENT_MAX_BYTES) throw new Error("career document exceeds configured size");
      chunks.push(bytes);
    }
    const value = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      value.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return value;
  }
}
