import AxeBuilder from "@axe-core/playwright";
import { Client } from "pg";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { startPhysicalDiscovery } from "./support/start-physical-discovery";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";
const devAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const resume = ["## 技能", "- TypeScript"].join("\n");

type Account = { token: string; userId: string; targetId: string };
type InboxItem = { itemId: string; kind: string; status: string; target: { href: string } };

function subject(info: TestInfo, scope: string) {
  return `inbox-${scope}-${info.project.name}-${runSuffix}`.slice(0, 80);
}

async function createSession(request: APIRequestContext, subjectValue: string): Promise<{ token: string; userId: string }> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": devAuthSecret }, data: { subject: subjectValue },
  });
  expect(response.status()).toBe(201);
  const body = await response.json() as { sessionToken: string; account: { userId: string } };
  return { token: body.sessionToken, userId: body.account.userId };
}

async function signIn(page: Page, token: string): Promise<void> {
  await page.context().addCookies([{
    name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
  }]);
}

async function createTarget(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/job-targets`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      priority: "primary",
      constraints: {
        roleFamily: "Inbox 验收工程师", seniority: "中级", locations: ["上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [],
        dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
      },
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { targets: Array<{ targetId: string; priority: string }> }).targets.find((target) => target.priority === "primary")!.targetId;
}

async function createCandidateFact(request: APIRequestContext, token: string): Promise<string> {
  const created = await request.post(`${apiBaseUrl}/v1/career-documents/imports`, {
    headers: { authorization: `Bearer ${token}` },
    multipart: { privacyMode: "sanitized_only", file: { name: "inbox.md", mimeType: "text/markdown", buffer: Buffer.from(resume, "utf8") } },
  });
  expect(created.status()).toBe(202);
  const { importId } = await created.json() as { importId: string };
  let factId: string | undefined;
  await expect.poll(async () => {
    const detail = await request.get(`${apiBaseUrl}/v1/career-documents/imports/${importId}`, { headers: { authorization: `Bearer ${token}` } });
    if (!detail.ok()) return "unavailable";
    const body = await detail.json() as { status: string; facts: Array<{ factId: string; factType: string }> };
    factId = body.facts.find((fact) => fact.factType === "skill")?.factId;
    return `${body.status}:${factId ?? "missing"}`;
  }, { timeout: 20_000 }).toMatch(/^completed:/u);
  expect(factId).toBeTruthy();
  return factId!;
}

async function inboxItems(request: APIRequestContext, token: string, status: "pending" | "unread" | "read" | "resolved"): Promise<InboxItem[]> {
  const response = await request.get(`${apiBaseUrl}/v1/agent-inbox?status=${status}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  return (await response.json() as { items: InboxItem[] }).items;
}

async function inboxItem(request: APIRequestContext, token: string, kind: string, status: "pending" | "unread" | "read" | "resolved"): Promise<InboxItem> {
  const item = (await inboxItems(request, token, status)).find((entry) => entry.kind === kind);
  expect(item, `missing ${kind} ${status} item`).toBeTruthy();
  return item!;
}

async function inboxStatus(request: APIRequestContext, token: string, kind: string, status: "pending" | "unread" | "read" | "resolved"): Promise<string | null> {
  return (await inboxItems(request, token, status)).find((entry) => entry.kind === kind)?.status ?? null;
}

async function inboxItemStatus(request: APIRequestContext, token: string, itemId: string, status: "pending" | "unread" | "read" | "resolved"): Promise<string | null> {
  return (await inboxItems(request, token, status)).find((entry) => entry.itemId === itemId)?.status ?? null;
}

async function activate(page: Page, info: TestInfo, label: string | RegExp): Promise<void> {
  await activateControl(page, page.getByRole("button", { name: label }), info);
}

async function activateControl(page: Page, control: ReturnType<Page["getByRole"]>, info: TestInfo): Promise<void> {
  if (info.project.name === "Mobile Safari") await control.tap();
  else await control.press("Enter");
}

