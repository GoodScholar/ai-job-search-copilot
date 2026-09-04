import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJobImports: vi.fn(),
  getJobTargets: vi.fn(),
  jobImportView: vi.fn(() => null),
  unstableRethrow: vi.fn((error: unknown) => { if (error instanceof Error && error.message.startsWith("NEXT_")) throw error; }),
}));

vi.mock("@/lib/server/job-imports", () => ({ getJobImports: mocks.getJobImports }));
vi.mock("@/lib/server/job-targets", () => ({ getJobTargets: mocks.getJobTargets }));
vi.mock("next/navigation", () => ({ unstable_rethrow: mocks.unstableRethrow }));
vi.mock("@/components/workbench/job-import-view", () => ({ JobImportView: mocks.jobImportView }));

import JobImportPage, { metadata } from "./page";

it("声明岗位导入页面并将认证首读传给客户端工作台", async () => {
  const imported = { importId: "b0d2bfbf-7e40-49fc-86c8-3a15d7ad4f98", inputType: "pasted_text", originalFilename: null, status: "imported", failureCode: null, createdAt: "2026-08-28T08:00:00.000Z", updatedAt: "2026-08-28T08:00:00.000Z" };
  mocks.getJobImports.mockResolvedValue({ imports: [imported] });
  mocks.getJobTargets.mockResolvedValue({ suggestions: [], targets: [] });

  expect(metadata.title).toBe("导入岗位 | AI Job Search Copilot");
  const page = await JobImportPage();
  expect(page.props.initialImports).toEqual([imported]);
  expect(page.props.initialTargets).toEqual([]);
});

it("保留 Next 登录控制流，并隐藏可恢复的服务端错误细节", async () => {
  const redirectError = new Error("NEXT_REDIRECT:/login?returnTo=%2Fjobs%2Fimport");
  mocks.getJobImports.mockRejectedValue(redirectError);
  await expect(JobImportPage()).rejects.toThrow("NEXT_REDIRECT:/login?returnTo=%2Fjobs%2Fimport");

  mocks.getJobImports.mockRejectedValue(new Error("http://internal-api:3021 secret failure"));
  const page = await JobImportPage();
  expect(JSON.stringify(page)).not.toContain("internal-api");
});
