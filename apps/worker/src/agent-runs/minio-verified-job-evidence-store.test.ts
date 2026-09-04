import { describe, expect, it, vi } from "vitest";
import { VerifiedJobEvidenceStoreUnavailableError } from "@job-copilot/domain/verified-job-source-gate";

import { MinioVerifiedJobEvidenceStore } from "./minio-verified-job-evidence-store.js";

describe("MinioVerifiedJobEvidenceStore", () => {
  it("以固定 content-type 创建证据对象，重放同一 key 时不覆盖且报告未创建", async () => {
    const client = {
      statObject: vi.fn().mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "NoSuchKey" })).mockResolvedValueOnce({}),
      putObject: vi.fn().mockResolvedValue(undefined),
      removeObject: vi.fn().mockResolvedValue(undefined),
    };
    const store = new MinioVerifiedJobEvidenceStore(client as never, "evidence");

    await expect(store.put({ objectKey: "accounts/a/page.html", bytes: new TextEncoder().encode("<h1>role</h1>"), mediaType: "text/html" })).resolves.toEqual({ created: true });
    await expect(store.put({ objectKey: "accounts/a/page.html", bytes: new TextEncoder().encode("ignored"), mediaType: "text/html" })).resolves.toEqual({ created: false });
    expect(client.putObject).toHaveBeenCalledTimes(1);
    expect(client.putObject.mock.calls[0]?.slice(0, 4)).toEqual(["evidence", "accounts/a/page.html", expect.anything(), 13]);
    expect(client.putObject.mock.calls[0]?.[4]).toMatchObject({ "content-type": "text/html" });
  });

  it("把对象存取故障映射为不泄漏底层信息的 storage unavailable 错误", async () => {
    const client = { statObject: vi.fn().mockRejectedValue(new Error("network credentials")), putObject: vi.fn(), removeObject: vi.fn().mockRejectedValue(new Error("secret")) };
    const store = new MinioVerifiedJobEvidenceStore(client as never, "evidence");

    await expect(store.put({ objectKey: "accounts/a/page.txt", bytes: new Uint8Array([1]), mediaType: "text/plain" })).rejects.toBeInstanceOf(VerifiedJobEvidenceStoreUnavailableError);
    await expect(store.delete({ objectKey: "accounts/a/page.txt" })).rejects.toBeInstanceOf(VerifiedJobEvidenceStoreUnavailableError);
  });
});