async function assertAccessible(page: Page): Promise<void> {
  const controls = page.locator("main .workbench-touch-target");
  expect(await controls.count()).toBeGreaterThan(0);
  expect(await controls.evaluateAll((items) => items.every((item) => {
    const rect = item.getBoundingClientRect();
    return rect.height >= 44 && rect.width >= 44;
  }))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
}

async function assertReducedMotion(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.locator("main").evaluate((element) => getComputedStyle(element).scrollBehavior)).not.toBe("smooth");
}

async function addWatchlistSource(page: Page, targetId: string, name: string, board: string): Promise<void> {
  await page.goto(`/profile/targets/${targetId}/watchlist`);
  await page.getByLabel("公司规范名称").fill(name);
  await page.getByLabel("公开招聘入口").fill(`https://boards.greenhouse.io/${board}`);
  await page.getByLabel("允许域").fill("boards.greenhouse.io, boards-api.greenhouse.io");
  await page.getByRole("button", { name: "保存目标公司" }).click();
  await expect(page.getByRole("status")).toContainText("目标公司已添加。");
}

async function waitForRun(page: Page, runId: string): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(`/api/agent-runs/${runId}`);
    return response.ok() ? (await response.json() as { status: string }).status : "unavailable";
  }, { timeout: 45_000 }).toBe("completed");
}

async function createRecommendationAccount(request: APIRequestContext, info: TestInfo): Promise<Account> {
  const session = await createSession(request, subject(info, "calibration"));
  const facts = [
    { factType: "education", factValue: { summary: "本科" } }, { factType: "language", factValue: { name: "英语", level: "C1" } },
    { factType: "work_eligibility", factValue: { summary: "中国工作许可" } }, { factType: "skill", factValue: { name: "TypeScript" } },
    { factType: "experience", factValue: { summary: "前端工程实践经验" } }, { factType: "project", factValue: { summary: "可验证的交付项目" } },
  ];
  for (const [expectedVersion, fact] of facts.entries()) {
    const response = await request.post(`${apiBaseUrl}/v1/profile/facts`, { headers: { authorization: `Bearer ${session.token}` }, data: { expectedVersion, ...fact } });
    expect(response.status()).toBe(201);
  }
  const target = await request.post(`${apiBaseUrl}/v1/job-targets`, {
    headers: { authorization: `Bearer ${session.token}` },
    data: {
      priority: "primary",
      constraints: {
        roleFamily: "frontend", seniority: null, locations: ["上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [],
        dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
      },
    },
  });
  expect(target.status()).toBe(201);
  const targetId = (await target.json() as { targets: Array<{ targetId: string; priority: string }> }).targets.find((entry) => entry.priority === "primary")!.targetId;
  const source = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items`, {
    headers: { authorization: `Bearer ${session.token}` },
    data: { expectedVersion: 0, canonicalCompanyName: "Inbox Calibration Fixture", careersUrl: "https://boards.greenhouse.io/inbox-calibration-fixture", allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null },
  });
  expect(source.status()).toBe(201);
  const diagnostic = await request.post(`${apiBaseUrl}/v1/model-diagnostics`, {
    headers: { authorization: `Bearer ${session.token}` }, data: {},
  });
  expect(diagnostic.status()).toBe(201);
  await expect(diagnostic.json()).resolves.toMatchObject({ status: "available" });
  return { ...session, targetId };
}

async function importAndTriage(request: APIRequestContext, account: Account, title: string): Promise<void> {
  const content = [`# ${title}`, "公司：Inbox 校准夹具", "地点：上海", "截止日期：2027-09-12T00:00:00.000Z", "工作方式：远程", "是否需要搬迁：否", "薪资：CNY 30000-45000/month", "学历：本科", "语言：英语(C1)", "工作资格：中国工作许可", "行业：人工智能", "雇佣类型：直接雇佣", "必备技能：TypeScript"].join("\n");
  const created = await request.post(`${apiBaseUrl}/v1/job-imports`, { headers: { authorization: `Bearer ${account.token}` }, data: { inputType: "pasted_text", content } });
  expect(created.status()).toBe(202);
  const { importId } = await created.json() as { importId: string };
  let opportunityId: string | undefined;
  await expect.poll(async () => {
    const detail = await request.get(`${apiBaseUrl}/v1/job-imports/${importId}`, { headers: { authorization: `Bearer ${account.token}` } });
    const body = await detail.json() as { status: string; opportunity: { opportunityId: string } | null };
    opportunityId = body.opportunity?.opportunityId;
    return `${body.status}:${opportunityId ?? "missing"}`;
  }, { timeout: 20_000 }).toMatch(/^completed:/u);
  const triage = await request.post(`${apiBaseUrl}/v1/job-opportunities/${opportunityId}/triage-versions`, { headers: { authorization: `Bearer ${account.token}` }, data: { targetId: account.targetId } });
  expect(triage.status()).toBe(201);
}

async function waitForAutomaticMatch(userId: string, discoveryRunId: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let runId: string | undefined;
    await expect.poll(async () => {
      const result = await client.query("select id from agent_runs where user_id = $1 and workflow_version = 'deep-match-v1' and source_scope ->> 'discoveryRunId' = $2 order by created_at desc limit 1", [userId, discoveryRunId]);
      runId = result.rows[0]?.id as string | undefined;
      return runId ?? null;
    }, { timeout: 45_000 }).not.toBeNull();
    return runId!;
  } finally { await client.end(); }
}

