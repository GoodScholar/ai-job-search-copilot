import AxeBuilder from "@axe-core/playwright";
import { Client } from "pg";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";
const devAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const resume = [
  "# 姓名：张三", "邮箱：first-journey@example.test", "## 工作经历", "- 前端工程师｜示例科技｜2024-至今", "## 技能", "- TypeScript", "## 教育经历", "- 示例大学｜计算机科学｜2020", "## 项目经历", "- 求职工作台｜构建证据驱动的求职流程", "## 语言", "- 英语：专业工作水平", "## 联系方式", "- 电话：13800000000",
].join("\n");

const runKeys = {
  "Desktop Chrome": { success: "10000000-0000-4000-8000-000000000141", failure: "10000000-0000-4000-8000-000000000104" },
  "Mobile Safari": { success: "10000000-0000-4000-8000-000000000142", failure: "10000000-0000-4000-8000-000000000114" },
} as const;

type Account = { token: string; userId: string; subject: string };
type PreparedAccount = Account & { targetId: string };

function auth(token: string) { return { authorization: `Bearer ${token}` }; }
function keyFor(info: TestInfo) { return runKeys[info.project.name as keyof typeof runKeys]; }
function subjectFor(info: TestInfo, purpose: string) { return `first-recommendation-${purpose}-${info.project.name}-${runSuffix}`; }

async function createAccount(request: APIRequestContext, subject: string): Promise<Account> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": devAuthSecret }, data: { subject },
  });
  expect(response.status()).toBe(201);
  const session = await response.json() as { sessionToken: string; account: { userId: string } };
  return { token: session.sessionToken, userId: session.account.userId, subject };
}

async function useSession(page: Page, token: string): Promise<void> {
  await page.context().addCookies([{
    name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
  }]);
}

function journey(page: Page) {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "首次推荐旅程" }) });
}

function journeyStep(page: Page, title: string) {
  return journey(page).getByRole("heading", { name: title }).locator("xpath=ancestor::li");
}

async function expectJourneyStep(page: Page, title: string, status: "completed" | "in_progress" | "needs_action" | "waiting", current = false): Promise<void> {
  const step = journeyStep(page, title);
  await expect(step).toHaveAttribute("data-status", status);
  await expect(step.getByText({ completed: "已完成", in_progress: "进行中", needs_action: "需要处理", waiting: "等待开始" }[status], { exact: true })).toBeVisible();
  if (current) await expect(step).toHaveAttribute("aria-current", "step");
}

async function expectActiveJourney(page: Page, currentTitle: string): Promise<void> {
  await expect(journey(page)).toBeVisible();
  await expect(journey(page).getByRole("list")).toBeVisible();
  await expect(journeyStep(page, currentTitle)).toHaveAttribute("aria-current", "step");
}

async function importCareerMaterial(page: Page): Promise<void> {
  await page.goto("/profile");
  await page.getByLabel("选择 Markdown、DOCX 或 PDF 职业资料").setInputFiles({
    name: "first-recommendation-career.md", mimeType: "text/markdown", buffer: Buffer.from(resume, "utf8"),
  });
  await expect(page.getByText("发现 3 项敏感信息", { exact: true })).toBeVisible();
  await page.getByLabel("保留受保护原件（下游仍只使用脱敏副本）").check();
  const upload = page.getByRole("button", { name: "上传并解析" });
  await expect(upload).toBeEnabled();
  await upload.click();
  await expect(page.getByRole("status")).toContainText(/等待解析|解析中|解析完成/u);
  await expect(page.getByRole("status")).toHaveText("解析完成", { timeout: 20_000 });
}

async function addTrustedFact(request: APIRequestContext, token: string, expectedVersion: number, factType: string, factValue: unknown): Promise<void> {
  const response = await request.post(`${apiBaseUrl}/v1/profile/facts`, {
    headers: auth(token), data: { expectedVersion, factType, factValue },
  });
  expect(response.status()).toBe(201);
}

