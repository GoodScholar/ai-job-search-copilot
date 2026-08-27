import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCareerImport: vi.fn(),
  readSessionToken: vi.fn(),
}));

vi.mock("@/lib/server/api-client", () => ({ api: { getCareerImport: mocks.getCareerImport } }));
vi.mock("@/lib/server/session-cookie", () => ({ readSessionToken: mocks.readSessionToken }));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());

const context = (importId: string) => ({ params: Promise.resolve({ importId }) });

it("uses the HttpOnly session to proxy an owned import without caching", async () => {
  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  mocks.getCareerImport.mockResolvedValue({ importId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08" });

  const response = await GET(new Request("http://localhost/api/career-imports/d194d0ce-fc7e-45db-9425-e8ff4eaf8c08"), context("d194d0ce-fc7e-45db-9425-e8ff4eaf8c08"));

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ importId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08" });
  expect(mocks.getCareerImport).toHaveBeenCalledWith("a".repeat(43), "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08");
});

it("rejects unauthenticated and invalid requests, preserving upstream 401 and 404", async () => {
  mocks.readSessionToken.mockResolvedValue(null);
  await expect(GET(new Request("http://localhost/api/career-imports/x"), context("x"))).resolves.toMatchObject({ status: 401 });
  expect(mocks.getCareerImport).not.toHaveBeenCalled();

  mocks.readSessionToken.mockResolvedValue("a".repeat(43));
  await expect(GET(new Request("http://localhost/api/career-imports/x"), context("x"))).resolves.toMatchObject({ status: 404 });

  mocks.getCareerImport.mockRejectedValue({ status: 401 });
  await expect(GET(new Request("http://localhost/api/career-imports/d194d0ce-fc7e-45db-9425-e8ff4eaf8c08"), context("d194d0ce-fc7e-45db-9425-e8ff4eaf8c08"))).resolves.toMatchObject({ status: 401 });
  mocks.getCareerImport.mockRejectedValue({ status: 404 });
  await expect(GET(new Request("http://localhost/api/career-imports/d194d0ce-fc7e-45db-9425-e8ff4eaf8c08"), context("d194d0ce-fc7e-45db-9425-e8ff4eaf8c08"))).resolves.toMatchObject({ status: 404 });
});