async function activeRuleSnapshot(userId: string, targetId: string): Promise<{ version: number; config: unknown } | null> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query("select version, config from recommendation_rule_versions where user_id = $1 and target_id = $2 order by version desc limit 1", [userId, targetId]);
    return result.rows[0] ? { version: Number(result.rows[0].version), config: result.rows[0].config } : null;
  } finally { await client.end(); }
}

test("从首页将候选事实由未读标记为已读并确认解决", async ({ page, request }, info) => {
  test.skip(process.env.E2E_WORKBENCH_INBOX_SOURCE_ONLY === "1", "来源受控 phase 只运行来源旅程。");
  const session = await createSession(request, subject(info, "candidate"));
  await createCandidateFact(request, session.token);
  await signIn(page, session.token);
  await page.goto("/home");

  await expect(page.getByRole("heading", { name: "需要你决定的事项", exact: true })).toBeVisible();
  const unread = await inboxItem(request, session.token, "candidate_fact", "unread");
  const foreign = await createSession(request, subject(info, "foreign"));
  expect(await inboxItems(request, foreign.token, "unread")).toEqual([]);
  const foreignMutation = await request.post(`${apiBaseUrl}/v1/agent-inbox/${unread.itemId}/actions`, {
    headers: { authorization: `Bearer ${foreign.token}` }, data: { actionId: crypto.randomUUID(), action: "mark_read" },
  });
  expect(foreignMutation.status()).toBe(404);
  const article = page.getByRole("article", { name: "有待确认的画像事实" });
  await expect(article).toBeVisible();
  await assertAccessible(page);
  const inboxStatusMessage = page.getByRole("region", { name: "需要你决定的事项", exact: true }).getByRole("status");
  await page.context().setOffline(true);
  await activate(page, info, "标记为已读：有待确认的画像事实");
  await expect(inboxStatusMessage).toContainText("暂时无法处理该事项，请稍后重试。");
  await expect(article).toBeVisible();
  await page.context().setOffline(false);
  await activate(page, info, "标记为已读：有待确认的画像事实");
  await expect(inboxStatusMessage).toContainText("事项已标记为已读。");
  await expect.poll(() => inboxStatus(request, session.token, "candidate_fact", "read")).toBe("read");
  expect(await inboxItem(request, session.token, "candidate_fact", "read")).toMatchObject({ itemId: unread.itemId, status: "read" });

  const detail = article.getByRole("link", { name: "查看相关记录" });
  if (info.project.name === "Mobile Safari") await detail.tap();
  else { await expect(detail).toBeFocused(); await page.keyboard.press("Enter"); }
  await expect(page).toHaveURL(/\/profile#candidate-facts$/u);
  await activate(page, info, "确认 TypeScript");
  await expect.poll(() => inboxStatus(request, session.token, "candidate_fact", "resolved")).toBe("resolved");
  expect(await inboxItem(request, session.token, "candidate_fact", "resolved")).toMatchObject({ itemId: unread.itemId, status: "resolved" });

  await page.goto("/home");
  await expect(page.getByRole("heading", { name: "今天暂无待决定事项", exact: true })).toBeVisible();
  await expect(page.locator(".workbench-summary > div").filter({ has: page.getByText("待确认事实", { exact: true }) }).locator("dd")).toHaveText("0");
  await expect(page.getByText("目前没有需要你决定的事项。新的确认、异常或推荐会显示在这里。")).toBeVisible();
  await assertReducedMotion(page);
  await assertAccessible(page);
  if (process.env.E2E_CAPTURE_WORKBENCH_INBOX === "1") {
    await page.screenshot({ path: `.impeccable/review/${info.project.name === "Mobile Safari" ? "mobile" : "desktop"}.png`, fullPage: true });
  }
});

test("从首页将受限来源标记已读、停用并标记为已处理", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  test.skip(process.env.E2E_WORKBENCH_INBOX_SOURCE_ONLY !== "1", "普通 Fake phase 只运行候选事实与校准旅程。");
  const session = await createSession(request, subject(info, "source"));
  const fact = await request.post(`${apiBaseUrl}/v1/profile/facts`, {
    headers: { authorization: `Bearer ${session.token}` },
    data: { expectedVersion: 0, factType: "skill", factValue: { name: "TypeScript" } },
  });
  expect(fact.status()).toBe(201);
  const targetId = await createTarget(request, session.token);
  await signIn(page, session.token);
  await page.goto("/home");
  const board = info.project.name === "Desktop Chrome" ? "e2e-inbox-desktop-limited" : "e2e-inbox-mobile-limited";
  const healthyBoard = info.project.name === "Desktop Chrome" ? "e2e-inbox-desktop-good" : "e2e-inbox-mobile-good";
  await addWatchlistSource(page, targetId, "Inbox 健康来源", healthyBoard);
  await addWatchlistSource(page, targetId, "Inbox 受限来源", board);
  const diagnostic = await request.post(`${apiBaseUrl}/v1/model-diagnostics`, {
    headers: { authorization: `Bearer ${session.token}` }, data: {},
  });
  expect(diagnostic.status()).toBe(201);
  await expect(diagnostic.json()).resolves.toMatchObject({ status: "available" });
  const preflightResponse = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${targetId}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  expect(preflightResponse.status()).toBe(200);
  const preflight = await preflightResponse.json() as { status: string; warningFingerprint: string | null; items: Array<{ code: string; severity: string }> };
  expect(preflight.status).toBe("ready_with_warnings");
  expect(preflight.warningFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(preflight.items.filter((item) => item.severity === "blocking")).toEqual([]);
  expect(preflight.items.filter((item) => item.severity === "warning")).toEqual([expect.objectContaining({ code: "SOURCE_HEALTH_UNCHECKED" })]);
  const command = {
    targetId,
    idempotencyKey: info.project.name === "Desktop Chrome" ? "10000000-0000-4000-8000-000000000151" : "10000000-0000-4000-8000-000000000152",
    warningFingerprint: preflight.warningFingerprint,
  };
  const created = await startPhysicalDiscovery(page.request, command);
  const runId = created.runId;
  await waitForRun(page, runId);
  await page.goto(`/home?runId=${runId}#agent-run`);
  await page.reload();

  const unread = await inboxItem(request, session.token, "source_attention", "unread");
  await activate(page, info, "标记为已读：部分来源需要关注");
  await expect.poll(() => inboxStatus(request, session.token, "source_attention", "read")).toBe("read");
  expect(await inboxItem(request, session.token, "source_attention", "read")).toMatchObject({ itemId: unread.itemId, status: "read" });
  const sourceArticle = page.getByRole("article", { name: "部分来源需要关注" });
  const detail = sourceArticle.getByRole("link", { name: "查看相关记录" });
  if (info.project.name === "Mobile Safari") await detail.tap(); else await detail.click();
  await expect(page).toHaveURL(new RegExp(`/profile/targets/${targetId}/watchlist#source-health$`));
  await expect(page.getByRole("article", { name: "Inbox 受限来源 来源诊断" })).toContainText("状态：访问受限");
  await activate(page, info, "停用 Inbox 受限来源");
  await expect(page.getByRole("status")).toContainText("来源已停用。");

  await page.goto("/home");
  await activate(page, info, "标记已处理：部分来源需要关注");
  await expect(page.getByRole("region", { name: "需要你决定的事项", exact: true }).getByRole("status")).toContainText("事项已处理。");
  await expect(page.getByRole("heading", { name: "先处理需要你决定的事项", exact: true })).toBeVisible();
  await expect(page.locator(".workbench-summary > div").filter({ has: page.getByText("待决定事项", { exact: true }) }).locator("dd")).toHaveText("1");
  await expect.poll(() => inboxStatus(request, session.token, "source_attention", "resolved")).toBe("resolved");
  expect(await inboxItem(request, session.token, "source_attention", "resolved")).toMatchObject({ itemId: unread.itemId, status: "resolved" });
  const recommendation = await inboxItem(request, session.token, "recommendation_list", "unread");
  await activate(page, info, "标记为已读：新的推荐清单已生成");
  await expect.poll(() => inboxStatus(request, session.token, "recommendation_list", "read")).toBe("read");
  await activate(page, info, "标记已处理：新的推荐清单已生成");
  await expect.poll(() => inboxStatus(request, session.token, "recommendation_list", "resolved")).toBe("resolved");
  expect(await inboxItem(request, session.token, "recommendation_list", "resolved")).toMatchObject({ itemId: recommendation.itemId, status: "resolved" });
  await expect(page.getByText("目前没有需要你决定的事项。新的确认、异常或推荐会显示在这里。")).toBeVisible();
  await assertAccessible(page);
});

test("从首页拒绝校准建议不会修改现行规则", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  test.skip(process.env.E2E_WORKBENCH_INBOX_SOURCE_ONLY === "1", "来源受控 phase 只运行来源旅程。");
  const account = await createRecommendationAccount(request, info);
  await signIn(page, account.token);
  const feedback = [
    ["Inbox 薪酬反馈一", "薪资"], ["Inbox 薪酬反馈二", "薪资"], ["Inbox 薪酬反馈三", "薪资"],
    ["Inbox 地点反馈一", "地点"], ["Inbox 地点反馈二", "地点"], ["Inbox 地点反馈三", "地点"],
  ] as const;
  for (const [title] of feedback) await importAndTriage(request, account, title);
  const preflight = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${account.targetId}`, { headers: { authorization: `Bearer ${account.token}` } });
  expect(preflight.status()).toBe(200);
  const report = await preflight.json() as { status: string; warningFingerprint: string | null; items: Array<{ code: string }> };
  expect(report).toMatchObject({ status: "ready_with_warnings", warningFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect(report.items.map((item) => item.code)).toContain("SOURCE_HEALTH_UNCHECKED");
  const discovery = await request.post(`${apiBaseUrl}/v1/agent-runs`, { headers: { authorization: `Bearer ${account.token}` }, data: { targetId: account.targetId, idempotencyKey: info.project.name === "Desktop Chrome" ? "10000000-0000-4000-8000-000000000161" : "10000000-0000-4000-8000-000000000162", warningFingerprint: report.warningFingerprint } });
  expect(discovery.status()).toBe(201);
  const discoveryRunId = (await discovery.json() as { runId: string }).runId;
  await waitForRun(page, await waitForAutomaticMatch(account.userId, discoveryRunId));
  await page.goto("/home");
  await page.goto(`/recommendations?targetId=${account.targetId}`);
  await expect(page.getByRole("list", { name: "推荐岗位" })).toBeVisible({ timeout: 45_000 });
  for (const [title, reason] of feedback) {
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
    const summary = card.locator("summary").filter({ hasText: "忽略此推荐" });
    if (info.project.name === "Mobile Safari") await summary.tap({ force: true }); else await summary.click();
    await card.getByRole("radio", { name: reason }).check();
    if (info.project.name === "Mobile Safari") await card.getByRole("button", { name: "确认忽略" }).tap({ force: true }); else await card.getByRole("button", { name: "确认忽略" }).click();
    await expect(card.getByText("当前推荐决策：", { exact: false })).toContainText("已忽略");
  }
  const calibration = page.getByRole("heading", { name: "校准建议" }).locator("..");
  await expect(calibration).toBeVisible();
  await expect(calibration.getByRole("article")).toHaveCount(2);
  await activateControl(page, calibration.getByRole("button", { name: "批准建议" }).first(), info);
  await expect(calibration.getByText("状态：已批准")).toBeVisible();
  const before = await activeRuleSnapshot(account.userId, account.targetId);
  expect(before).toMatchObject({ version: 1 });
  expect(before?.config).toBeTruthy();

  await page.goto("/home");
  const unread = await inboxItem(request, account.token, "calibration_proposal", "unread");
  await activate(page, info, "标记为已读：推荐校准建议待查看");
  await expect.poll(() => inboxStatus(request, account.token, "calibration_proposal", "read")).toBe("read");
  expect(await inboxItem(request, account.token, "calibration_proposal", "read")).toMatchObject({ itemId: unread.itemId, status: "read" });
  const detail = page.getByRole("article", { name: "推荐校准建议待查看" }).getByRole("link", { name: "查看相关记录" });
  if (info.project.name === "Mobile Safari") await detail.tap(); else await detail.click();
  await expect(page).toHaveURL(/\/recommendations\?targetId=.*#calibration-proposal$/u);
  await page.reload();
  await expect(page.getByRole("button", { name: "拒绝建议" })).toBeEnabled();
  await activate(page, info, "拒绝建议");
  await expect.poll(() => activeRuleSnapshot(account.userId, account.targetId)).toEqual(before);
  await expect.poll(() => inboxItemStatus(request, account.token, unread.itemId, "resolved")).toBe("resolved");
  expect((await inboxItems(request, account.token, "resolved")).find((item) => item.itemId === unread.itemId)).toMatchObject({ itemId: unread.itemId, status: "resolved" });

  await page.goto("/home");
  const recommendation = await inboxItem(request, account.token, "recommendation_list", "unread");
  await activate(page, info, "标记为已读：新的推荐清单已生成");
  await expect.poll(() => inboxStatus(request, account.token, "recommendation_list", "read")).toBe("read");
  await activate(page, info, "标记已处理：新的推荐清单已生成");
  await expect.poll(() => inboxStatus(request, account.token, "recommendation_list", "resolved")).toBe("resolved");
  expect(await inboxItem(request, account.token, "recommendation_list", "resolved")).toMatchObject({ itemId: recommendation.itemId, status: "resolved" });
  await expect(page.getByText("目前没有需要你决定的事项。新的确认、异常或推荐会显示在这里。")).toBeVisible();
  await assertAccessible(page);
});