async function createPrimaryTarget(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/job-targets`, {
    headers: auth(token), data: {
      priority: "primary",
      constraints: {
        roleFamily: "frontend", seniority: null, locations: ["上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [],
        dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
      },
    },
  });
  expect(response.status()).toBe(201);
  const overview = await response.json() as { targets: Array<{ targetId: string; priority: string }> };
  return overview.targets.find((target) => target.priority === "primary")!.targetId;
}

async function enableExecutableSource(request: APIRequestContext, token: string, targetId: string, name: string): Promise<void> {
  const response = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items`, {
    headers: auth(token), data: {
      expectedVersion: 0, canonicalCompanyName: name, careersUrl: `https://boards.greenhouse.io/${name.toLowerCase().replaceAll(" ", "-")}`,
      allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null,
    },
  });
  expect(response.status()).toBe(201);
}

async function runModelDiagnostic(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.post(`${apiBaseUrl}/v1/model-diagnostics`, { headers: auth(token), data: {} });
  expect(response.status()).toBe(201);
  await expect(response.json()).resolves.toMatchObject({ status: "available" });
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => document.activeElement === element)) return;
  }
  throw new Error("FIRST_RECOMMENDATION_JOURNEY_KEYBOARD_TARGET_UNREACHABLE");
}

async function installFirstRandomUuid(page: Page, value: string): Promise<void> {
  const install = (fixed: string) => {
    const original = crypto.randomUUID.bind(crypto);
    const marker = `job-copilot:e2e-fixed-random-uuid:${fixed}`;
    let used = sessionStorage.getItem(marker) === "used";
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => {
        if (used) return original();
        used = true;
        sessionStorage.setItem(marker, "used");
        return fixed;
      },
    });
  };
  await page.addInitScript(install, value);
  await page.evaluate(install, value);
}

async function activate(page: Page, target: Locator, info: TestInfo): Promise<void> {
  if (info.project.name === "Desktop Chrome") {
    await tabTo(page, target);
    await expect(target).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    await target.tap();
  }
}

