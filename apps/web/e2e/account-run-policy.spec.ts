import AxeBuilder from "@axe-core/playwright";
import type { AccountRunPolicyResponse, AccountRunPolicySettings } from "@job-copilot/contracts/account-run-policies";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type Session = { token: string; userId: string };
type PolicyHistory = { revisions: Array<{ revisionNumber: number; settings: AccountRunPolicySettings }> };
type PolicyProblem = {
  code: string;
  message: string;
  issues: Array<{ reasonCode: string; path: string[]; maximum: number | null; suggestedAction: string }>;
};

async function createSession(request: APIRequestContext, subject: string): Promise<Session> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject },
  });
  expect(response.status()).toBe(201);
  const value = await response.json() as { sessionToken: string; account: { userId: string } };
  return { token: value.sessionToken, userId: value.account.userId };
}

async function useSession(page: Page, session: Session): Promise<void> {
  await page.context().addCookies([{ name: "job_copilot_session", value: session.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}

async function getPolicy(request: APIRequestContext, token: string): Promise<AccountRunPolicyResponse> {
  const response = await request.get(`${apiBaseUrl}/v1/account/run-policy`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  return response.json() as Promise<AccountRunPolicyResponse>;
}

async function getHistory(request: APIRequestContext, token: string): Promise<PolicyHistory> {
  const response = await request.get(`${apiBaseUrl}/v1/account/run-policy/history`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  return response.json() as Promise<PolicyHistory>;
}

function commandFor(policy: AccountRunPolicyResponse, mutate: (settings: AccountRunPolicySettings) => void) {
  const settings = structuredClone(policy.effective);
  mutate(settings);
  return { expectedVersion: policy.revision.revisionNumber, settings };
}

async function savePolicy(request: APIRequestContext, token: string, command: ReturnType<typeof commandFor>): Promise<AccountRunPolicyResponse> {
  const response = await request.put(`${apiBaseUrl}/v1/account/run-policy`, {
    headers: { authorization: `Bearer ${token}` }, data: command,
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<AccountRunPolicyResponse>;
}

async function expectHardLimitProblem(response: APIResponse, maximum: number): Promise<void> {
  expect(response.status()).toBe(400);
  expect(await response.json() as PolicyProblem).toMatchObject({
    code: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED",
    message: expect.any(String),
    issues: [{
      reasonCode: "ACCOUNT_RUN_POLICY_HARD_LIMIT_EXCEEDED",
      path: ["settings", "discovery", "publicQueryLimit"],
      maximum,
      suggestedAction: "reduce_to_system_hard_limit",
    }],
  });
}

test("账户运行策略可从首页和画像进入，保存后保留四层值、刷新与修订历史", async ({ page, request }, testInfo) => {
  const session = await createSession(request, `account-run-policy-journey-${testInfo.project.name}-${runSuffix}`);
  const initial = await getPolicy(request, session.token);
  await useSession(page, session);

  await page.goto("/home");
  await page.getByRole("link", { name: "管理运行策略" }).click();
  await expect(page).toHaveURL(/\/profile\/run-policy$/u);

  await page.goto("/profile");
  await page.getByRole("link", { name: "管理账户运行策略" }).click();
  await expect(page).toHaveURL(/\/profile\/run-policy$/u);
  await expect(page.getByRole("heading", { name: "账户运行策略" })).toBeVisible();

  await page.getByLabel("每次运行来源数量").fill("18");
  await page.getByLabel("每次运行最多执行公开查询").fill("2");
  await page.getByLabel("每次运行最多验证候选").fill("6");
  await page.getByRole("checkbox", { name: "启用 AnySearch 公开查询" }).uncheck();
  await page.getByLabel("公开岗位发现保留岗位结果数").fill("4");
  await page.getByLabel("深度匹配最多生成推荐数").fill("7");
  await page.getByLabel("后台允许开始时间").fill("23:00");
  await page.getByLabel("后台允许结束时间").fill("02:00");

  const save = page.getByRole("button", { name: "保存运行策略" });
  const saveResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/account/run-policy" && response.request().method() === "PUT");
  if (testInfo.project.name === "Desktop Chrome") {
    await save.focus();
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    await save.tap();
  }
  expect((await saveResponse).status()).toBe(200);
  await expect(page.getByRole("status")).toHaveText("运行策略已保存。");
  await expect(page.getByText("当前修订：1", { exact: true })).toBeVisible();

  const comparison = page.locator(".run-policy-table-wrap table");
  await expect(comparison.locator("tbody tr").filter({ hasText: "每次运行来源数量" }).locator("td")).toHaveText([
    String(initial.system.defaults.discovery.trustedSourceLimit), String(initial.system.hardLimits.discovery.trustedSourceLimit), "18", "18",
  ]);
  await expect(comparison.locator("tbody tr").filter({ hasText: "公开查询次数上限" }).locator("td")).toHaveText([
    String(initial.system.defaults.discovery.publicQueryLimit), String(initial.system.hardLimits.discovery.publicQueryLimit), "2", "2",
  ]);
  await expect(comparison.locator("tbody tr").filter({ hasText: "公开岗位发现 · 保留岗位结果数" }).locator("td")).toHaveText([
    String(initial.system.defaults.budgets.publicDiscovery.maxResults), String(initial.system.hardLimits.budgets.publicDiscovery.maxResults), "4", "4",
  ]);
  await expect(comparison.locator("tbody tr").filter({ hasText: "深度匹配 · 最多生成推荐数" }).locator("td")).toHaveText([
    String(initial.system.defaults.budgets.deepMatch.maxResults), String(initial.system.hardLimits.budgets.deepMatch.maxResults), "7", "7",
  ]);
  await expect(comparison.locator("tbody tr").filter({ hasText: "公开查询" }).filter({ hasText: "已启用" }).locator("td")).toHaveText(["已启用", "可启用", "未启用", "未启用"]);
  await expect(comparison.locator("tbody tr").filter({ hasText: "后台运行时间" }).locator("td")).toHaveText(["08:00–22:00", "全天可用", "23:00–02:00", "23:00–02:00"]);

  await page.reload();
  await expect(page.getByLabel("每次运行来源数量")).toHaveValue("18");
  await expect(page.getByLabel("公开岗位发现保留岗位结果数")).toHaveValue("4");
  await expect(page.getByLabel("深度匹配最多生成推荐数")).toHaveValue("7");
  await expect(page.getByLabel("后台允许开始时间")).toHaveValue("23:00");
  await expect(page.getByLabel("后台允许结束时间")).toHaveValue("02:00");

  await page.getByRole("button", { name: "查看修订历史" }).click();
  const history = page.getByRole("region", { name: "修订历史" });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(history.getByRole("listitem").first()).toContainText("修订 1");
  await expect(history.getByRole("listitem").nth(1)).toContainText("修订 0（账户初始基线）");

  for (const control of [save, page.getByRole("button", { name: "查看修订历史" }), page.getByLabel("每次运行来源数量")]) {
    expect(await control.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/tmp/issue49-validation-20260905/ui-policy-${testInfo.project.name === "Desktop Chrome" ? "desktop" : "mobile"}.png`, fullPage: true });
});

test("超硬上限在 API 和 BFF 返回稳定的字段错误契约", async ({ page, request }, testInfo) => {
  const session = await createSession(request, `account-run-policy-hard-limit-${testInfo.project.name}-${runSuffix}`);
  await useSession(page, session);
  const policy = await getPolicy(request, session.token);
  const maximum = policy.system.hardLimits.discovery.publicQueryLimit;
  const command = commandFor(policy, (settings) => { settings.discovery.publicQueryLimit = maximum + 1; });

  const apiResponse = await request.put(`${apiBaseUrl}/v1/account/run-policy`, {
    headers: { authorization: `Bearer ${session.token}` }, data: command,
  });
  await expectHardLimitProblem(apiResponse, maximum);

  const bffResponse = await page.request.put("/api/account/run-policy", { data: command });
  await expectHardLimitProblem(bffResponse, maximum);
});

test("账户运行策略按会话隔离，并拒绝未认证或伪造 userId 的请求", async ({ request }, testInfo) => {
  const first = await createSession(request, `account-run-policy-first-${testInfo.project.name}-${runSuffix}`);
  const second = await createSession(request, `account-run-policy-second-${testInfo.project.name}-${runSuffix}`);
  const firstInitial = await getPolicy(request, first.token);
  const secondInitial = await getPolicy(request, second.token);

  const firstSaved = await savePolicy(request, first.token, commandFor(firstInitial, (settings) => {
    settings.discovery.trustedSourceLimit = 18;
    settings.backgroundWindow = { start: "23:00", end: "02:00", timeZone: "Asia/Shanghai" };
  }));
  const secondSaved = await savePolicy(request, second.token, commandFor(secondInitial, (settings) => {
    settings.discovery.publicQueryLimit = 1;
    settings.discovery.enabledProviders = [];
  }));

  expect((await getPolicy(request, first.token)).effective).toMatchObject({ discovery: { trustedSourceLimit: 18, publicQueryLimit: firstInitial.effective.discovery.publicQueryLimit }, backgroundWindow: { start: "23:00", end: "02:00" } });
  expect((await getPolicy(request, second.token)).effective).toMatchObject({ discovery: { trustedSourceLimit: secondInitial.effective.discovery.trustedSourceLimit, publicQueryLimit: 1, enabledProviders: [] }, backgroundWindow: secondInitial.effective.backgroundWindow });
  await expect(getHistory(request, first.token)).resolves.toMatchObject({ revisions: [expect.objectContaining({ revisionNumber: firstSaved.revision.revisionNumber }), expect.objectContaining({ revisionNumber: 0 })] });
  await expect(getHistory(request, second.token)).resolves.toMatchObject({ revisions: [expect.objectContaining({ revisionNumber: secondSaved.revision.revisionNumber }), expect.objectContaining({ revisionNumber: 0 })] });

  for (const path of ["/v1/account/run-policy", "/v1/account/run-policy/history"]) {
    const response = await request.get(`${apiBaseUrl}${path}`);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
  const forged = await request.put(`${apiBaseUrl}/v1/account/run-policy`, {
    headers: { authorization: `Bearer ${first.token}` },
    data: { ...commandFor(await getPolicy(request, first.token), () => undefined), userId: second.userId },
  });
  expect(forged.status()).toBe(400);
  await expect(forged.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
});
