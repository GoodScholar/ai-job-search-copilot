import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getJobImport: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: { getJobImport: mocks.getJobImport } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());
const importId = "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98";
const context = (value: string) => ({ params: Promise.resolve({ importId: value }) });

it("使用 HttpOnly 会话无缓存地代理所属岗位导入", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getJobImport.mockResolvedValue({ importId });
  const response = await GET(new Request(`http://localhost/api/job-imports/${importId}`), context(importId));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ importId });
  expect(mocks.getJobImport).toHaveBeenCalledWith("a".repeat(43), importId);
});

it("阻止未认证、无效或无法读取的岗位导入", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(GET(new Request("http://localhost/api/job-imports/x"), context("x"))).resolves.toMatchObject({ status: 401 });
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(GET(new Request("http://localhost/api/job-imports/x"), context("x"))).resolves.toMatchObject({ status: 404 });
  mocks.getJobImport.mockRejectedValue({ status: 503 });
  await expect(GET(new Request(`http://localhost/api/job-imports/${importId}`), context(importId))).resolves.toMatchObject({ status: 502 });
});
