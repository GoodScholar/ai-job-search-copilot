import AxeBuilder from "@axe-core/playwright";
import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";

const scenarios = {
  "Desktop Chrome": { idempotencyKey: "10000000-0000-4000-8000-000000000121", healthyBoard: "e2e-health-desktop-good", limitedBoard: "e2e-health-desktop-limited" },
  "Mobile Safari": { idempotencyKey: "10000000-0000-4000-8000-000000000122", healthyBoard: "e2e-health-mobile-good", limitedBoard: "e2e-health-mobile-limited" },
} as const;

function scenarioFor(testInfo: TestInfo) { return scenarios[testInfo.project.name as keyof typeof scenarios]; }

async function installFirstRandomUuid(page: Page, value: string): Promise<void> {
  await page.addInitScript((fixed) => {
    const original = crypto.randomUUID.bind(crypto); let used = false;
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => used ? original() : (used = true, fixed) });
  }, value);
}

async function configureTarget(page: Page, request: APIRequestContext, subject: string): Promise<string> {
  const sessionResponse = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject },
  });
  expect(sessionResponse.status()).toBe(201);
  const token = (await sessionResponse.json() as { sessionToken: string }).sessionToken;
  const targetResponse = await request.post(`${apiBaseUrl}/v1/job-targets`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      priority: "primary",
      constraints: {
        roleFamily: "Engineer", seniority: "中级", locations: ["北京"], workModes: ["hybrid"], relocation: "conditional",
        salary: { minimum: 20_000, maximum: 30_000, period: "month", currency: "CNY" }, industries: [],
        dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
      },
    },
  });
  expect(targetResponse.status()).toBe(201);
  const targetId = ((await targetResponse.json()) as { targets: Array<{ targetId: string; priority: string }> }).targets.find((target) => target.priority === "primary")!.targetId;
  await page.context().addCookies([{ name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  return targetId;
}

async function addSource(page: Page, name: string, board: string): Promise<void> {
  const companyName = page.getByLabel("公司规范名称");
  await companyName.click();
  await companyName.fill(name);
  await expect(companyName).toHaveValue(name);
  const careersUrl = page.getByLabel("公开招聘入口");
  await careersUrl.fill(`https://boards.greenhouse.io/${board}`);
  await expect(careersUrl).toHaveValue(`https://boards.greenhouse.io/${board}`);
  const allowedDomains = page.getByLabel("允许域");
  await allowedDomains.fill("boards.greenhouse.io, boards-api.greenhouse.io");
  await expect(allowedDomains).toHaveValue("boards.greenhouse.io, boards-api.greenhouse.io");
  await page.getByRole("button", { name: "保存目标公司" }).click();
  await expect(page.getByRole("status")).toContainText("目标公司已添加。");
}

async function getRun(page: Page, runId: string): Promise<AgentRunDetail> {
  const response = await page.request.get(`/api/agent-runs/${runId}`);
  expect(response.status()).toBe(200);
  return await response.json() as AgentRunDetail;
}

async function getOpenInbox(page: Page): Promise<AgentInboxItem[]> {
  const response = await page.request.get("/api/agent-inbox?status=open");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: AgentInboxItem[] }).items;
}

test("两来源 Fake 运行保留成功岗位、展示局部诊断并可停用失败来源", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const scenario = scenarioFor(testInfo);
  const publicRequests: string[] = [];
  page.on("request", (request) => { if (/^(?:boards|job-boards|boards-api)\.greenhouse\.io$/u.test(new URL(request.url()).hostname)) publicRequests.push(request.url()); });
  const targetId = await configureTarget(page, request, `source-health-${testInfo.project.name}-${Date.now()}`);
  await page.goto(`/profile/targets/${targetId}/watchlist`);
  await addSource(page, "健康来源", scenario.healthyBoard);
  await addSource(page, "受限来源", scenario.limitedBoard);
  await installFirstRandomUuid(page, scenario.idempotencyKey);
  await page.goto("/home");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  const start = page.getByRole("button", { name: "发现岗位" });
  if (testInfo.project.name === "Mobile Safari") await start.tap(); else await start.click();
  const runId = ((await (await responsePromise).json()) as { runId: string }).runId;
  await expect.poll(async () => {
    const run = await getRun(page, runId);
    return `${run.status}:${run.termination?.kind}`;
  }, { timeout: 45_000 }).toBe("completed:completed_with_source_issues");
  await page.reload();
  const run = await getRun(page, runId);
  expect(run.executionSpec).toMatchObject({ workflowVersion: "job-discovery-workflow-v3", adapter: "greenhouse", adapterVersion: "greenhouse-job-board-v2" });
  expect(run.results).toHaveLength(1);
  expect(run.results[0]).toMatchObject({ title: "Engineer", sourceType: "company_careers" });
  const checks = "sourceChecks" in run ? run.sourceChecks : [];
  expect(checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceId: `greenhouse:${scenario.healthyBoard}`, status: "healthy", reasonCodes: [], impact: { scope: "none", affectedCount: null } }),
    expect.objectContaining({ sourceId: `greenhouse:${scenario.limitedBoard}`, status: "rate_limited", reasonCodes: ["SOURCE_RATE_LIMITED"], impact: { scope: "entire_source", affectedCount: null } }),
  ]));
  expect(await getOpenInbox(page)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      runId,
      kind: "source_attention",
      reasonCode: "SOURCE_HEALTH_ATTENTION",
      targetHref: `/profile/targets/${targetId}/watchlist#source-health`,
    }),
  ]));
  await expect(page.locator(".agent-run-panel [role=status]")).toContainText("岗位发现部分完成");
  await expect(page.locator(".agent-run-results")).toContainText("Engineer");
  const attention = page.locator(".agent-inbox-panel").getByRole("link", { name: "查看来源诊断" });
  await expect(attention).toHaveAttribute("href", `/profile/targets/${targetId}/watchlist#source-health`);
  if (testInfo.project.name === "Desktop Chrome") { await attention.focus(); await expect(attention).toBeFocused(); await page.keyboard.press("Enter"); } else await attention.tap();
  await expect(page).toHaveURL(new RegExp(`/profile/targets/${targetId}/watchlist#source-health$`));
  const healthy = page.getByRole("article", { name: "健康来源 来源诊断" });
  const limited = page.getByRole("article", { name: "受限来源 来源诊断" });
  await expect(healthy).toContainText("状态：健康"); await expect(healthy).toContainText("最后检查："); await expect(healthy).toContainText("影响范围：无"); await expect(healthy).toContainText("建议动作：无需处理");
  await expect(limited).toContainText("状态：访问受限"); await expect(limited).toContainText("最后检查："); await expect(limited).toContainText("影响范围：整个来源"); await expect(limited).toContainText("建议动作：稍后重试");
  const disable = page.getByRole("button", { name: "停用 受限来源" });
  expect(await disable.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  if (testInfo.project.name === "Desktop Chrome") { await disable.focus(); await page.keyboard.press("Enter"); } else await disable.tap();
  await expect(limited).toContainText("状态：已停用");
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  expect(publicRequests).toEqual([]);
});
