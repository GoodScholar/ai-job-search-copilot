import AxeBuilder from "@axe-core/playwright";
import { Client } from "pg";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";
const secret = "issue-2-e2e-dev-auth-shared-secret";
const scenarios = {
  "Desktop Chrome": { batchKey: "10000000-0000-4000-8000-000000000141", subject: "recommendations-desktop" },
  "Mobile Safari": { batchKey: "10000000-0000-4000-8000-000000000142", subject: "recommendations-mobile" },
} as const;

type Account = { token: string; userId: string; targetId: string };
type ImportedOpportunity = { opportunityId: string };

function scenarioFor(info: TestInfo) { return scenarios[info.project.name as keyof typeof scenarios]; }

async function createAccount(request: APIRequestContext, info: TestInfo): Promise<Account> {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject: `${scenarioFor(info).subject}-${Date.now()}` } });
  expect(session.status()).toBe(201);
  const body = await session.json() as { sessionToken: string; account: { userId: string } };
  const facts = [
    { factType: "education", factValue: { summary: "本科" } }, { factType: "language", factValue: { name: "英语", level: "C1" } },
    { factType: "work_eligibility", factValue: { summary: "中国工作许可" } }, { factType: "skill", factValue: { name: "TypeScript" } },
    { factType: "experience", factValue: { summary: "前端工程实践经验" } }, { factType: "project", factValue: { summary: "可验证的交付项目" } },
  ];
  for (const [expectedVersion, fact] of facts.entries()) {
    const response = await request.post(`${apiBaseUrl}/v1/profile/facts`, { headers: { authorization: `Bearer ${body.sessionToken}` }, data: { expectedVersion, ...fact } });
    expect(response.status()).toBe(201);
  }
  const target = await request.post(`${apiBaseUrl}/v1/job-targets`, { headers: { authorization: `Bearer ${body.sessionToken}` }, data: { priority: "primary", constraints: {
    roleFamily: "frontend", seniority: null, locations: ["上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [],
    dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
  } } });
  expect(target.status()).toBe(201);
  const targetId = (await target.json() as { targets: Array<{ targetId: string; priority: string }> }).targets.find((item) => item.priority === "primary")!.targetId;
  return { token: body.sessionToken, userId: body.account.userId, targetId };
}

async function importAndTriage(request: APIRequestContext, account: Account, title: string): Promise<ImportedOpportunity> {
  const content = [`# ${title}`, "公司：真实 Fake 推荐夹具", "地点：上海", "截止日期：2027-09-12T00:00:00.000Z", "工作方式：远程", "是否需要搬迁：否", "学历：本科", "语言：英语(C1)", "工作资格：中国工作许可", "必备技能：TypeScript"].join("\n");
  const created = await request.post(`${apiBaseUrl}/v1/job-imports`, { headers: { authorization: `Bearer ${account.token}` }, data: { inputType: "pasted_text", content } });
  expect(created.status()).toBe(202);
  const { importId } = await created.json() as { importId: string };
  let opportunity: ImportedOpportunity | null = null;
  await expect.poll(async () => {
    const detail = await request.get(`${apiBaseUrl}/v1/job-imports/${importId}`, { headers: { authorization: `Bearer ${account.token}` } });
    expect(detail.status()).toBe(200);
    const body = await detail.json() as { status: string; opportunity: ImportedOpportunity | null };
    opportunity = body.opportunity;
    return body.status;
  }, { timeout: 20_000 }).toBe("completed");
  expect(opportunity).not.toBeNull();
  const triage = await request.post(`${apiBaseUrl}/v1/job-opportunities/${opportunity!.opportunityId}/triage-versions`, { headers: { authorization: `Bearer ${account.token}` }, data: { targetId: account.targetId } });
  expect(triage.status()).toBe(201);
  await expect(triage.json()).resolves.toMatchObject({ overallVerdict: "pass" });
  return opportunity!;
}

