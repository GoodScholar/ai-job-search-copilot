import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ addCompanyWatchlistItem: vi.fn(), readSessionToken: vi.fn(), rethrow: vi.fn((error: unknown) => { if (error instanceof Error && error.message.startsWith("NEXT_")) throw error; }) }));
vi.mock("@/lib/server/api-client", () => ({ api: { addCompanyWatchlistItem: mocks.addCompanyWatchlistItem } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.rethrow }));
import { POST } from "./route";

const targetId = "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08";
const context = (value = targetId) => ({ params: Promise.resolve({ targetId: value }) });
const command = { expectedVersion: 0, canonicalCompanyName: "曙光云图", careersUrl: "https://careers.aurora.example/jobs", allowedDomains: ["careers.aurora.example"], sourceNote: null };
const overview = { target: { targetId, targetVersion: 1, targetState: "active", roleFamily: "AI 应用工程" }, version: 1, items: [{ itemId: "87ccabf1-f5fe-430c-9129-df14e4789ec0", canonicalCompanyName: command.canonicalCompanyName, careersUrl: command.careersUrl, allowedDomains: command.allowedDomains, sourceNote: command.sourceNote, state: "enabled", position: 1 }] };
afterEach(() => vi.clearAllMocks());

it("严格验证新增命令并返回经契约验证的结果", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const invalid = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ ...command, cookie: "secret" }) }), context());
  expect(invalid.status).toBe(400);
  expect(mocks.addCompanyWatchlistItem).not.toHaveBeenCalled();
  mocks.addCompanyWatchlistItem.mockResolvedValue(overview);
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context());
  expect(response.status).toBe(201);
  await expect(response.json()).resolves.toEqual(overview);
  expect(mocks.addCompanyWatchlistItem).toHaveBeenCalledWith("a".repeat(43), targetId, command);
});

it("保留新增冲突状态而不泄漏上游内容", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.addCompanyWatchlistItem.mockRejectedValue({ status: 409, message: "Bearer secret" });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context());
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("secret");
});

it("重新抛出 Next 控制流错误", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  const controlFlow = new Error("NEXT_REDIRECT:/login");
  mocks.addCompanyWatchlistItem.mockRejectedValue(controlFlow);
  await expect(POST(new Request("http://localhost", { method: "POST", body: JSON.stringify(command) }), context())).rejects.toThrow("NEXT_REDIRECT:/login");
  expect(mocks.rethrow).toHaveBeenCalledWith(controlFlow);
});
