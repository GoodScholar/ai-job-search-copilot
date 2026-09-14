import AxeBuilder from "@axe-core/playwright";
import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import { StartAgentRunResponseSchema, type AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";

const scenarios = {
  "Desktop Chrome": { idempotencyKey: "10000000-0000-4000-8000-000000000121", healthyBoard: "e2e-health-desktop-good", limitedBoard: "e2e-health-desktop-limited" },
  "Mobile Safari": { idempotencyKey: "10000000-0000-4000-8000-000000000122", healthyBoard: "e2e-health-mobile-good", limitedBoard: "e2e-health-mobile-limited" },
} as const;

function scenarioFor(testInfo: TestInfo) { return scenarios[testInfo.project.name as keyof typeof scenarios]; }

async function configureTarget(page: Page, request: APIRequestContext, subject: string): Promise<{ targetId: string; token: string }> {
  const sessionResponse = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject },
  });
  expect(sessionResponse.status()).toBe(201);
  const token = (await sessionResponse.json() as { sessionToken: string }).sessionToken;
  const factResponse = await request.post(`${apiBaseUrl}/v1/profile/facts`, {
    headers: { authorization: `Bearer ${token}` }, data: { expectedVersion: 0, factType: "skill", factValue: { name: "TypeScript" } },
  });
  expect(factResponse.status()).toBe(201);
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
  return { targetId, token };
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
  const response = await page.request.get("/api/agent-inbox?status=pending");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: AgentInboxItem[] }).items;
}

async function expectCheckedAt(article: ReturnType<Page["getByRole"]>): Promise<void> {
  const checkedAt = article.locator("p").filter({ hasText: /^最后检查：/u });
  await expect(checkedAt).toBeVisible();
  await expect(checkedAt).not.toHaveText("最后检查：尚未检查");
  await expect(checkedAt).toHaveText(/^最后检查：.*\d{4}.+$/u);
}

test("两来源 Fake 运行保留成功岗位、展示局部诊断并可停用失败来源", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const scenario = scenarioFor(testInfo);
  const publicRequests: string[] = [];
  page.on("request", (request) => { if (/^(?:boards|job-boards|boards-api)\.greenhouse\.io$/u.test(new URL(request.url()).hostname)) publicRequests.push(request.url()); });
  const account = await configureTarget(page, request, `source-health-${testInfo.project.name}-${Date.now()}`);
  const { targetId } = account;
  await page.goto(`/profile/targets/${targetId}/watchlist`);
  await addSource(page, "健康来源", scenario.healthyBoard);
  await addSource(page, "受限来源", scenario.limitedBoard);
  const diagnosticResponse = await request.post(`${apiBaseUrl}/v1/model-diagnostics`, {
    headers: { authorization: `Bearer ${account.token}` }, data: {},
  });
  expect(diagnosticResponse.status()).toBe(201);
  await expect(diagnosticResponse.json()).resolves.toMatchObject({ status: "available" });
  const preflightResponse = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${targetId}`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  expect(preflightResponse.status()).toBe(200);
  const preflight = await preflightResponse.json() as { status: string; warningFingerprint: string | null; items: Array<{ code: string; severity: string }> };
  expect(preflight.status).toBe("ready_with_warnings");
  expect(preflight.warningFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(preflight.items.filter((item) => item.severity === "blocking")).toEqual([]);
  expect(preflight.items.filter((item) => item.severity === "warning")).toEqual([expect.objectContaining({ code: "SOURCE_HEALTH_UNCHECKED" })]);
  const command = { targetId, idempotencyKey: scenario.idempotencyKey, warningFingerprint: preflight.warningFingerprint };
  const createdResponse = await page.request.post("/api/agent-runs", { data: command });
  expect(createdResponse.status()).toBe(201);
  const created = StartAgentRunResponseSchema.parse(await createdResponse.json());
  expect(created).toMatchObject({ targetId, reused: false });
  const replayResponse = await page.request.post("/api/agent-runs", { data: command });
  expect(replayResponse.status()).toBe(200);
  await expect(replayResponse.json()).resolves.toMatchObject({ runId: created.runId, targetId, reused: true });
  const runId = created.runId;
  await expect.poll(async () => {
    const run = await getRun(page, runId);
    return `${run.status}:${run.termination?.kind}`;
  }, { timeout: 45_000 }).toBe("completed:completed_with_source_issues");
  await page.goto(`/home?runId=${runId}#agent-run`);
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
      target: expect.objectContaining({ type: "job_source", targetId, href: `/profile/targets/${targetId}/watchlist#source-health` }),
    }),
  ]));
  await expect(page.locator(".agent-run-panel .agent-run-live")).toContainText("岗位发现部分完成");
  await expect(page.locator(".agent-run-results")).toContainText("Engineer");
  const attention = page
    .getByRole("article", { name: "部分来源需要关注" })
    .getByRole("link", { name: "查看相关记录" });
  await expect(attention).toHaveAttribute("href", `/profile/targets/${targetId}/watchlist#source-health`);
  if (testInfo.project.name === "Desktop Chrome") { await attention.focus(); await expect(attention).toBeFocused(); await page.keyboard.press("Enter"); } else await attention.tap();
  await expect(page).toHaveURL(new RegExp(`/profile/targets/${targetId}/watchlist#source-health$`));
  await expect(page.getByRole("heading", { name: "来源能力" })).toBeVisible();
  for (const name of ["健康来源", "受限来源"]) {
    const capabilities = page.getByRole("article", { name: `${name} 来源能力` });
    await expect(capabilities).toContainText("契约版本：source-capabilities-v1");
    await expect(capabilities).toContainText("主动发现、读取详情、持续监控、安全打开原始页面");
  }
  const healthy = page.getByRole("article", { name: "健康来源 来源诊断" });
  const limited = page.getByRole("article", { name: "受限来源 来源诊断" });
  await expect(healthy).toContainText("状态：健康"); await expectCheckedAt(healthy); await expect(healthy).toContainText("影响范围：无"); await expect(healthy).toContainText("建议动作：无需处理");
  await expect(limited).toContainText("状态：访问受限"); await expectCheckedAt(limited); await expect(limited).toContainText("影响范围：整个来源"); await expect(limited).toContainText("建议动作：稍后重试");
  const disable = page.getByRole("button", { name: "停用 受限来源" });
  expect(await disable.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  if (testInfo.project.name === "Desktop Chrome") { await disable.focus(); await page.keyboard.press("Enter"); } else await disable.tap();
  await expect(limited).toContainText("状态：已停用");
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
  expect(publicRequests).toEqual([]);
});
