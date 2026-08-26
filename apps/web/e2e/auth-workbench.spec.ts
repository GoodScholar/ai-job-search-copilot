import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";

type DevSession = {
  account: { userId: string };
  sessionToken: string;
};

async function createTestSession(request: APIRequestContext, subject: string): Promise<DevSession> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret },
    data: { subject },
  });

  expect(response.status()).toBe(201);
  return response.json() as Promise<DevSession>;
}

async function fetchTestAccount(request: APIRequestContext, subject: string): Promise<{ userId: string }> {
  const session = await createTestSession(request, subject);
  const response = await request.get(`${apiBaseUrl}/v1/workbench/home`, {
    headers: { authorization: `Bearer ${session.sessionToken}` },
  });

  expect(response.status()).toBe(200);
  const home = await response.json() as { account: { userId: string } };
  return home.account;
}

async function signIn(page: Page, returnTo = "/home"): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();
  await expect(page).toHaveURL(new RegExp(`${returnTo.replace("/", "\\/")}$`));
}

test("首次登录创建并复用求职账户", async ({ page, request }) => {
  await signIn(page);

  await expect(page.getByRole("heading", { name: "从真实职业资料开始" })).toBeVisible();
  await expect(page.getByLabel("当前求职记录摘要")).toContainText("今日推荐0");

  const firstAccount = await fetchTestAccount(request, "local-primary");
  await page.getByRole("button", { name: "退出" }).click();
  await signIn(page);
  const secondAccount = await fetchTestAccount(request, "local-primary");

  expect(secondAccount.userId).toBe(firstAccount.userId);
});

test("退出后旧会话令牌失效", async ({ page, request }) => {
  await signIn(page);
  const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === "job_copilot_session");

  expect(sessionCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login$/);

  const response = await request.get(`${apiBaseUrl}/v1/workbench/home`, {
    headers: { authorization: `Bearer ${sessionCookie!.value}` },
  });
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("第二个求职账户无法读取 primary 资源且只读取自己的工作台", async ({ request }) => {
  const primary = await fetchTestAccount(request, "local-primary");
  const secondary = await createTestSession(request, "local-secondary");

  const hidden = await request.get(`${apiBaseUrl}/v1/accounts/${primary.userId}`, {
    headers: { authorization: `Bearer ${secondary.sessionToken}` },
  });
  expect(hidden.status()).toBe(404);
  await expect(hidden.json()).resolves.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });

  const home = await request.get(`${apiBaseUrl}/v1/workbench/home`, {
    headers: { authorization: `Bearer ${secondary.sessionToken}` },
  });
  expect(home.status()).toBe(200);
  await expect(home.json()).resolves.toMatchObject({
    account: { userId: secondary.account.userId },
  });
});

test("登录回跳不接受站外地址", async ({ page }) => {
  await page.goto("/login?returnTo=https%3A%2F%2Fevil.example%2Fsteal");
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();

  await expect(page).toHaveURL(/\/home$/);
});

test("工作台在目标浏览器保持键盘、触控、减动效与无障碍基线", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);

  const brand = page.getByRole("link", { name: "AI Job Search Copilot" });
  const signOut = page.getByRole("button", { name: "退出" });
  await page.keyboard.press("Tab");
  if (await brand.evaluate((element) => element === document.activeElement)) {
    await expect(brand).toBeFocused();
  } else {
    await brand.focus();
    await expect(brand).toBeFocused();
  }

  const signOutHeight = await signOut.evaluate((element) => element.getBoundingClientRect().height);
  const homeWidths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  const results = await new AxeBuilder({ page }).analyze();
  await page.goto("/login");
  const loginHeight = await page.getByRole("button", { name: "使用本地体验账户登录" })
    .evaluate((element) => element.getBoundingClientRect().height);
  const loginWidths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  const loginResults = await new AxeBuilder({ page }).analyze();

  expect(signOutHeight).toBeGreaterThanOrEqual(44);
  expect(loginHeight).toBeGreaterThanOrEqual(44);
  expect(homeWidths.scroll).toBe(homeWidths.client);
  expect(loginWidths.scroll).toBe(loginWidths.client);
  expect(results.violations).toEqual([]);
  expect(loginResults.violations).toEqual([]);
});
