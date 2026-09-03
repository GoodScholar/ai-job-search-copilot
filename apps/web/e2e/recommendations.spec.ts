import AxeBuilder from "@axe-core/playwright";
import { Client } from "pg";
import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from "@playwright/test";

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
  const content = [`# ${title}`, "公司：真实 Fake 推荐夹具", "地点：上海", "截止日期：2027-09-12T00:00:00.000Z", "工作方式：远程", "是否需要搬迁：否", "薪资：CNY 30000-45000/month", "学历：本科", "语言：英语(C1)", "工作资格：中国工作许可", "行业：人工智能", "雇佣类型：直接雇佣", "必备技能：TypeScript"].join("\n");
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

async function tabTo(page: Page, locator: Locator) {
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => document.activeElement === element)) return;
  }
  throw new Error("KEYBOARD_TARGET_NOT_REACHABLE");
}

async function expectVisibleKeyboardFocus(locator: Locator) {
  await expect(locator).toBeFocused();
  await expect(locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const visibleOutline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0 && style.outlineColor !== "transparent";
    const visibleShadow = style.boxShadow !== "none" && style.boxShadow !== "transparent";
    return visibleOutline || visibleShadow;
  })).resolves.toBe(true);
}

async function ignoreRecommendation(page: Page, title: string, reason: "薪资" | "地点", info: TestInfo) {
  const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
  const summary = card.locator("summary").filter({ hasText: "忽略此推荐" });
  if (info.project.name === "Desktop Chrome") await summary.click(); else await summary.tap({ force: true });
  await card.getByRole("radio", { name: reason }).check();
  const confirm = card.getByRole("button", { name: "确认忽略" });
  if (info.project.name === "Desktop Chrome") await confirm.click(); else await confirm.tap({ force: true });
  await expect(card.getByText("当前推荐决策：", { exact: false })).toContainText("已忽略");
}

