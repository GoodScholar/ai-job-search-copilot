import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listJobImports: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/api-client", () => ({ api: { listJobImports: mocks.listJobImports } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { getJobImports } from "./job-imports";

afterEach(() => vi.clearAllMocks());

it("只读取当前会话的岗位导入，并在会话失效时返回登录边界", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(getJobImports()).rejects.toThrow("redirect:/login?returnTo=%2Fjobs%2Fimport");

  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listJobImports.mockResolvedValue({ imports: [] });
  await expect(getJobImports()).resolves.toEqual({ imports: [] });
  expect(mocks.listJobImports).toHaveBeenCalledWith("a".repeat(43));
});