async function runDiscovery(request: APIRequestContext, account: Account, idempotencyKey: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/agent-runs`, { headers: { authorization: `Bearer ${account.token}` }, data: { targetId: account.targetId, idempotencyKey } });
  expect(response.status()).toBe(201);
  return (await response.json() as { runId: string }).runId;
}

async function installMatchingFixture(userId: string, targetId: string, fixture: { qualityInsufficientOpportunityIds?: string[]; overallScoresByOpportunityId?: Record<string, number> }) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const fixtureJson = JSON.stringify(fixture).replaceAll("'", "''");
    await client.query(`create or replace function e2e_deep_match_fixture() returns trigger language plpgsql as $$
      begin
        if new.user_id = '${userId}'::uuid and new.target_id = '${targetId}'::uuid and new.workflow_version = 'deep-match-v1' then
          update agent_runs set source_scope = jsonb_set(new.source_scope, '{testFixture}', '${fixtureJson}'::jsonb) where id = new.id;
        end if;
        return new;
      end;
    $$; create trigger e2e_deep_match_fixture_trigger after insert on agent_runs for each row execute function e2e_deep_match_fixture();`);
  } finally { await client.end(); }
}

async function removeQualityFixture() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { await client.query("drop trigger if exists e2e_deep_match_fixture_trigger on agent_runs; drop function if exists e2e_deep_match_fixture()"); } finally { await client.end(); }
}

async function automaticMatchRun(userId: string, discoveryRunId: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let runId: string | undefined;
    await expect.poll(async () => {
      const result = await client.query("select id from agent_runs where user_id = $1 and workflow_version = 'deep-match-v1' and source_scope ->> 'discoveryRunId' = $2 order by created_at desc limit 1", [userId, discoveryRunId]);
      runId = result.rows[0]?.id as string | undefined;
      return runId ?? null;
    }, { timeout: 30_000 }).not.toBeNull();
    return runId!;
  } finally { await client.end(); }
}

async function waitForRun(page: Page, runId: string): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/agent-runs/${runId}`);
    return response.ok() ? (await response.json() as { status: string }).status : "unavailable";
  }, { timeout: 30_000 }).toBe("completed");
}

async function matchSnapshot(userId: string, targetId: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query("select opportunity_id, sequence from job_match_versions where user_id = $1 and target_id = $2 order by opportunity_id, sequence", [userId, targetId]);
    return result.rows.map((row) => ({ opportunityId: row.opportunity_id as string, sequence: Number(row.sequence) }));
  } finally { await client.end(); }
}

async function listSnapshot(userId: string, targetId: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query("select id, sequence from recommendation_lists where user_id = $1 and target_id = $2 order by sequence", [userId, targetId]);
    return result.rows.map((row) => ({ id: row.id as string, sequence: Number(row.sequence) }));
  } finally { await client.end(); }
}

async function setCoarseScores(userId: string, targetId: string, opportunities: ImportedOpportunity[]) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const [index, opportunity] of opportunities.entries()) {
      await client.query("update job_triage_versions set overall_score = $1 where user_id = $2 and target_id = $3 and opportunity_id = $4", [100 - index, userId, targetId, opportunity.opportunityId]);
    }
  } finally { await client.end(); }
}

