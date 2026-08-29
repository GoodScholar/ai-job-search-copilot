import { Readable } from "node:stream";
import { Client as MinioClient } from "minio";
import type { DiscoveryContentStore } from "@job-copilot/domain/agent-runs";

export class MinioDiscoveryContentStore implements DiscoveryContentStore {
  constructor(private readonly client: MinioClient, private readonly bucket = process.env.MINIO_BUCKET ?? "career-documents") {}

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "application/json"; runId: string }): Promise<void> {
    if (input.mediaType !== "application/json") throw new Error("discovery content must use application/json");
    await this.client.putObject(
      this.bucket,
      input.objectKey,
      Readable.from([input.bytes]),
      input.bytes.byteLength,
      { "content-type": input.mediaType, "x-amz-meta-agent-run-id": input.runId },
    );
  }

  async delete({ objectKey }: { objectKey: string }): Promise<void> {
    await this.client.removeObject(this.bucket, objectKey);
  }
}
