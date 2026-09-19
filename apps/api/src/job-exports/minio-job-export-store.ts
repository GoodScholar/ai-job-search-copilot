import { Readable } from "node:stream";
import { Client as MinioClient } from "minio";
import type { JobExportStore } from "@job-copilot/domain/job-exports";

export class MinioJobExportStore implements JobExportStore {
  constructor(private readonly client: MinioClient, private readonly bucket = process.env.MINIO_BUCKET ?? "career-documents") {}

  async put(input: { objectKey: string; bytes: Uint8Array; exportId: string }): Promise<void> {
    await this.client.putObject(this.bucket, input.objectKey, Readable.from([input.bytes]), input.bytes.byteLength, { "content-type": "text/csv; charset=utf-8", "x-amz-meta-job-export-id": input.exportId });
  }

  async get(input: { objectKey: string }): Promise<Uint8Array> {
    const stream = await this.client.getObject(this.bucket, input.objectKey);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) { const bytes = new Uint8Array(chunk); size += bytes.byteLength; chunks.push(bytes); }
    const output = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }

  async delete(input: { objectKey: string }): Promise<void> { await this.client.removeObject(this.bucket, input.objectKey); }
}
