import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?returnTo=%2Fprofile%2Ftargets");
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();
  await expect(page).toHaveURL(/\/profile\/targets$/);
}

async function replaceActiveTarget(page: Page): Promise<void> {
  while (await page.getByRole("button", { name: /^停用 / }).count()) {
    await page.getByRole("button", { name: /^停用 / }).first().click();
    await expect(page.getByRole("status")).toHaveText("求职目标已停用。");
  }
  await page.getByLabel("目标岗位方向").fill("AI 应用工程师");
  await page.getByLabel("意向地点（用逗号分隔）").fill("北京, 深圳");
  await page.getByLabel("工作方式").selectOption(["hybrid", "remote"]);
  await page.getByRole("button", { name: "保存主目标" }).click();
  await expect(page.getByRole("status")).toHaveText("求职目标已保存。");
}

test("从求职目标启动可恢复岗位发现，并复用幂等请求与展示持久结果", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await signIn(page);
  await replaceActiveTarget(page);
  await page.getByRole("link", { name: "AI Job Search Copilot" }).click();
  await expect(page).toHaveURL(/\/home$/);

  const targetSelector = page.getByRole("combobox", { name: "用于发现岗位的求职目标" });
  const startButton = page.getByRole("button", { name: "发现岗位" });
  await expect(targetSelector).toContainText("AI 应用工程师 · 主目标");
  expect(await startButton.evaluate((button) => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);

  const startRequest = page.waitForRequest((request) => request.url().endsWith("/api/agent-runs") && request.method() === "POST");
  const startResponse = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  if (testInfo.project.name === "Mobile Safari") await startButton.tap();
  else await startButton.click();
  const request = await startRequest;
  const response = await startResponse;
  expect([200, 201]).toContain(response.status());
  const body = request.postDataJSON() as { targetId: string; idempotencyKey: string };
  const started = await response.json() as { runId: string };

  const duplicate = await page.request.post("/api/agent-runs", { data: body });
  expect(duplicate.status()).toBe(200);
  await expect(duplicate.json()).resolves.toMatchObject({ runId: started.runId, reused: true });

  const timeline = page.getByRole("list", { name: "岗位发现运行时间线" });
  await expect(timeline).toContainText("已排队");
  await expect(timeline).toContainText("开始发现岗位");
  await expect(timeline).toContainText("正在搜索岗位来源");
  await expect(timeline).toContainText("正在读取岗位详情");
  await expect(timeline).toContainText("正在保存岗位结果");

  await page.reload();
  await expect(page.getByRole("list", { name: "岗位发现运行时间线" })).toContainText("岗位发现完成", { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText("岗位发现完成");
  await expect(page.getByRole("heading", { level: 4, name: /AI 应用工程师/ }).first()).toBeVisible();
  await expect(page.locator(".agent-run-results")).toContainText(/曙光云图|星轨智造/);
  await expect(page.locator(".agent-run-results")).toContainText(/北京|深圳/);
  await expect(page.locator(".agent-run-results")).toContainText("公司招聘官网");
  await expect(page.getByLabel("当前求职记录摘要").getByText("今日推荐").locator("xpath=following-sibling::dd")).toHaveText("0");
  if (testInfo.project.name === "Desktop Chrome") {
    await targetSelector.focus();
    await expect(targetSelector).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "发现岗位" })).toBeFocused();
  }
  expect(await targetSelector.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
