import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getJobImportRaw: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getJobImportRaw: mocks.getJobImportRaw } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());
const importId = "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
const context = (value: string) => ({ params: Promise.resolve({ importId: value }) });

it("仅以 text/plain 和 no-store 返回经过会话授权的原始证据", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getJobImportRaw.mockResolvedValue("<img src=x onerror=alert(1)>");
  const response = await GET(new Request(`http://localhost/api/job-imports/${importId}/raw`), context(importId));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("<img src=x onerror=alert(1)>");
  expect(mocks.getJobImportRaw).toHaveBeenCalledWith("a".repeat(43), importId);
});

it("阻止无效身份并将上游故障收敛为安全状态码", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(GET(new Request("http://localhost/api/job-imports/x/raw"), context("x"))).resolves.toMatchObject({ status: 401 });
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(GET(new Request("http://localhost/api/job-imports/x/raw"), context("x"))).resolves.toMatchObject({ status: 404 });
  mocks.getJobImportRaw.mockRejectedValue({ status: 503 });
  await expect(GET(new Request(`http://localhost/api/job-imports/${importId}/raw`), context(importId))).resolves.toMatchObject({ status: 502 });
});
