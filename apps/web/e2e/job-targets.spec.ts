import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function createSession(request: APIRequestContext, subject: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject } });
  expect(response.status()).toBe(201);
  return (await response.json() as { sessionToken: string }).sessionToken;
}

async function seedTrustedFacts(request: APIRequestContext, token: string): Promise<void> {
  const facts = [
    { factType: "skill", factValue: { name: "TypeScript React" } },
    { factType: "experience", factValue: { summary: "AI 应用、LLM 与 Agent 工作流工程" } },
  ];
  for (let version = 0; version < facts.length; version += 1) {
    const response = await request.post(`${apiBaseUrl}/v1/profile/facts`, { headers: { authorization: `Bearer ${token}` }, data: { expectedVersion: version, ...facts[version]! } });
    expect(response.status()).toBe(201);
  }
}

async function signInSeededAccount(page: Page, request: APIRequestContext, project: string): Promise<string> {
  const token = await createSession(request, `job-targets-${project}-${runSuffix}`);
  await seedTrustedFacts(request, token);
  await page.context().addCookies([{ name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/profile/targets");
  return token;
}

async function completeConstraints(page: Page): Promise<void> {
  await page.getByLabel("资历级别").fill("高级");
  await page.getByLabel("意向地点（用逗号分隔）").fill("上海, 杭州");
  await page.getByLabel("工作方式").selectOption(["hybrid", "remote"]);
  await page.getByLabel("是否接受搬迁").selectOption("conditional");
  await page.getByLabel("最低薪资").fill("30000");
  await page.getByLabel("最高薪资").fill("45000");
  await page.getByLabel("意向行业（用逗号分隔）").fill("AI, 企业服务");
  await page.getByLabel("不接受外包").check();
  await page.getByLabel("不接受派遣").check();
  await page.getByLabel("不接受猎头").check();
}

test("求职目标可由可信画像建议确认、持久化、并发提示并停用", async ({ page, request }, testInfo) => {
  const token = await signInSeededAccount(page, request, testInfo.project.name);
  await expect(page.getByRole("heading", { name: "确认你的求职目标" })).toBeVisible();
  await expect(page.getByRole("link", { name: "画像" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".job-target-suggestion-list strong")).toHaveCount(4);

  await page.getByRole("button", { name: "使用 AI 应用工程师 建议" }).click();
  await expect(page.getByLabel("角色族")).toHaveValue("AI 应用工程师");
  await completeConstraints(page);
  await page.getByRole("button", { name: "保存主目标" }).click();
  await expect(page.getByRole("status")).toHaveText("求职目标已保存。");
  await expect(page.getByText(/版本 1/)).toBeVisible();

  await page.getByRole("button", { name: "使用 前端工程师 建议" }).click();
  await page.getByLabel("次目标").check();
  await completeConstraints(page);
  await page.getByRole("button", { name: "保存次目标" }).click();
  await expect(page.getByRole("status")).toHaveText("求职目标已保存。");
  await expect(page.locator(".job-target-history-list").getByText("次目标", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText(/版本 1/).first()).toBeVisible();
  const overviewResponse = await request.get(`${apiBaseUrl}/v1/job-targets`, { headers: { authorization: `Bearer ${token}` } });
  expect(overviewResponse.status()).toBe(200);
  const overview = await overviewResponse.json() as { targets: Array<{ targetId: string; version: number; priority: "primary" | "secondary"; constraints: unknown }> };
  const primary = overview.targets.find((target) => target.priority === "primary")!;

  await page.getByRole("button", { name: "修改 AI 应用工程师" }).click();
  const advance = await request.post(`${apiBaseUrl}/v1/job-targets/${primary.targetId}/revisions`, { headers: { authorization: `Bearer ${token}` }, data: { expectedVersion: primary.version, priority: primary.priority, constraints: primary.constraints } });
  expect(advance.status()).toBe(201);
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toHaveText("目标已在其他位置更新，请刷新后重试。");

  await page.reload();
  await page.getByRole("button", { name: "修改 AI 应用工程师" }).click();
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toHaveText("求职目标已保存。");
  await page.getByRole("button", { name: "停用 AI 应用工程师" }).click();
  await expect(page.getByRole("status")).toHaveText("求职目标已停用。");
  await expect(page.getByText("已停用", { exact: true })).toBeVisible();

  const targetButtons = page.locator(".job-targets-main button");
  expect(await targetButtons.evaluateAll((buttons) => buttons.every((button) => button.getBoundingClientRect().height >= 44))).toBe(true);
  const interactiveLabels = page.locator('.job-target-form fieldset > label:has(input[type="radio"]), .job-target-form fieldset > label:has(input[type="checkbox"]), .job-target-form > label:has(select[multiple])');
  expect(await interactiveLabels.evaluateAll((labels) => labels.every((label) => label.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
