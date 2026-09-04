import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { createFakeAnysearchFixturePageTransport } from "./fake-anysearch-fixture-transport.js";

describe("Fake AnySearch fixture page transport", () => {
  it("收到 headers 后 response aborted 必须拒绝，绝不遗留 pending 请求", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.flushHeaders();
      response.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("FIXTURE_SERVER_ADDRESS_REQUIRED");
    const transport = createFakeAnysearchFixturePageTransport(`http://127.0.0.1:${address.port}`);
    const settled = await Promise.race([
      transport({ url: new URL("https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9001"), target: { address: "93.184.216.34", family: 4 }, accept: "text/html", timeoutMs: 1_000 }).then(() => "fulfilled", () => "rejected"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(settled).toBe("rejected");
  });
});