test("显式 Fake matching 真实链路交付双方证据、质量排除与单岗位重评历史", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const account = await createAccount(request, info);
  const recommended = await importAndTriage(request, account, "正式推荐 TypeScript 工程师");
  const excluded = await importAndTriage(request, account, "低质量专用夹具岗位");
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await installMatchingFixture(account.userId, account.targetId, { qualityInsufficientOpportunityIds: [excluded.opportunityId] });
  const discoveryRunId = await runDiscovery(request, account, scenarioFor(info).batchKey);
  await page.goto("/recommendations");
  await waitForRun(page, discoveryRunId);
  const initialRunId = await automaticMatchRun(account.userId, discoveryRunId);
  await waitForRun(page, initialRunId);
  await removeQualityFixture();
  await page.reload();
  await expect(page.getByRole("heading", { name: "推荐清单" })).toBeVisible();
  await expect(page.getByRole("list", { name: "推荐岗位" })).toContainText("正式推荐 TypeScript 工程师");
  await expect(page.getByText("稳定排除 1 项岗位：MATCH_QUALITY_INSUFFICIENT")).toBeVisible();
  await page.getByText("查看证据与判断").click();
  await expect(page.getByRole("list", { name: "推荐岗位" }).getByText(/^岗位证据：/u)).toContainText("正式推荐 TypeScript 工程师");
  await expect(page.getByRole("list", { name: "推荐岗位" }).getByText(/^画像证据：/u)).toContainText("已确认的岗位方向：frontend");
  await expect(page.getByText(/证据支持的推断|证据不足/u)).toHaveCount(6);
  await expect(page.locator("main")).not.toContainText(/(?:评分|score|\d+%)/i);
  const before = await matchSnapshot(account.userId, account.targetId);
  const listsBefore = await listSnapshot(account.userId, account.targetId);
  const reevaluate = page.getByRole("button", { name: "重新评估此岗位" });
  if (info.project.name === "Desktop Chrome") { await reevaluate.focus(); await expect(reevaluate).toBeFocused(); await page.keyboard.press("Enter"); } else await reevaluate.tap();
  await expect.poll(async () => (await matchSnapshot(account.userId, account.targetId)).filter((match) => match.opportunityId === recommended.opportunityId).length, { timeout: 30_000 }).toBe(2);
  const after = await matchSnapshot(account.userId, account.targetId);
  expect(after.filter((match) => match.opportunityId !== recommended.opportunityId)).toEqual(before.filter((match) => match.opportunityId !== recommended.opportunityId));
  const listsAfter = await listSnapshot(account.userId, account.targetId);
  expect(listsAfter.slice(0, listsBefore.length)).toEqual(listsBefore);
  expect(listsAfter).toHaveLength(listsBefore.length + 1);
  await page.reload();
  await expect(page.getByText("历史版本")).toBeVisible();
  await page.getByText("历史版本", { exact: true }).click();
  await page.locator("summary").filter({ hasText: "清单版本 1" }).click();
  const historicalVersion = page.locator("summary").filter({ hasText: "清单版本 1" }).locator("..");
  await expect(historicalVersion.locator("p").filter({ hasText: "岗位证据：" })).toContainText("正式推荐 TypeScript 工程师");
  await expect(historicalVersion.locator("p").filter({ hasText: "画像证据：" })).toContainText("已确认的岗位方向：frontend");
  const controls = page.locator(".workbench-touch-target");
  expect(await controls.evaluateAll((items) => items.every((item) => item.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("显式 Fake matching 的质量不足候选可生成零推荐清单", async ({ page, request }, info) => {
  test.setTimeout(60_000);
  const account = await createAccount(request, info);
  const excluded = await importAndTriage(request, account, "零推荐专用夹具岗位");
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await installMatchingFixture(account.userId, account.targetId, { qualityInsufficientOpportunityIds: [excluded.opportunityId] });
  const discoveryRunId = await runDiscovery(request, account, crypto.randomUUID());
  await page.goto("/recommendations");
  await waitForRun(page, discoveryRunId);
  const runId = await automaticMatchRun(account.userId, discoveryRunId);
  await waitForRun(page, runId);
  await removeQualityFixture();
  await page.reload();
  await expect(page.getByText("稳定排除 1 项岗位：MATCH_QUALITY_INSUFFICIENT")).toBeVisible();
  await expect(page.getByRole("list", { name: "推荐岗位" }).locator("li")).toHaveCount(0);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("真实 discovery 自动 child 以深评稳定重排十项并标出正确 Top3 与 matching 面板", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const account = await createAccount(request, info);
  const opportunities: ImportedOpportunity[] = [];
  for (let index = 0; index < 10; index += 1) opportunities.push(await importAndTriage(request, account, `深评排序候选 ${String(index + 1).padStart(2, "0")}`));
  await setCoarseScores(account.userId, account.targetId, opportunities);
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await installMatchingFixture(account.userId, account.targetId, { overallScoresByOpportunityId: Object.fromEntries(opportunities.map((opportunity, index) => [opportunity.opportunityId, 81 + index])) });
  const discoveryRunId = await runDiscovery(request, account, crypto.randomUUID());
  await page.goto("/recommendations");
  await waitForRun(page, discoveryRunId);
  const runId = await automaticMatchRun(account.userId, discoveryRunId);
  await waitForRun(page, runId);
  await removeQualityFixture();

  await page.goto(`/home?runId=${runId}#agent-run`);
  await expect(page.getByRole("heading", { name: "评估候选岗位匹配" })).toBeVisible();
  await expect(page.getByLabel("用于岗位匹配的求职目标")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("已生成 10 项推荐");
  await expect(page.getByRole("list", { name: "岗位匹配运行时间线" })).toContainText("岗位匹配完成");

  await page.goto("/recommendations");
  const recommendations = page.getByRole("list", { name: "推荐岗位" });
  await expect(recommendations.locator(":scope > li")).toHaveCount(10);
  const titles = await recommendations.locator("h2").allTextContents();
  expect(titles).toEqual(Array.from({ length: 10 }, (_, index) => `深评排序候选 ${String(10 - index).padStart(2, "0")}`));
  await expect(page.getByText("今日优先处理")).toHaveCount(3);
  expect((await recommendations.locator(":scope > li").evaluateAll((items) => items.slice(0, 3).every((item) => item.textContent?.includes("今日优先处理")))).valueOf()).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
});