async function seedPaginatedRecommendationFixtures(userId: string, targetId: string, latestListId: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`insert into recommendation_lists (id, user_id, target_id, local_date, sequence, created_at)
      select gen_random_uuid(), $1, $2, to_char(date '2026-08-01' - item, 'YYYY-MM-DD'), 1, now() - (item * interval '1 day')
      from generate_series(1, 21) as item`, [userId, targetId]);
    await client.query(`with source as (
        select source_posting_version_id, company, location, normalized_data from job_opportunities where user_id = $1 limit 1
      ), opportunities as (
        insert into job_opportunities (id, user_id, import_id, source_posting_version_id, canonical_opportunity_id, dedup_key, company, title, location, posted_at, deadline, description, normalized_data, availability, availability_updated_at, created_at, updated_at)
        select gen_random_uuid(), $1, null, source.source_posting_version_id, null, repeat(md5(item::text), 2), source.company, '分页排除夹具 ' || item, source.location, null, null, null, source.normalized_data, 'open', now(), now(), now()
        from source cross join generate_series(1, 26) as item
        returning id
      )
      insert into recommendation_exclusions (id, user_id, target_id, opportunity_id, recommendation_list_id, reason_code, created_at)
      select gen_random_uuid(), $1, $2, id, $3, 'MATCH_QUALITY_INSUFFICIENT', now() from opportunities`, [userId, targetId, latestListId]);
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
  await expect(page.getByText("稳定排除 1 项岗位：匹配证据不足")).toBeVisible();
  await page.getByText("查看证据与判断").click();
  await expect(page.getByRole("list", { name: "推荐岗位" }).getByText(/^岗位证据：/u)).toContainText("行业：人工智能");
  await expect(page.getByRole("list", { name: "推荐岗位" }).getByText(/^画像证据：/u)).toContainText("已确认的岗位方向：frontend");
  await expect(page.getByRole("list", { name: "推荐岗位" }).locator("details > p > strong")).toHaveCount(6);
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
  const keyAfterFirstSuccess = await reevaluate.evaluate((button) => (button.closest("form")?.elements.namedItem("idempotencyKey") as HTMLInputElement).value);
  if (info.project.name === "Desktop Chrome") { await reevaluate.focus(); await page.keyboard.press("Enter"); } else await reevaluate.tap();
  await expect.poll(async () => (await matchSnapshot(account.userId, account.targetId)).filter((match) => match.opportunityId === recommended.opportunityId).length, { timeout: 30_000 }).toBe(3);
  const keyAfterSecondSuccess = await reevaluate.evaluate((button) => (button.closest("form")?.elements.namedItem("idempotencyKey") as HTMLInputElement).value);
  expect(keyAfterSecondSuccess).not.toBe(keyAfterFirstSuccess);
  const listsAfterSecondSuccess = await listSnapshot(account.userId, account.targetId);
  expect(listsAfterSecondSuccess).toHaveLength(listsBefore.length + 2);
  await seedPaginatedRecommendationFixtures(account.userId, account.targetId, listsAfterSecondSuccess.at(-1)!.id);
  await page.reload();
  await expect(page.getByText(/稳定排除 25 项岗位/u)).toBeVisible();
  const loadLatestExclusions = page.getByRole("button", { name: "加载更多稳定排除" }).first();
  const exclusionResponse = page.waitForResponse((response) => response.url().includes("/api/recommendations/lists/") && response.url().includes("/exclusions?") && response.status() === 200);
  if (info.project.name === "Desktop Chrome") await loadLatestExclusions.click(); else await loadLatestExclusions.tap();
  const exclusionsPage = await (await exclusionResponse).json() as { items: unknown[]; nextCursor: string | null };
  expect(exclusionsPage.items).toHaveLength(1);
  expect(exclusionsPage.nextCursor).toBeNull();
  await expect(page.getByText(/稳定排除 26 项岗位/u)).toBeVisible();
  await expect(page.getByText("历史版本", { exact: true })).toBeVisible();
  await page.getByText("历史版本", { exact: true }).click();
  const loadHistory = page.getByRole("button", { name: "加载更多历史版本" });
  if (info.project.name === "Desktop Chrome") await loadHistory.click(); else await loadHistory.tap();
  await expect.poll(() => page.locator("summary").filter({ hasText: "清单版本" }).count()).toBeGreaterThan(20);
  const historicalSummary = page.locator("summary").filter({ hasText: "清单版本 1" }).first();
  await historicalSummary.focus();
  await expect(historicalSummary).toBeFocused();
  await page.keyboard.press("Enter");
  const historicalVersion = historicalSummary.locator("..");
  await expect(historicalVersion.locator("p").filter({ hasText: "岗位证据：" })).toContainText("行业：人工智能");
  await expect(historicalVersion.locator("p").filter({ hasText: "画像证据：" })).toContainText("已确认的岗位方向：frontend");
  await expect(historicalVersion).toContainText(/高度匹配|值得尝试|谨慎考虑/u);
  for (const label of ["技能", "经验", "项目深度", "岗位方向", "地点与工作方式", "资格风险"]) await expect(historicalVersion.getByText(label, { exact: true }).first()).toBeVisible();
  const controls = page.locator("main .workbench-touch-target");
  expect(await controls.evaluateAll((items) => items.every((item) => Number.parseFloat(getComputedStyle(item).minHeight) >= 44))).toBe(true);
  const keyboardLink = page.locator("a[href='/home']").first();
  await keyboardLink.focus();
  await expectVisibleKeyboardFocus(keyboardLink);
  const keyboardSummary = page.getByText("查看证据与判断", { exact: true });
  await tabTo(page, keyboardSummary);
  await expectVisibleKeyboardFocus(keyboardSummary);
  await page.keyboard.press("Enter");
  await expect(keyboardSummary.locator("xpath=.." )).toHaveAttribute("open", "");
  const keyboardButton = page.getByRole("button", { name: "查看稳定排除" }).first();
  await keyboardButton.focus();
  await expectVisibleKeyboardFocus(keyboardButton);
  await page.keyboard.press("Enter");
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("推荐决策与拒绝校准建议保持规则和目标不变", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const account = await createAccount(request, info);
  await Promise.all(["反馈岗位一", "反馈岗位二", "反馈岗位三", "反馈岗位四", "反馈岗位五"].map((title) => importAndTriage(request, account, title)));
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  const discoveryRunId = await runDiscovery(request, account, info.project.name === "Desktop Chrome" ? "10000000-0000-4000-8000-000000000241" : "10000000-0000-4000-8000-000000000242");
  await page.goto("/recommendations"); await waitForRun(page, discoveryRunId);
  const matching = await automaticMatchRun(account.userId, discoveryRunId); await waitForRun(page, matching);
  await page.reload();
  const latest = await request.get(`${apiBaseUrl}/v1/recommendations/latest?targetId=${account.targetId}`, { headers: { authorization: `Bearer ${account.token}` } });
  expect(latest.status()).toBe(200);
  const list = await latest.json() as { recommendationListId: string; items: Array<{ recommendationListItemId: string; decision: { status: "pending" | "saved" | "ignored"; version: number } }> };
  expect(list.items).toHaveLength(5);
  const saved = page.getByRole("button", { name: "收藏" }).first();
  if (info.project.name === "Desktop Chrome") { await saved.focus(); await page.keyboard.press("Enter"); } else await saved.tap();
  await expect(page.getByText("当前推荐决策：", { exact: false }).first()).toContainText("已收藏");
  const ignoredCard = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "反馈岗位二" }) });
  const ignoreWithoutReason = ignoredCard.locator("summary").filter({ hasText: "忽略此推荐" });
  await ignoreWithoutReason.scrollIntoViewIfNeeded();
  if (info.project.name === "Desktop Chrome") await ignoreWithoutReason.click(); else await ignoreWithoutReason.tap({ force: true });
  const confirmIgnore = ignoredCard.getByRole("button", { name: "确认忽略" });
  if (info.project.name === "Desktop Chrome") await confirmIgnore.click(); else await confirmIgnore.tap({ force: true });
  await expect(ignoredCard.getByText("当前推荐决策：", { exact: false })).toContainText("已忽略");
  const before = await (async () => { const client = new Client({ connectionString: databaseUrl }); await client.connect(); try { return (await client.query("select version from job_targets where id = $1", [account.targetId])).rows[0]!.version as number; } finally { await client.end(); } })();
  for (const title of ["反馈岗位三", "反馈岗位四", "反馈岗位五"]) {
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
    const summary = card.locator("summary").filter({ hasText: "忽略此推荐" });
    if (info.project.name === "Desktop Chrome") await summary.click(); else await summary.tap({ force: true });
    await card.getByRole("radio", { name: "地点" }).check();
    const button = card.getByRole("button", { name: "确认忽略" });
    if (info.project.name === "Desktop Chrome") await button.click(); else await button.tap({ force: true });
    await expect(card.getByText("当前推荐决策：", { exact: false })).toContainText("已忽略");
  }
  await expect(page.getByRole("heading", { name: "校准建议" })).toBeVisible();
  await expect(page.getByText(/因“地点或工作方式不合适”产生的建议/u)).toBeVisible();
  const proposalBefore = await (async () => { const client = new Client({ connectionString: databaseUrl }); await client.connect(); try { return (await client.query("select id, status, version from calibration_proposals where user_id = $1 order by created_at desc limit 1", [account.userId])).rows[0] as { id: string; status: string; version: number }; } finally { await client.end(); } })();
  expect(proposalBefore.status).toBe("pending");
  const revise = page.getByRole("button", { name: "修改建议" });
  if (info.project.name === "Desktop Chrome") await revise.click(); else await revise.tap();
  await expect.poll(async () => { const client = new Client({ connectionString: databaseUrl }); await client.connect(); try { return (await client.query("select status, version from calibration_proposals where id = $1", [proposalBefore.id])).rows[0]; } finally { await client.end(); } }).toMatchObject({ status: "pending", version: proposalBefore.version + 1 });
  if (info.project.name === "Desktop Chrome") await revise.click(); else await revise.tap();
  await expect.poll(async () => { const client = new Client({ connectionString: databaseUrl }); await client.connect(); try { return (await client.query("select status, version from calibration_proposals where id = $1", [proposalBefore.id])).rows[0]; } finally { await client.end(); } }).toMatchObject({ status: "pending", version: proposalBefore.version + 2 });
  const reject = page.getByRole("button", { name: "拒绝建议" });
  if (info.project.name === "Desktop Chrome") { await reject.focus(); await page.keyboard.press("Enter"); } else await reject.tap();
  await expect.poll(async () => { const client = new Client({ connectionString: databaseUrl }); await client.connect(); try { return (await client.query("select status, version, resolution_idempotency_key from calibration_proposals where id = $1", [proposalBefore.id])).rows[0]; } finally { await client.end(); } }).toMatchObject({ status: "rejected", version: proposalBefore.version + 3, resolution_idempotency_key: expect.any(String) });
  await expect.poll(async () => { const client = new Client({ connectionString: databaseUrl }); await client.connect(); try { const result = await client.query("select (select count(*) from recommendation_rule_versions where user_id = $1) as rules, (select version from job_targets where id = $2) as target_version", [account.userId, account.targetId]); return result.rows[0]; } finally { await client.end(); } }).toEqual({ rules: "0", target_version: before });
  const controls = page.locator("main .workbench-touch-target");
  expect(await controls.evaluateAll((items) => items.every((item) => Number.parseFloat(getComputedStyle(item).minHeight) >= 44))).toBe(true);
  await new AxeBuilder({ page }).analyze().then((result) => expect(result.violations).toEqual([]));
});

