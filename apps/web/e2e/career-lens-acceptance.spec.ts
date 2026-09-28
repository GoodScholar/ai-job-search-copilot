import { expect, test, type Page } from "@playwright/test";

const authenticatedRoutes = [
  "/home",
  "/recommendations",
  "/profile",
  "/profile/targets",
  "/jobs/import",
  "/profile/run-policy",
  "/profile/model-connection",
] as const;

function screenshotPath(route: string, project: string): string {
  const filename = `${route === "/" ? "marketing" : route.slice(1).replaceAll("/", "-")}-${project.replaceAll(" ", "-").toLowerCase()}.png`;
  const phase = process.env.CAREER_LENS_CAPTURE === "after" ? "after" : "before";
  return `../../docs/qa/issue-66/screenshots/${phase}/${filename}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?returnTo=%2Fhome");
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();
  await expect(page).toHaveURL(/\/home$/u);
}

test("captures real Alpha routes for the career lens acceptance review", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: screenshotPath("/", testInfo.project.name), fullPage: true });

  await page.goto("/login?returnTo=%2Fhome");
  await expect(page.getByRole("main")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: screenshotPath("/login", testInfo.project.name), fullPage: true });

  await signIn(page);
  for (const route of authenticatedRoutes) {
    await page.goto(route);
    await expect(page.getByRole("main")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).resolves.toBe(true);
    await page.screenshot({ path: screenshotPath(route, testInfo.project.name), fullPage: true });
  }

  testInfo.annotations.push({
    type: "UNVERIFIED",
    description: "动态 watchlist 路由和依赖真实 Inbox、导入审核、首次旅程、推荐校准数据的任务态，需要各既有 E2E fixture 采集，不能由此 spec 虚构。",
  });
});
