import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const secret = "issue-2-e2e-dev-auth-shared-secret";
const scenario = process.env.E2E_MODEL_DIAGNOSTIC_SCENARIO ?? "success";

async function session(request: APIRequestContext, subject: string) {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject } });
  expect(response.status()).toBe(201);
  return response.json() as Promise<{ sessionToken: string }>;
}

async function useSession(page: Page, token: string) {
  await page.context().addCookies([{ name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}

async function enterModelConnection(page: Page) {
  await page.goto("/home");
  await page.getByRole("link", { name: "检查模型连接" }).click();
  await expect(page).toHaveURL(/\/profile\/model-connection$/u);
}

async function verifyCommonAccessibility(page: Page, testInfo: TestInfo) {
  const button = page.getByRole("button", { name: "检查模型连接" });
  if (await button.isEnabled()) {
    await button.focus();
    await expect(button).toBeFocused();
  } else {
    await expect(button).toBeDisabled();
    await expect(page.getByText(/可在.*后重试/u)).toBeVisible();
  }
  expect(await page.locator("html").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(new AxeBuilder({ page }).include("main").analyze()).resolves.toMatchObject({ violations: [] });
  await page.screenshot({ path: `/tmp/issue50-validation-20260905/${scenario}-${testInfo.project.name.replaceAll(" ", "-").toLowerCase()}.png`, fullPage: true });
}

test("从运行设置进入模型连接页并以受控 Fake 展示稳定状态", async ({ page, request }, testInfo) => {
  const { sessionToken } = await session(request, `model-diagnostics-${scenario}-${testInfo.project.name}-${Date.now()}`);
  await useSession(page, sessionToken);
  await enterModelConnection(page);
  const status = page.getByRole("status");
  const unverified = await status.textContent().then((text) => text?.includes("尚未完成模型连接检查"));
  const firstSelectedProject = process.env.E2E_MODEL_DIAGNOSTIC_INITIAL_PROJECT ?? "Desktop Chrome";
  if (testInfo.retry === 0 && testInfo.project.name === firstSelectedProject) await expect(status).toContainText("尚未完成模型连接检查");
  if (unverified) await expect(status).toContainText("尚未完成模型连接检查");

  if (scenario === "success") {
    if (unverified) await page.getByRole("button", { name: "检查模型连接" }).click();
    await expect(page.getByRole("status")).toContainText("模型连接正常");
    await page.reload();
    await expect(page.getByRole("status")).toContainText("模型连接正常");
    await expect(page.getByText("身份验证")).toBeVisible();
    await expect(page.getByText("通过", { exact: true }).first()).toBeVisible();
  } else if (scenario === "authentication_failed") {
    if (unverified) await page.getByRole("button", { name: "检查模型连接" }).click();
    await expect(page.getByRole("status")).toContainText("模型服务认证失败");
    await expect(page.getByText("请联系部署管理员检查服务凭据。")).toBeVisible();
  } else if (scenario === "provider_unavailable") {
    if (unverified) await page.getByRole("button", { name: "检查模型连接" }).click();
    await expect(page.getByRole("status")).toContainText("模型服务暂不可用");
    await expect(page.getByText("请稍后重试。")).toBeVisible();
  } else {
    await expect(page.getByRole("status")).toContainText("模型连接正常");
  }

  await expect(page.locator("body")).not.toContainText(/API Key|供应商账户|组织\/项目|配置指纹|模型 ID/u);
  await verifyCommonAccessibility(page, testInfo);
});
