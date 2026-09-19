import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createJobExport: vi.fn(), listJobExports: vi.fn(), downloadJobExport: vi.fn(), readSessionToken: vi.fn() }));
vi.mock("@/lib/server/api-client", () => ({ api: mocks }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
import { GET, POST } from "./route";
import { GET as download } from "./[exportId]/download/route";

const id = "00000000-0000-4000-8000-000000000056";
const command = { commandId: id, filter: "active", fieldVersion: 1 };
const post = (body: unknown) => new Request("http://localhost/api/job-exports", { method: "POST", body: JSON.stringify(body) });
const params = { params: Promise.resolve({ exportId: id }) };
afterEach(() => vi.resetAllMocks());

it("鉴权后才接受白名单导出命令，读写均禁止缓存", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  expect((await POST(post(command))).status).toBe(401);
  expect((await GET()).status).toBe(401);
  expect(mocks.createJobExport).not.toHaveBeenCalled();
  mocks.readSessionToken.mockResolvedValue("session");
  expect((await POST(post({ ...command, userId: id }))).status).toBe(400);
  mocks.createJobExport.mockResolvedValue({ id });
  const created = await POST(post(command));
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.createJobExport).toHaveBeenCalledWith("session", command);
  mocks.listJobExports.mockResolvedValue({ items: [] });
  expect((await GET()).headers.get("cache-control")).toBe("private, no-store");
});

it("CSV 下载不暴露存储地址，保留字节和安全响应头", async () => {
  mocks.readSessionToken.mockResolvedValue("session");
  const bytes = new TextEncoder().encode('\uFEFF"岗位"\r\n"前端"\r\n');
  mocks.downloadJobExport.mockResolvedValue(new Response(bytes, { headers: { location: "https://private-store/secret" } }));
  const result = await download(new Request("http://localhost"), params);
  expect(Array.from(new Uint8Array(await result.arrayBuffer()))).toEqual(Array.from(bytes));
  expect(result.headers.get("location")).toBeNull();
  expect(result.headers.get("content-disposition")).toBe(`attachment; filename="job-opportunities-${id}.csv"`);
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(result.headers.get("cache-control")).toBe("private, no-store");
});

it("未登录、非法 ID、跨账户和过期下载不返回文件，也不透传错误文本", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  expect((await download(new Request("http://localhost"), params)).status).toBe(401);
  mocks.readSessionToken.mockResolvedValue("session");
  expect((await download(new Request("http://localhost"), { params: Promise.resolve({ exportId: "../secret" }) })).status).toBe(400);
  for (const status of [404, 410, 503]) {
    mocks.downloadJobExport.mockRejectedValue({ status, message: "secret-storage-error" });
    const result = await download(new Request("http://localhost"), params);
    expect(result.status).toBe(status);
    expect(await result.text()).toBe("");
  }
});
