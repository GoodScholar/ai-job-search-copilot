import type { Page, TestInfo } from "@playwright/test";

function projectName(info: TestInfo): string {
  return info.project.name === "Mobile Safari" ? "mobile-safari" : "desktop-chrome";
}

/** Captures only explicit Issue #66 after-state evidence; normal E2E runs never write screenshots. */
export async function captureAfterState(page: Page, route: string, state: string, info: TestInfo): Promise<void> {
  if (process.env.CAREER_LENS_CAPTURE !== "after") return;
  await page.screenshot({
    path: `../../docs/qa/issue-66/screenshots/after/${route}-${state}-${projectName(info)}.png`,
    fullPage: true,
  });
}