async function assertJourneyAccessibility(page: Page): Promise<void> {
  const panel = journey(page);
  const targets = panel.locator("a[href], button");
  expect(await targets.count()).toBeGreaterThan(0);
  expect(await targets.evaluateAll((nodes) => nodes.every((node) => node.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function prepareMatchingAccount(request: APIRequestContext, info: TestInfo, purpose: string): Promise<PreparedAccount> {
  const account = await createAccount(request, subjectFor(info, purpose));
  const facts = [
    ["education", { summary: "本科" }], ["language", { name: "英语", level: "C1" }], ["work_eligibility", { summary: "中国工作许可" }],
    ["skill", { name: "TypeScript" }], ["experience", { summary: "前端工程实践经验" }], ["project", { summary: "可验证的交付项目" }],
  ] as const;
  for (const [version, [factType, factValue]] of facts.entries()) await addTrustedFact(request, account.token, version, factType, factValue);
  const targetId = await createPrimaryTarget(request, account.token);
  await enableExecutableSource(request, account.token, targetId, `First Journey ${purpose} Fixture`);
  await runModelDiagnostic(request, account.token);
  return { ...account, targetId };
}

async function importAndPassGate(request: APIRequestContext, account: PreparedAccount, title: string): Promise<string> {
  const content = [
    `# ${title}`, "公司：首次推荐 Fake 夹具", "地点：上海", "截止日期：2027-09-12T00:00:00.000Z", "工作方式：远程", "是否需要搬迁：否", "薪资：CNY 30000-45000/month", "学历：本科", "语言：英语(C1)", "工作资格：中国工作许可", "行业：人工智能", "雇佣类型：直接雇佣", "必备技能：TypeScript",
  ].join("\n");
  const created = await request.post(`${apiBaseUrl}/v1/job-imports`, { headers: auth(account.token), data: { inputType: "pasted_text", content } });
  expect(created.status()).toBe(202);
  const { importId } = await created.json() as { importId: string };
  let opportunityId: string | undefined;
  await expect.poll(async () => {
    const detail = await request.get(`${apiBaseUrl}/v1/job-imports/${importId}`, { headers: auth(account.token) });
    expect(detail.status()).toBe(200);
    const body = await detail.json() as { status: string; opportunity: { opportunityId: string } | null };
    opportunityId = body.opportunity?.opportunityId;
    return body.status;
  }, { timeout: 20_000 }).toBe("completed");
  expect(opportunityId).toBeTruthy();
  const triage = await request.post(`${apiBaseUrl}/v1/job-opportunities/${opportunityId}/triage-versions`, { headers: auth(account.token), data: { targetId: account.targetId } });
  expect(triage.status()).toBe(201);
  await expect(triage.json()).resolves.toMatchObject({ overallVerdict: "pass" });
  return opportunityId!;
}

async function installMatchingFixture(userId: string, targetId: string, fixture: { qualityInsufficientOpportunityIds?: string[]; overallScoresByOpportunityId?: Record<string, number> }): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const fixtureJson = JSON.stringify(fixture).replaceAll("'", "''");
    await client.query(`drop trigger if exists e2e_first_recommendation_fixture_trigger on agent_runs;
      create or replace function e2e_first_recommendation_fixture() returns trigger language plpgsql as $$
      begin
        if new.user_id = '${userId}'::uuid and new.target_id = '${targetId}'::uuid and new.workflow_version = 'deep-match-v1' then
          update agent_runs set source_scope = jsonb_set(new.source_scope, '{testFixture}', '${fixtureJson}'::jsonb) where id = new.id;
        end if;
        return new;
      end;
      $$;
      create trigger e2e_first_recommendation_fixture_trigger after insert on agent_runs for each row execute function e2e_first_recommendation_fixture();`);
  } finally { await client.end(); }
}

async function removeMatchingFixture(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try { await client.query("drop trigger if exists e2e_first_recommendation_fixture_trigger on agent_runs; drop function if exists e2e_first_recommendation_fixture()"); } finally { await client.end(); }
}

async function startDiscovery(request: APIRequestContext, account: PreparedAccount, idempotencyKey: string): Promise<string> {
  const preflight = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${account.targetId}`, { headers: auth(account.token) });
  expect(preflight.status()).toBe(200);
  const report = await preflight.json() as { status: string; warningFingerprint: string | null };
  expect(report.status).toBe("ready_with_warnings");
  const started = await request.post(`${apiBaseUrl}/v1/agent-runs`, { headers: auth(account.token), data: { targetId: account.targetId, idempotencyKey, warningFingerprint: report.warningFingerprint } });
  expect(started.status()).toBe(201);
  return (await started.json() as { runId: string }).runId;
}

async function startDiscoveryFromHome(page: Page, idempotencyKey: string): Promise<string> {
  await installFirstRandomUuid(page, idempotencyKey);
  await page.goto("/home");
  await page.getByRole("button", { name: "发现岗位" }).click();
  await expect(page.getByRole("button", { name: "我已了解，仍要启动" })).toBeVisible();
  const requestPromise = page.waitForRequest((request) => request.url().endsWith("/api/agent-runs") && request.method() === "POST");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "我已了解，仍要启动" }).click();
  expect((await requestPromise).postDataJSON()).toMatchObject({ idempotencyKey });
  return ((await (await responsePromise).json()) as { runId: string }).runId;
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

async function waitForRun(page: Page, runId: string, status: "completed" | "failed" = "completed"): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/agent-runs/${runId}`);
    return response.ok() ? (await response.json() as { status: string }).status : "unavailable";
  }, { timeout: status === "failed" ? 75_000 : 45_000 }).toBe(status);
}

