import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function createSession(request: APIRequestContext, subject: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { sessionToken: string }).sessionToken;
}

async function createTarget(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/job-targets`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      priority: "primary",
      constraints: {
        roleFamily: "AI 应用工程师", seniority: "高级", locations: ["上海"], workModes: ["hybrid"], relocation: "conditional",
        salary: { minimum: 30000, maximum: 45000, period: "month", currency: "CNY" }, industries: ["AI"],
        dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
      },
    },
  });
  expect(response.status()).toBe(201);
  const overview = await response.json() as { targets: Array<{ targetId: string; priority: string }> };
  return overview.targets.find((target) => target.priority === "primary")!.targetId;
}

async function signInAtWatchlist(page: Page, request: APIRequestContext, project: string): Promise<{ token: string; targetId: string }> {
  const token = await createSession(request, `company-watchlist-${project}-${runSuffix}`);
  const targetId = await createTarget(request, token);
  await page.context().addCookies([{ name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto(`/profile/targets/${targetId}/watchlist`);
  return { token, targetId };
}

async function addCompany(page: Page, company: string, careersUrl: string, domain: string, note = ""): Promise<void> {
  await page.getByLabel("公司规范名称").fill(company);
  await page.getByLabel("公开招聘入口").fill(careersUrl);
  await page.getByLabel("允许域").fill(domain);
  if (note) await page.getByLabel("来源备注").fill(note);
  await page.getByRole("button", { name: "保存目标公司" }).click();
  await expect(page.getByRole("status")).toHaveText("目标公司已添加。");
}

test("目标公司 Watchlist 可添加、排序、禁用、重载并显示并发冲突", async ({ page, request }, testInfo) => {
  const { token, targetId } = await signInAtWatchlist(page, request, testInfo.project.name);
  await expect(page.getByText("尚未登记目标公司。添加第一个公开来源后，它会成为优先级 01。")).toBeVisible();
  await expect(page.getByText("不要填写账号、密码、Cookie、验证码或绕过登录限制的说明。")).toBeVisible();

  await addCompany(page, "曙光云图", "https://careers.aurora.example/jobs", "careers.aurora.example", "优先核验 AI 平台团队");
  await addCompany(page, "星轨智造", "https://careers.orbit.example/jobs", "careers.orbit.example");
  await page.getByRole("button", { name: "上移 星轨智造" }).click();
  await expect(page.getByRole("status")).toHaveText("Watchlist 优先级已更新。");
  await page.getByRole("button", { name: "停用 星轨智造" }).click();
  await expect(page.getByRole("status")).toHaveText("来源已停用。");
  await expect(page.getByText("已停用", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("星轨智造", { exact: true })).toBeVisible();
  await expect(page.getByText("曙光云图", { exact: true })).toBeVisible();
  await expect(page.getByText("优先核验 AI 平台团队")).toBeVisible();
  await expect(page.getByText("Watchlist 版本 4")).toBeVisible();
  const apiOverview = await request.get(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist`, { headers: { authorization: `Bearer ${token}` } });
  expect(apiOverview.status()).toBe(200);
  const data = await apiOverview.json() as { version: number; items: Array<{ itemId: string; canonicalCompanyName: string; state: "enabled" | "disabled" }> };
  const orbit = data.items.find((item) => item.canonicalCompanyName === "星轨智造")!;
  const advance = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items/${orbit.itemId}/state-changes`, {
    headers: { authorization: `Bearer ${token}` }, data: { expectedVersion: data.version, state: "enabled" },
  });
  expect(advance.status()).toBe(201);
  await page.getByRole("button", { name: "编辑 星轨智造" }).click();
  await page.getByLabel("来源备注").fill("保持可见的过期编辑");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toHaveText("Watchlist 已在其他位置更新，请刷新后重试。");
  await expect(page.getByLabel("来源备注")).toHaveValue("保持可见的过期编辑");

  const cancel = page.getByRole("button", { name: "取消编辑" });
  await cancel.focus();
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "添加目标公司" })).toBeVisible();
  const controls = page.locator(".company-watchlist-main button, .company-watchlist-main a");
  expect(await controls.evaluateAll((nodes) => nodes.every((node) => node.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
