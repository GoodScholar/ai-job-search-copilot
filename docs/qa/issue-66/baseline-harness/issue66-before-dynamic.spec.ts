import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const devAuthSecret = "issue-2-e2e-dev-auth-shared-secret";

function screenshotPath(name: string, info: TestInfo): string {
  const viewport = info.project.name === "Mobile Safari" ? "mobile-safari" : "desktop-chrome";
  return `../../docs/qa/issue-66/screenshots/before/${name}-${viewport}.png`;
}

async function createSession(request: APIRequestContext, subject: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": devAuthSecret },
    data: { subject: `${subject}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { sessionToken: string }).sessionToken;
}

async function signIn(page: Page, token: string): Promise<void> {
  await page.context().addCookies([{
    name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
  }]);
}

async function createCandidateReview(request: APIRequestContext, token: string): Promise<void> {
  const created = await request.post(`${apiBaseUrl}/v1/career-documents/imports`, {
    headers: { authorization: `Bearer ${token}` },
    multipart: {
      privacyMode: "sanitized_only",
      file: { name: "issue66-before.md", mimeType: "text/markdown", buffer: Buffer.from("## 技能\n- TypeScript", "utf8") },
    },
  });
  expect(created.status()).toBe(202);
  const { importId } = await created.json() as { importId: string };
  await expect.poll(async () => {
    const detail = await request.get(`${apiBaseUrl}/v1/career-documents/imports/${importId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return detail.ok() ? (await detail.json() as { status: string }).status : "unavailable";
  }, { timeout: 20_000 }).toBe("completed");
}

test("captures the pre-migration Inbox state from origin/main", async ({ page, request }, info) => {
  const token = await createSession(request, "issue66-before-inbox");
  await createCandidateReview(request, token);
  await signIn(page, token);
  await page.goto("/home");
  await expect(page.getByRole("article", { name: "有待确认的画像事实" })).toBeVisible();
  await page.screenshot({ path: screenshotPath("home-inbox", info), fullPage: true });
});

test("captures the pre-migration first recommendation journey from origin/main", async ({ page, request }, info) => {
  const token = await createSession(request, "issue66-before-first-journey");
  await signIn(page, token);
  await page.goto("/home");
  await expect(page.getByRole("region", { name: "首次推荐旅程" })).toBeVisible();
  await page.screenshot({ path: screenshotPath("home-first-recommendation-journey", info), fullPage: true });
});

test("captures the pre-migration import review state from origin/main", async ({ page, request }, info) => {
  const token = await createSession(request, "issue66-before-import-review");
  await createCandidateReview(request, token);
  await signIn(page, token);
  await page.goto("/profile#candidate-facts");
  await expect(page.getByRole("heading", { name: "待确认事实" })).toBeVisible();
  await expect(page.getByText("TypeScript", { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshotPath("profile-import-review", info), fullPage: true });
});
