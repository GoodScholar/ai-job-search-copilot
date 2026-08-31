import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const scenarios = {
  "Desktop Chrome": { idempotencyKey: "10000000-0000-4000-8000-000000000131", subject: "fake-anysearch-desktop" },
  "Mobile Safari": { idempotencyKey: "10000000-0000-4000-8000-000000000132", subject: "fake-anysearch-mobile" },
} as const;

function scenarioFor(testInfo: TestInfo) { return scenarios[testInfo.project.name as keyof typeof scenarios]; }

async function configureAccount(request: APIRequestContext, scenario: { subject: string }): Promise<{ token: string; targetId: string }> {
  const session = await request.post(apiBaseUrl + "/v1/auth/dev/sessions", {
    headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject: scenario.subject + "-" + Date.now() },
  });
  expect(session.status()).toBe(201);
  const token = (await session.json() as { sessionToken: string }).sessionToken;
  const target = await request.post(apiBaseUrl + "/v1/job-targets", {
    headers: { authorization: "Bearer " + token },
    data: { priority: "primary", constraints: {
      roleFamily: "AI 应用工程师", seniority: "高级", locations: ["北京"], workModes: ["hybrid"], relocation: "conditional",
      salary: { minimum: 30_000, maximum: 45_000, period: "month", currency: "CNY" }, industries: ["AI"],
      dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
    } },
  });
  expect(target.status()).toBe(201);
  const targetId = (await target.json() as { targets: Array<{ targetId: string; priority: string }> }).targets.find((item) => item.priority === "primary")!.targetId;
  const profile = await request.post(apiBaseUrl + "/v1/profile/facts", {
    headers: { authorization: "Bearer " + token }, data: { expectedVersion: 0, factType: "skill", factValue: { name: "TypeScript" } },
  });
  expect(profile.status()).toBe(201);
  return { token, targetId };
}

async function installIdempotencyKey(page: Page, value: string): Promise<void> {
  await page.addInitScript((fixed) => {
    const original = crypto.randomUUID.bind(crypto);
    let used = false;
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => used ? original() : (used = true, fixed) });
  }, value);
}

async function readRun(page: Page, runId: string): Promise<AgentRunDetail> {
  const response = await page.request.get("/api/agent-runs/" + runId);
  expect(response.status()).toBe(200);
  return await response.json() as AgentRunDetail;
}

test("版本化 Fake AnySearch 从普通 UI 运行真实 layered public 验收链", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const scenario = scenarioFor(testInfo);
  const account = await configureAccount(request, scenario);
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/profile/targets/" + account.targetId + "/watchlist");
  await page.getByLabel("公司规范名称").fill("Fake AnySearch Fixture");
  await page.getByLabel("公开招聘入口").fill("https://boards.greenhouse.io/fake-anysearch-fixture");
  await page.getByLabel("允许域").fill("boards.greenhouse.io, boards-api.greenhouse.io");
  await expect(page.getByLabel("公司规范名称")).toHaveValue("Fake AnySearch Fixture");
  await expect(page.getByLabel("公开招聘入口")).toHaveValue("https://boards.greenhouse.io/fake-anysearch-fixture");
  await expect(page.getByLabel("允许域")).toHaveValue("boards.greenhouse.io, boards-api.greenhouse.io");
  await page.getByRole("button", { name: "保存目标公司" }).click();
  await expect(page.getByRole("status")).toHaveText("目标公司已添加。");

  await installIdempotencyKey(page, scenario.idempotencyKey);
  await page.goto("/home");
  const started = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  const start = page.getByRole("button", { name: "发现岗位" });
  if (testInfo.project.name === "Mobile Safari") await start.tap(); else await start.click();
  const runId = ((await (await started).json()) as { runId: string }).runId;

  await expect.poll(async () => (await readRun(page, runId)).status, { timeout: 75_000 }).toBe("completed");
  const run = await readRun(page, runId);
  expect(run.executionSpec).toMatchObject({ workflowVersion: "layered-public-job-discovery-v1", adapter: "layered_public" });
  expect("publicDiscovery" in run.executionSpec.sourceScope ? run.executionSpec.sourceScope.publicDiscovery.queries.map((query) => query.kind) : []).toEqual(expect.arrayContaining(["general", "site_constrained", "target_company"]));
  expect(run.termination?.kind).toBe("completed_with_source_issues");
  expect(run.results).toHaveLength(1);
});
