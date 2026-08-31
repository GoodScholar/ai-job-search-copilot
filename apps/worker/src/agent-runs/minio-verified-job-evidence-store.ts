import { Readable } from "node:stream";
import { Client as MinioClient } from "minio";
import { VerifiedJobEvidenceStoreUnavailableError, type VerifiedJobEvidenceStore } from "@job-copilot/domain/verified-job-source-gate";

function missingObject(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "NoSuchKey" || code === "NoSuchObject" || code === "NotFound";
}

/** 仅保存已由本地抓取与 Gate 验证的页面证据；失败不得泄漏 MinIO 细节。 */
export class MinioVerifiedJobEvidenceStore implements VerifiedJobEvidenceStore {
  constructor(private readonly client: MinioClient, private readonly bucket = process.env.MINIO_BUCKET ?? "career-documents") {}

  async put(input: { objectKey: string; bytes: Uint8Array; mediaType: "text/html" | "text/plain" }): Promise<{ created: boolean }> {
    try {
      try {
        await this.client.statObject(this.bucket, input.objectKey);
        return { created: false };
      } catch (error) {
        if (!missingObject(error)) throw error;
      }
      await this.client.putObject(
        this.bucket,
        input.objectKey,
        Readable.from([input.bytes]),
        input.bytes.byteLength,
        { "content-type": input.mediaType },
      );
      return { created: true };
    } catch {
      throw new VerifiedJobEvidenceStoreUnavailableError();
    }
  }

  async delete(input: { objectKey: string }): Promise<void> {
    try { await this.client.removeObject(this.bucket, input.objectKey); }
    catch { throw new VerifiedJobEvidenceStoreUnavailableError(); }
  }
}
