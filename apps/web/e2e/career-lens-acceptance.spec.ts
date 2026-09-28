import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const devAuthSecret = "issue-2-e2e-dev-auth-shared-secret";

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

function fixtureScreenshotPath(name: string, project: string): string {
  const phase = process.env.CAREER_LENS_CAPTURE === "after" ? "after" : "before";
  return `../../docs/qa/issue-66/screenshots/${phase}/${name}-${project.replaceAll(" ", "-").toLowerCase()}.png`;
}

async function createWatchlistFixture(request: APIRequestContext, project: string): Promise<{ token: string; targetId: string }> {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": devAuthSecret }, data: { subject: `career-lens-acceptance-${project}-${Date.now()}` },
  });
  expect(session.status()).toBe(201);
  const token = (await session.json() as { sessionToken: string }).sessionToken;
  const target = await request.post(`${apiBaseUrl}/v1/job-targets`, {
    headers: { authorization: `Bearer ${token}` },
    data: { priority: "primary", constraints: {
      roleFamily: "职业透镜验收工程师", seniority: "中级", locations: ["上海"], workModes: ["hybrid"], relocation: "not_willing", salary: null, industries: [],
      dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
    } },
  });
  expect(target.status()).toBe(201);
  const targetId = (await target.json() as { targets: Array<{ targetId: string; priority: string }> }).targets.find((entry) => entry.priority === "primary")!.targetId;
  const source = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items`, {
    headers: { authorization: `Bearer ${token}` },
    data: { expectedVersion: 0, canonicalCompanyName: "职业透镜真实验收来源", careersUrl: "https://boards.greenhouse.io/career-lens-acceptance", allowedDomains: ["boards.greenhouse.io"], sourceNote: "真实 runtime 验收 fixture" },
  });
  expect(source.status()).toBe(201);
  return { token, targetId };
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?returnTo=%2Fhome");
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();
  await expect(page).toHaveURL(/\/home$/u);
}

async function createCandidateReviewFixture(request: APIRequestContext, project: string): Promise<string> {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": devAuthSecret }, data: { subject: `career-lens-review-${project}-${Date.now()}` },
  });
  expect(session.status()).toBe(201);
  const token = (await session.json() as { sessionToken: string }).sessionToken;
  const created = await request.post(`${apiBaseUrl}/v1/career-documents/imports`, {
    headers: { authorization: `Bearer ${token}` },
    multipart: { privacyMode: "sanitized_only", file: { name: "career-lens-review.md", mimeType: "text/markdown", buffer: Buffer.from("## 技能\n- TypeScript", "utf8") } },
  });
  expect(created.status()).toBe(202);
  const { importId } = await created.json() as { importId: string };
  await expect.poll(async () => {
    const detail = await request.get(`${apiBaseUrl}/v1/career-documents/imports/${importId}`, { headers: { authorization: `Bearer ${token}` } });
    return detail.ok() ? (await detail.json() as { status: string }).status : "unavailable";
  }, { timeout: 20_000 }).toBe("completed");
  return token;
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${route} must not overflow at the active viewport`).toBe(true);
    await page.screenshot({ path: screenshotPath(route, testInfo.project.name), fullPage: true });
  }

  testInfo.annotations.push({
    type: "UNVERIFIED",
    description: "动态 watchlist 路由和依赖真实 Inbox、导入审核、首次旅程、推荐校准数据的任务态，需要各既有 E2E fixture 采集，不能由此 spec 虚构。",
  });
});

test("captures a seeded real Watchlist route without substituting prototype data", async ({ page, request }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await createWatchlistFixture(request, testInfo.project.name);
  await page.context().addCookies([{ name: "job_copilot_session", value: fixture.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto(`/profile/targets/${fixture.targetId}/watchlist`);
  await expect(page.getByRole("main", { name: "公司来源台账" })).toBeVisible();
  await expect(page.getByRole("article", { name: "目标公司来源：职业透镜真实验收来源" })).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).resolves.toBe(true);
  await page.screenshot({ path: fixtureScreenshotPath("profile-targets-watchlist-seeded", testInfo.project.name), fullPage: true });
});

test("captures real Inbox、导入审核与首次推荐旅程状态", async ({ page, request }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const token = await createCandidateReviewFixture(request, testInfo.project.name);
  await page.context().addCookies([{ name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);

  await page.goto("/home");
  await expect(page.getByRole("region", { name: "需要你决定的事项", exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "有待确认的画像事实" })).toBeVisible();
  await expect(page.getByRole("region", { name: "首次推荐旅程" })).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).resolves.toBe(true);
  await page.screenshot({ path: fixtureScreenshotPath("home-inbox", testInfo.project.name), fullPage: true });
  await page.screenshot({ path: fixtureScreenshotPath("home-first-recommendation-journey", testInfo.project.name), fullPage: true });

  await page.goto("/profile#candidate-facts");
  await expect(page.getByRole("heading", { name: "待确认事实" })).toBeVisible();
  await expect(page.getByText("TypeScript", { exact: true })).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).resolves.toBe(true);
  await page.screenshot({ path: fixtureScreenshotPath("profile-import-review", testInfo.project.name), fullPage: true });
});