async function removeProfileFacts(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.get(`${apiBaseUrl}/v1/profile`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  let snapshot = await response.json() as { version: number; facts: Array<{ factId: string }> };
  for (const fact of snapshot.facts) {
    const removal = await request.post(`${apiBaseUrl}/v1/profile/facts/${fact.factId}/removals`, {
      headers: auth(token), data: { expectedVersion: snapshot.version, reason: "验证完成后维护提醒" },
    });
    expect(removal.status()).toBe(201);
    snapshot = await removal.json() as { version: number; facts: Array<{ factId: string }> };
  }
}

test("首次推荐旅程按真实准备状态推进，并跨刷新、重新登录与新上下文恢复交互", async ({ page, request, browser }, info) => {
  test.setTimeout(90_000);
  const account = await createAccount(request, subjectFor(info, "resume"));
  await useSession(page, account.token);
  await page.goto("/home");
  await expectActiveJourney(page, "准备可用职业资料");
  await expectJourneyStep(page, "准备可用职业资料", "needs_action", true);

  await importCareerMaterial(page);
  await page.goto("/home");
  await expectJourneyStep(page, "准备可用职业资料", "completed");
  await expectJourneyStep(page, "建立可信求职画像", "needs_action", true);

  await addTrustedFact(request, account.token, 0, "skill", { name: "TypeScript" });
  await page.goto("/home");
  await expectJourneyStep(page, "建立可信求职画像", "completed");
  await expectJourneyStep(page, "明确主要求职方向", "needs_action", true);

  const targetEntry = journeyStep(page, "明确主要求职方向").getByRole("link", { name: "查看求职目标" });
  const visitSaved = page.waitForResponse((response) => response.url().endsWith("/api/workbench/first-recommendation-journey") && response.request().method() === "PUT");
  await activate(page, targetEntry, info);
  await expect(page).toHaveURL(/\/profile\/targets$/u);
  expect((await visitSaved).status()).toBe(200);
  await page.goto("/home");
  await expectJourneyStep(page, "明确主要求职方向", "needs_action", true);

  await page.getByRole("button", { name: "退出" }).click();
  await expect(page).toHaveURL(/\/login$/u);
  const relogin = await createAccount(request, account.subject);
  expect(relogin.userId).toBe(account.userId);
  await useSession(page, relogin.token);
  await page.goto("/home");
  await expectJourneyStep(page, "明确主要求职方向", "needs_action", true);

  const resumedContext = await browser.newContext();
  try {
    const resumedPage = await resumedContext.newPage();
    await useSession(resumedPage, relogin.token);
    await resumedPage.goto("http://127.0.0.1:3120/home");
    await expectJourneyStep(resumedPage, "明确主要求职方向", "needs_action", true);
  } finally { await resumedContext.close(); }

  const targetId = await createPrimaryTarget(request, relogin.token);
  await page.goto("/home");
  await expectJourneyStep(page, "明确主要求职方向", "completed");
  await expectJourneyStep(page, "接通真实岗位来源", "needs_action", true);

  await enableExecutableSource(request, relogin.token, targetId, "First Journey Resume Fixture");
  await page.goto("/home");
  await expectJourneyStep(page, "接通真实岗位来源", "completed");

  await runModelDiagnostic(request, relogin.token);
  await page.goto("/home");
  await expectJourneyStep(page, "确认今天可以开始", "completed");
  await expectJourneyStep(page, "获得第一份推荐结果", "needs_action", true);
  await assertJourneyAccessibility(page);

  const dismiss = page.getByRole("button", { name: "暂时关闭引导" });
  const dismissed = page.waitForResponse((response) => response.url().endsWith("/api/workbench/first-recommendation-journey") && response.request().method() === "PUT");
  await activate(page, dismiss, info);
  expect((await dismissed).status()).toBe(200);
  await expect(page.getByText("已暂时关闭首次推荐旅程。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "首次推荐旅程" })).toHaveCount(0);

  await page.getByRole("button", { name: "退出" }).click();
  const afterDismissal = await createAccount(request, account.subject);
  await useSession(page, afterDismissal.token);
  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "首次推荐旅程" })).toHaveCount(0);
  const dismissedContext = await browser.newContext();
  try {
    const dismissedPage = await dismissedContext.newPage();
    await useSession(dismissedPage, afterDismissal.token);
    await dismissedPage.goto("http://127.0.0.1:3120/home");
    await expect(dismissedPage.getByRole("heading", { name: "首次推荐旅程" })).toHaveCount(0);
  } finally { await dismissedContext.close(); }
});

