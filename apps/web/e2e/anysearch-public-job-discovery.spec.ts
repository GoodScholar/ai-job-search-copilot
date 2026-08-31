import { createHash } from "node:crypto";
import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import AxeBuilder from "@axe-core/playwright";
import { Client } from "pg";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";
const fixtureOrigin = process.env.E2E_ANYSEARCH_FIXTURE_ORIGIN ?? "http://127.0.0.1:39334";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const scenarios = {
  "Desktop Chrome": { idempotencyKey: "10000000-0000-4000-8000-000000000131", subject: "fake-anysearch-desktop" },
  "Mobile Safari": { idempotencyKey: "10000000-0000-4000-8000-000000000132", subject: "fake-anysearch-mobile" },
} as const;

function scenarioFor(testInfo: TestInfo) { return scenarios[testInfo.project.name as keyof typeof scenarios]; }

async function configureAccount(request: APIRequestContext, scenario: { subject: string }): Promise<{ token: string; userId: string; targetId: string }> {
  const session = await request.post(apiBaseUrl + "/v1/auth/dev/sessions", {
    headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject: scenario.subject + "-" + Date.now() },
  });
  expect(session.status()).toBe(201);
  const sessionBody = await session.json() as { sessionToken: string; account: { userId: string } };
  const token = sessionBody.sessionToken;
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
  return { token, userId: sessionBody.account.userId, targetId };
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

async function addApprovedFixtureWatchlist(page: Page): Promise<void> {
  const companyName = page.getByLabel("公司规范名称");
  await companyName.click();
  await companyName.fill("Fake AnySearch Fixture");
  await expect(companyName).toHaveValue("Fake AnySearch Fixture");
  const careersUrl = page.getByLabel("公开招聘入口");
  await careersUrl.fill("https://boards.greenhouse.io/fake-anysearch-fixture");
  await expect(careersUrl).toHaveValue("https://boards.greenhouse.io/fake-anysearch-fixture");
  const allowedDomains = page.getByLabel("允许域");
  await allowedDomains.fill("boards.greenhouse.io, boards-api.greenhouse.io");
  await expect(allowedDomains).toHaveValue("boards.greenhouse.io, boards-api.greenhouse.io");
  await page.getByRole("button", { name: "保存目标公司" }).click();
  await expect(page.getByRole("status")).toHaveText("目标公司已添加。");
}

async function fixtureAudit(): Promise<Array<{ operation: string; fixture?: string }>> {
  const response = await fetch(fixtureOrigin + "/__fixture/fake-anysearch-audit");
  expect(response.status).toBe(200);
  return (await response.json() as { operations: Array<{ operation: string; fixture?: string }> }).operations;
}

async function resetFixture(): Promise<void> {
  const response = await fetch(fixtureOrigin + "/__fixture/fake-anysearch-reset", { method: "POST" });
  expect(response.status).toBe(204);
}

async function persistedFacts(userId: string, runId: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const [leads, attributions, postings, versions, opportunities, results, attentions] = await Promise.all([
      client.query("select id, query_id, query_kind, state, normalized_url, source_posting_version_id, rejection_code from job_discovery_leads where user_id = $1 and run_id = $2 order by normalized_url", [userId, runId]),
      client.query("select lead_id, query_id, source_posting_version_id from job_discovery_attributions where user_id = $1 and run_id = $2", [userId, runId]),
      client.query("select p.source_id, p.source_identifier, p.source_identity, p.is_official from job_source_postings p join job_source_posting_versions v on v.source_posting_id = p.id and v.user_id = p.user_id join job_discovery_leads l on l.source_posting_version_id = v.id and l.user_id = v.user_id where l.user_id = $1 and l.run_id = $2", [userId, runId]),
      client.query("select raw_object_reference::text as raw_object_reference, normalized_data::text as normalized_data from job_source_posting_versions where user_id = $1 and id in (select source_posting_version_id from job_discovery_leads where user_id = $1 and run_id = $2 and state = 'verified')", [userId, runId]),
      client.query("select id from job_opportunities where user_id = $1 and source_posting_version_id in (select source_posting_version_id from job_discovery_leads where user_id = $1 and run_id = $2)", [userId, runId]),
      client.query("select source_posting_version_id, ordinal from job_discovery_run_results where user_id = $1 and run_id = $2 order by ordinal", [userId, runId]),
      client.query("select id, kind, reason_code from agent_inbox_items where user_id = $1 and run_id = $2 and kind = 'discovery_attention'", [userId, runId]),
    ]);
    return { leads: leads.rows, attributions: attributions.rows, postings: postings.rows, versions: versions.rows, opportunities: opportunities.rows, results: results.rows, attentions: attentions.rows };
  } finally {
    await client.end();
  }
}

