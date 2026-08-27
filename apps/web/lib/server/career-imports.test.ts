import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCareerImports: vi.fn(),
  readSessionToken: vi.fn(),
  redirect: vi.fn((location: string) => { throw new Error(`redirect:${location}`); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/api-client", () => ({ api: { listCareerImports: mocks.listCareerImports } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { getCareerImports } from "./career-imports";

afterEach(() => vi.clearAllMocks());

it("redirects unauthenticated profile reads and rechecks API authentication", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(getCareerImports()).rejects.toThrow("redirect:/login?returnTo=%2Fprofile");
  expect(mocks.listCareerImports).not.toHaveBeenCalled();

  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listCareerImports.mockRejectedValue({ status: 401 });
  await expect(getCareerImports()).rejects.toThrow("redirect:/login?returnTo=%2Fprofile");
});

it("reads only imports available to the current session", async () => {
  const imports = { imports: [] };
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.listCareerImports.mockResolvedValue(imports);

  await expect(getCareerImports()).resolves.toEqual(imports);
  expect(mocks.listCareerImports).toHaveBeenCalledWith("a".repeat(43));
});