test("可信非空推荐会永久完成旅程，后续撤销准备条件仍保留维护问题", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const account = await prepareMatchingAccount(request, info, "permanent");
  const opportunityId = await importAndPassGate(request, account, "首次推荐永久完成夹具");
  await useSession(page, account.token);
  await installMatchingFixture(account.userId, account.targetId, { overallScoresByOpportunityId: { [opportunityId]: 95 } });
  try {
    const discoveryRunId = await startDiscovery(request, account, keyFor(info).success);
    await page.goto("/recommendations");
    await waitForRun(page, discoveryRunId);
    const matchRunId = await automaticMatchRun(account.userId, discoveryRunId);
    await waitForRun(page, matchRunId);
  } finally { await removeMatchingFixture(); }

  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "首次推荐旅程" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "推荐" })).toBeVisible();

  await removeProfileFacts(request, account.token);
  const targets = await request.get(`${apiBaseUrl}/v1/job-targets`, { headers: auth(account.token) });
  expect(targets.status()).toBe(200);
  const overview = await targets.json() as { targets: Array<{ targetId: string; version: number; priority: string }> };
  const primary = overview.targets.find((target) => target.priority === "primary")!;
  const deactivated = await request.post(`${apiBaseUrl}/v1/job-targets/${primary.targetId}/deactivations`, { headers: auth(account.token), data: { expectedVersion: primary.version } });
  expect(deactivated.status()).toBe(201);
  const preflight = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual`, { headers: auth(account.token) });
  expect(preflight.status()).toBe(200);
  await expect(preflight.json()).resolves.toMatchObject({ status: "blocked" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "首次推荐旅程" })).toHaveCount(0);
  await expect(page.getByLabel("运行前检查").getByRole("status")).toHaveText("暂不能启动");
  await expect(page.getByLabel("运行前检查")).toContainText("阻塞项");
});

test("失败运行和零接受推荐清单都不会完成首次推荐旅程", async ({ page, request }, info) => {
  test.setTimeout(150_000);
  const failedAccount = await prepareMatchingAccount(request, info, "failed");
  await useSession(page, failedAccount.token);
  await importCareerMaterial(page);
  const failedRunId = await startDiscoveryFromHome(page, keyFor(info).failure);
  await waitForRun(page, failedRunId, "failed");
  await page.reload();
  await expectActiveJourney(page, "获得第一份推荐结果");
  await expectJourneyStep(page, "获得第一份推荐结果", "needs_action", true);

  const emptyAccount = await prepareMatchingAccount(request, info, "empty");
  await useSession(page, emptyAccount.token);
  await importCareerMaterial(page);
  const excludedOpportunityId = await importAndPassGate(request, emptyAccount, "首次推荐零接受夹具");
  await installMatchingFixture(emptyAccount.userId, emptyAccount.targetId, { qualityInsufficientOpportunityIds: [excludedOpportunityId] });
  try {
    const discoveryRunId = await startDiscovery(request, emptyAccount, crypto.randomUUID());
    await page.goto("/recommendations");
    await waitForRun(page, discoveryRunId);
    const matchRunId = await automaticMatchRun(emptyAccount.userId, discoveryRunId);
    await waitForRun(page, matchRunId);
  } finally { await removeMatchingFixture(); }
  await page.goto("/home");
  await expectActiveJourney(page, "获得第一份推荐结果");
  await expectJourneyStep(page, "获得第一份推荐结果", "needs_action", true);
});
