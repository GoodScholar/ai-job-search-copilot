import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCareerImports: vi.fn(),
  profileImportView: vi.fn(() => null),
  unstableRethrow: vi.fn((error: unknown) => { throw error; }),
}));

vi.mock("@/lib/server/career-imports", () => ({ getCareerImports: mocks.getCareerImports }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.unstableRethrow }));
vi.mock("@/components/workbench/profile-import-view", () => ({ ProfileImportView: mocks.profileImportView }));

import ProfilePage, { metadata } from "./page";

it("declares the profile page and preserves Next control-flow errors", async () => {
  expect(metadata.title).toBe("画像 | AI Job Search Copilot");
  const redirectError = new Error("NEXT_REDIRECT:/login?returnTo=%2Fprofile");
  mocks.getCareerImports.mockRejectedValue(redirectError);

  await expect(ProfilePage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/login?returnTo=%2Fprofile");
  expect(mocks.unstableRethrow).toHaveBeenCalledWith(redirectError);
});

it("performs the authenticated RSC first read before passing only the latest import to the client view", async () => {
  const latest = {
    importId: "d194d0ce-fc7e-45db-9425-e8ff4eaf8c08",
    documentId: "b4d4a7c1-9a17-4a8c-8b36-0f815d042e9a",
    sourceFilename: "career.md", status: "queued", failureCode: null,
    createdAt: "2026-08-27T08:00:00.000Z", updatedAt: "2026-08-27T08:00:00.000Z", candidateFactCount: 0,
  };
  mocks.getCareerImports.mockResolvedValue({ imports: [latest] });

  const page = await ProfilePage({ searchParams: Promise.resolve({}) });

  expect(page.props.initialImport).toEqual(latest);
});

it("passes only a whitelisted no-JavaScript upload failure message to the view", async () => {
  mocks.getCareerImports.mockResolvedValue({ imports: [] });

  const page = await ProfilePage({ searchParams: Promise.resolve({ importError: "CAREER_DOCUMENT_EMPTY" }) });

  expect(page.props.initialErrorMessage).toBe("Markdown 文件不能为空。");
});

it.each(["unknown", "toString", "constructor", "__proto__", ["CAREER_DOCUMENT_EMPTY"]])("drops unsafe profile query value %j", async (importError) => {
  mocks.getCareerImports.mockResolvedValue({ imports: [] });

  const page = await ProfilePage({ searchParams: Promise.resolve({ importError }) });

  expect(page.props.initialErrorMessage).toBeNull();
});
