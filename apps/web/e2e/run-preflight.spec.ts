import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const secret = "issue-2-e2e-dev-auth-shared-secret";

test("新账户在工作台看到可修复的运行前阻塞，且不会创建运行", async ({ page, request }) => {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject: `run-preflight-${test.info().project.name}-${Date.now()}` } });
  expect(session.status()).toBe(201);
  const { sessionToken } = await session.json() as { sessionToken: string };
  await page.context().addCookies([{ name: "job_copilot_session", value: sessionToken, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/home");

  const preflight = page.getByRole("region", { name: "运行前检查" });
  await expect(preflight).toBeVisible();
  await expect(preflight.getByText("暂不能启动")).toBeVisible();
  await expect(preflight.getByRole("link", { name: "完善求职画像" })).toHaveAttribute("href", "/profile");
  await expect(page.getByRole("button", { name: "发现岗位" })).toHaveCount(0);
  await page.getByRole("link", { name: "完善求职画像" }).focus();
  await expect(page.getByRole("link", { name: "完善求职画像" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  await expect(new AxeBuilder({ page }).include("main").analyze()).resolves.toMatchObject({ violations: [] });
});
