import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const secret = "issue-2-e2e-dev-auth-shared-secret";

test("推荐导航在桌面与移动端显示可访问的空清单", async ({ page, request }, info) => {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject: `recommendations-${info.project.name}-${Date.now()}` } });
  expect(session.status()).toBe(201);
  const token = (await session.json() as { sessionToken: string }).sessionToken;
  await page.context().addCookies([{ name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/recommendations");
  await expect(page.getByRole("heading", { name: "推荐清单" })).toBeVisible();
  await expect(page.getByText("暂无可处理的推荐")).toBeVisible();
  await expect(page.getByRole("link", { name: "推荐" })).toHaveAttribute("aria-current", "page");
  expect(await new AxeBuilder({ page }).analyze()).toMatchObject({ violations: [] });
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
});