test("版本化 Fake AnySearch 从普通 UI 运行真实 layered public 验收链 @configured", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const scenario = scenarioFor(testInfo);
  const account = await configureAccount(request, scenario);
  await resetFixture();
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/profile/targets/" + account.targetId + "/watchlist");
  await addApprovedFixtureWatchlist(page);

  await installIdempotencyKey(page, scenario.idempotencyKey);
  await page.goto("/home");
  const started = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  const start = page.getByRole("button", { name: "发现岗位" });
  if (testInfo.project.name === "Mobile Safari") await start.tap(); else await start.click();
  const runId = ((await (await started).json()) as { runId: string }).runId;

  await expect.poll(async () => (await readRun(page, runId)).status, { timeout: 75_000 }).toBe("completed");
  const run = await readRun(page, runId);
  expect(run.executionSpec).toMatchObject({ workflowVersion: "layered-public-job-discovery-v1", adapter: "layered-public" });
  if (!("sourceIssues" in run)) throw new Error("LAYERED_PUBLIC_RUN_REQUIRED");
  const queries = "publicDiscovery" in run.executionSpec.sourceScope ? run.executionSpec.sourceScope.publicDiscovery.queries : [];
  expect(queries.map((query) => query.kind)).toEqual(expect.arrayContaining(["general", "site_constrained", "target_company"]));
  expect(queries).toHaveLength(6);
  expect(queries.every((query) => query.resultLimit <= 5)).toBe(true);
  expect(queries.find((query) => query.kind === "target_company")?.allowedSiteDomains).toEqual(["boards.greenhouse.io", "boards-api.greenhouse.io"]);
  expect(run.termination?.kind).toBe("completed_with_source_issues");
  expect(run.results).toHaveLength(1);
  expect(run.sourceIssues.filter((issue) => issue.code === "ANYSEARCH_RATE_LIMITED")).toEqual([{ provider: "anysearch", code: "ANYSEARCH_RATE_LIMITED", affectedCount: 1 }]);
  const audit = await fixtureAudit();
  expect(audit.filter((entry) => entry.operation === "search")).toEqual([
    { operation: "search", fixture: "general" },
    { operation: "search", fixture: "platform_rate_limited" },
    { operation: "search", fixture: "platform_unavailable" },
    { operation: "search", fixture: "platform_duplicate" },
    { operation: "search", fixture: "platform_duplicate" },
    { operation: "search", fixture: "target_company" },
  ]);
  const facts = await persistedFacts(account.userId, runId);
  expect(facts.leads.filter((lead) => lead.state === "verified")).toHaveLength(1);
  expect(facts.leads.filter((lead) => lead.state === "rejected").map((lead) => lead.rejection_code).sort()).toEqual(["JOB_PAGE_EXPIRED", "JOB_PAGE_LISTING", "JOB_PAGE_LOGIN_REQUIRED", "JOB_PAGE_UNRECOGNIZED", "POLICY_REJECTED"]);
  expect(facts.leads.filter((lead) => lead.state === "rejected").every((lead) => lead.source_posting_version_id === null)).toBe(true);
  expect(facts.attributions).toHaveLength(1);
  expect(facts.attributions[0]).toMatchObject({ lead_id: facts.leads.find((lead) => lead.state === "verified")!.id, source_posting_version_id: facts.leads.find((lead) => lead.state === "verified")!.source_posting_version_id });
  const verifiedUrl = "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9001";
  expect(facts.postings).toEqual([expect.objectContaining({
    source_id: verifiedUrl,
    source_identifier: createHash("sha256").update(verifiedUrl, "utf8").digest("hex"),
    source_identity: { taxonomyPolicy: "public-job-source-taxonomy-v1", canonicalUrl: verifiedUrl, finalUrl: verifiedUrl },
    is_official: true,
  })]);
  expect(facts.versions).toHaveLength(1);
  expect(facts.versions[0]?.raw_object_reference).toContain(`accounts/${account.userId}/public-job-pages/`);
  expect(JSON.stringify(facts.versions)).not.toContain("ignored");
  expect(facts.opportunities).toHaveLength(1);
  expect(facts.results).toEqual([{ source_posting_version_id: facts.leads.find((lead) => lead.state === "verified")!.source_posting_version_id, ordinal: 1 }]);
  expect(facts.attentions).toHaveLength(1);
  expect(audit.map((entry) => entry.operation)).toEqual(expect.arrayContaining(["search", "extract", "page"]));
  for (const fixture of ["verified", "expired", "login", "listing", "insufficient"]) {
    const extractedAt = audit.findIndex((entry) => entry.operation === "extract" && entry.fixture === fixture);
    const pagedAt = audit.findIndex((entry) => entry.operation === "page" && entry.fixture === fixture);
    expect(extractedAt).toBeGreaterThan(-1);
    expect(pagedAt).toBeGreaterThan(extractedAt);
  }
  const policyExtractedAt = audit.findIndex((entry) => entry.operation === "extract" && entry.fixture === "policy");
  const targetSearchAt = audit.findIndex((entry) => entry.operation === "search" && entry.fixture === "target_company");
  expect(policyExtractedAt).toBeGreaterThan(targetSearchAt);
  expect(audit.some((entry) => entry.operation === "page" && entry.fixture === "policy")).toBe(false);
  expect(audit.filter((entry) => entry.operation === "page").every((entry) => ["verified", "expired", "login", "listing", "insufficient"].includes(entry.fixture ?? ""))).toBe(true);
  await page.reload();
  await expect(page.locator(".agent-run-panel [role=status]")).toContainText("岗位发现部分完成");
  await expect(page.locator(".agent-run-results li")).toHaveCount(1);
  const attention = page.locator(".agent-inbox-panel").getByRole("link", { name: "查看本次运行诊断" });
  await expect(attention).toHaveAttribute("href", `/home?runId=${runId}#agent-run`);
  const controls = page.locator(".agent-run-panel .workbench-touch-target, .agent-inbox-panel .workbench-touch-target");
  expect(await controls.count()).toBeGreaterThan(0);
  expect(await controls.evaluateAll((elements) => elements.every((element) => element.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("版本化 Fake AnySearch 缺 key 时从普通 UI 失败且不触发 provider transport @missing-key", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const scenario = scenarioFor(testInfo);
  const account = await configureAccount(request, { subject: "fake-anysearch-missing-key-" + scenario.subject });
  await resetFixture();
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await installIdempotencyKey(page, testInfo.project.name === "Desktop Chrome" ? "10000000-0000-4000-8000-000000000141" : "10000000-0000-4000-8000-000000000142");
  await page.goto("/home");
  const started = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  const start = page.getByRole("button", { name: "发现岗位" });
  if (testInfo.project.name === "Mobile Safari") await start.tap(); else await start.click();
  const runId = ((await (await started).json()) as { runId: string }).runId;

  await expect.poll(async () => (await readRun(page, runId)).status, { timeout: 75_000 }).toBe("failed");
  const run = await readRun(page, runId);
  if (!("sourceIssues" in run)) throw new Error("LAYERED_PUBLIC_RUN_REQUIRED");
  expect(run.sourceIssues.filter((issue) => issue.code === "ANYSEARCH_NOT_CONFIGURED")).toEqual([{ provider: "anysearch", code: "ANYSEARCH_NOT_CONFIGURED", affectedCount: 1 }]);
  expect(run.results).toHaveLength(0);
  const facts = await persistedFacts(account.userId, runId);
  expect(facts.leads).toHaveLength(0);
  expect(facts.attributions).toHaveLength(0);
  expect(facts.postings).toHaveLength(0);
  expect(facts.versions).toHaveLength(0);
  expect(facts.opportunities).toHaveLength(0);
  expect(facts.results).toHaveLength(0);
  expect(facts.attentions).toHaveLength(1);
  expect(await fixtureAudit()).toEqual([]);
  expect(JSON.stringify({ run, facts })).not.toContain("fake-anysearch-public-job-test-key");
  await page.reload();
  const attention = page.locator(".agent-inbox-panel").getByRole("link", { name: "查看本次运行诊断" });
  await expect(attention).toHaveAttribute("href", `/home?runId=${runId}#agent-run`);
});