test("交错批准后立即锁定过期建议，刷新读模型并重新计算后可批准", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const account = await createAccount(request, info);
  await Promise.all(["薪酬反馈一", "薪酬反馈二", "薪酬反馈三", "地点反馈一", "地点反馈二", "地点反馈三"].map((title) => importAndTriage(request, account, title)));
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  const discoveryRunId = await runDiscovery(request, account, info.project.name === "Desktop Chrome" ? "10000000-0000-4000-8000-000000000341" : "10000000-0000-4000-8000-000000000342");
  await page.goto("/recommendations"); await waitForRun(page, discoveryRunId);
  await waitForRun(page, await automaticMatchRun(account.userId, discoveryRunId));
  await page.reload();
  for (const title of ["薪酬反馈一", "薪酬反馈二", "薪酬反馈三"]) await ignoreRecommendation(page, title, "薪资", info);
  for (const title of ["地点反馈一", "地点反馈二", "地点反馈三"]) await ignoreRecommendation(page, title, "地点", info);
  await expect(page.getByRole("heading", { name: "校准建议" })).toBeVisible();
  const beforeRace = await request.get(`${apiBaseUrl}/v1/recommendations/calibration-proposals?targetId=${account.targetId}`, { headers: { authorization: `Bearer ${account.token}` } });
  expect(beforeRace.status()).toBe(200);
  const proposals = await beforeRace.json() as Array<{ proposalId: string; reason: string; version: number; stale: boolean }>;
  const p1 = proposals.find((proposal) => proposal.reason === "SALARY")!; const p2 = proposals.find((proposal) => proposal.reason === "LOCATION")!;
  expect(p2.stale).toBe(false);
  const backgroundApproval = await request.post(`${apiBaseUrl}/v1/recommendations/calibration-proposals/${p1.proposalId}/resolutions`, { headers: { authorization: `Bearer ${account.token}` }, data: { action: "approved", expectedVersion: p1.version, idempotencyKey: crypto.randomUUID() } });
  expect(backgroundApproval.status()).toBe(201);
  const locationProposal = page.locator("article").filter({ has: page.getByText("因“地点或工作方式不合适”产生的建议") });
  const approve = locationProposal.getByRole("button", { name: "批准建议" });
  if (info.project.name === "Desktop Chrome") await approve.click(); else await approve.tap();
  await expect(page.getByText("规则已更新，请先刷新后重新计算或修改建议。")).toBeVisible();
  await expect(approve).toBeDisabled();
  await expect(locationProposal.getByRole("button", { name: "重新计算" })).toBeVisible();
  const rebase = locationProposal.getByRole("button", { name: "重新计算" });
  if (info.project.name === "Desktop Chrome") await rebase.click(); else await rebase.tap();
  await expect.poll(async () => {
    const response = await request.get(`${apiBaseUrl}/v1/recommendations/calibration-proposals?targetId=${account.targetId}`, { headers: { authorization: `Bearer ${account.token}` } });
    return (await response.json() as Array<{ proposalId: string; version: number; stale: boolean }>).find((proposal) => proposal.proposalId === p2.proposalId);
  }).toMatchObject({ version: p2.version + 1, stale: false });
  await expect(approve).toBeEnabled();
  if (info.project.name === "Desktop Chrome") await approve.click(); else await approve.tap();
  await expect.poll(async () => { const client = new Client({ connectionString: databaseUrl }); await client.connect(); try { return (await client.query("select count(*) as rules from recommendation_rule_versions where user_id = $1", [account.userId])).rows[0]!.rules; } finally { await client.end(); } }).toBe("2");
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
  await expect(page.getByText("稳定排除 1 项岗位：匹配证据不足")).toBeVisible();
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
