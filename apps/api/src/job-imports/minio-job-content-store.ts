import { Readable } from "node:stream";
import { Client as MinioClient } from "minio";
import { JOB_IMPORT_MAX_BYTES } from "@job-copilot/contracts/job-imports";
import type { JobContentStore } from "@job-copilot/domain/job-imports";

export class MinioJobContentStore implements JobContentStore {
  constructor(private readonly client: MinioClient, private readonly bucket = process.env.MINIO_BUCKET ?? "career-documents") {}

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/markdown" | "text/html" | "text/plain"; importId: string }): Promise<void> {
    await this.client.putObject(this.bucket, input.objectKey, Readable.from([input.bytes]), input.bytes.byteLength, {
      "content-type": input.mediaType,
      "x-amz-meta-job-import-id": input.importId,
      "x-amz-meta-byte-size": String(input.bytes.byteLength),
    });
  }

  async get({ objectKey }: { objectKey: string }): Promise<Uint8Array> {
    const stream = await this.client.getObject(this.bucket, objectKey);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = new Uint8Array(chunk);
      size += bytes.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("job import content exceeds configured size");
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

  async delete({ objectKey }: { objectKey: string }): Promise<void> {
    await this.client.removeObject(this.bucket, objectKey);
  }
}
