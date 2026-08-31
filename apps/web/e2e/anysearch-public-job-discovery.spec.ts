import { createHash } from "node:crypto";
import type { AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import AxeBuilder from "@axe-core/playwright";
import { Queue } from "bullmq";
import { Client } from "pg";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";
const fixtureOrigin = process.env.E2E_ANYSEARCH_FIXTURE_ORIGIN ?? "http://127.0.0.1:39334";
const redisPort = Number(process.env.E2E_REDIS_PORT ?? "64790");
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const expectedSiteDomains = ["zhipin.com", "liepin.com", "zhaopin.com", "mp.weixin.qq.com"];
const expectedTargetCompanyName = "Fake AnySearch Fixture";
const expectedVerifiedCanonicalUrl = "https://boards.greenhouse.io/fake-anysearch-fixture/jobs/9001";
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

async function fixtureAudit(): Promise<Array<{ operation: string; fixture?: string; count?: number }>> {
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
    const [runUsage, leads, attributions, postings, versions, opportunities, results, attentions] = await Promise.all([
      client.query("select attempt_count, active_duration_ms, tool_call_count, source_request_count, model_call_count, input_token_count, output_token_count, total_token_count, result_count, usage_complete, termination_kind from agent_runs where user_id = $1 and id = $2", [userId, runId]),
      client.query("select id, query_id, query_kind, state, source_posting_version_id, rejection_code from job_discovery_leads where user_id = $1 and run_id = $2 order by id", [userId, runId]),
      client.query("select id as attribution_id, lead_id, query_id, source_posting_version_id from job_discovery_attributions where user_id = $1 and run_id = $2 order by id", [userId, runId]),
      client.query("select distinct p.id as posting_id, p.source_identifier, p.is_official, (p.source_identity ->> 'canonicalUrl') = $3 as canonical_matches, (p.source_identity ->> 'finalUrl') = $3 as final_matches from job_source_postings p join job_source_posting_versions v on v.source_posting_id = p.id and v.user_id = p.user_id join job_discovery_leads l on l.source_posting_version_id = v.id and l.user_id = v.user_id where l.user_id = $1 and l.run_id = $2 order by p.id", [userId, runId, expectedVerifiedCanonicalUrl]),
      client.query("select id as version_id, raw_object_reference is not null as has_raw_object_reference, position('ignored' in normalized_data::text) = 0 as normalized_data_safe from job_source_posting_versions where user_id = $1 and id in (select source_posting_version_id from job_discovery_leads where user_id = $1 and run_id = $2 and state = 'verified') order by id", [userId, runId]),
      client.query("select id as opportunity_id, source_posting_version_id from job_opportunities where user_id = $1 and source_posting_version_id in (select source_posting_version_id from job_discovery_leads where user_id = $1 and run_id = $2) order by id", [userId, runId]),
      client.query("select id as result_id, source_posting_version_id, ordinal from job_discovery_run_results where user_id = $1 and run_id = $2 order by ordinal", [userId, runId]),
      client.query("select id, kind, reason_code from agent_inbox_items where user_id = $1 and run_id = $2 and kind = 'discovery_attention' order by id", [userId, runId]),
    ]);
    return { runUsage: runUsage.rows[0], leads: leads.rows, attributions: attributions.rows, postings: postings.rows, versions: versions.rows, opportunities: opportunities.rows, results: results.rows, attentions: attentions.rows };
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
  expect(run.executionSpec.workflowVersion).toBe("layered-public-job-discovery-v1");
  expect(run.executionSpec.adapter).toBe("layered-public");
  if (!("sourceIssues" in run)) throw new Error("LAYERED_PUBLIC_RUN_REQUIRED");
  const queries = "publicDiscovery" in run.executionSpec.sourceScope ? run.executionSpec.sourceScope.publicDiscovery.queries : [];
  const publicDiscovery = "publicDiscovery" in run.executionSpec.sourceScope ? run.executionSpec.sourceScope.publicDiscovery : null;
  expect(publicDiscovery?.batchSize).toBe(5);
  expect(publicDiscovery?.maxVerificationCandidates).toBe(10);
  expect(queries.filter((query) => query.kind === "general")).toHaveLength(1);
  expect(queries).toHaveLength(6);
  const sites = queries.filter((query) => query.kind === "site_constrained");
  expect(sites).toHaveLength(4);
  expect(sites.map((site) => site.allowedSiteDomains)).toEqual(expectedSiteDomains.map((domain) => [domain]));
  for (const domain of expectedSiteDomains) {
    expect(sites.some((site) => site.allowedSiteDomains[0] === domain && site.query.includes(`site:${domain}`))).toBe(true);
  }
  expect(queries.every((query) => query.resultLimit === 5)).toBe(true);
  const targetCompanies = queries.filter((query) => query.kind === "target_company");
  expect(targetCompanies).toHaveLength(1);
  const targetCompany = targetCompanies[0];
  expect(targetCompany?.allowedSiteDomains).toEqual(["boards.greenhouse.io", "boards-api.greenhouse.io"]);
  expect(targetCompany?.targetCompanyNames).toEqual([expectedTargetCompanyName]);
  expect(Boolean(targetCompany?.query.includes(expectedTargetCompanyName))).toBe(true);
  expect(run.termination?.kind).toBe("completed_with_source_issues");
  expect(run.results).toHaveLength(1);
  expect(run.sourceIssues.filter((issue) => issue.code === "ANYSEARCH_RATE_LIMITED")).toEqual([{ provider: "anysearch", code: "ANYSEARCH_RATE_LIMITED", affectedCount: 1 }]);
  const audit = await fixtureAudit();
  expect(audit.filter((entry) => entry.operation === "search")).toEqual([
    { operation: "search", fixture: "general", count: 5 },
    { operation: "search", fixture: "platform_rate_limited", count: 0 },
    { operation: "search", fixture: "platform_unavailable", count: 0 },
    { operation: "search", fixture: "platform_duplicate", count: 1 },
    { operation: "search", fixture: "platform_duplicate", count: 1 },
    { operation: "search", fixture: "target_company", count: 3 },
  ]);
  const facts = await persistedFacts(account.userId, runId);
  expect(Object.hasOwn(facts, "runUsage")).toBe(true);
  expect(audit.filter((entry) => entry.operation === "search").every((entry) => (entry.count ?? Infinity) <= 5)).toBe(true);
  expect(facts.leads).toHaveLength(7);
  const verificationAudits = audit.filter((entry) => entry.operation === "extract");
  expect(verificationAudits).toHaveLength(7);
  expect(verificationAudits.length).toBeLessThanOrEqual(10);
  const verifiedLeads = facts.leads.filter((lead) => lead.state === "verified");
  expect(verifiedLeads).toHaveLength(2);
  expect(verifiedLeads.map((lead) => lead.query_kind).sort()).toEqual(["general", "target_company"]);
  expect(facts.leads.filter((lead) => lead.state === "rejected").map((lead) => lead.rejection_code).sort()).toEqual(["JOB_PAGE_EXPIRED", "JOB_PAGE_LISTING", "JOB_PAGE_LOGIN_REQUIRED", "JOB_PAGE_UNRECOGNIZED", "POLICY_REJECTED"]);
  expect(facts.leads.filter((lead) => lead.state === "rejected").every((lead) => lead.source_posting_version_id === null)).toBe(true);
  expect(facts.attributions).toHaveLength(2);
  const sharedVersionId = verifiedLeads[0]!.source_posting_version_id;
  expect(verifiedLeads.every((lead) => lead.source_posting_version_id === sharedVersionId)).toBe(true);
  for (const lead of verifiedLeads) expect(facts.attributions).toContainEqual(expect.objectContaining({ lead_id: lead.id, query_id: lead.query_id, source_posting_version_id: sharedVersionId }));
  expect(facts.postings).toHaveLength(1);
  expect(facts.postings.every((posting) => posting.canonical_matches === true && posting.final_matches === true)).toBe(true);
  expect(facts.postings).toEqual([expect.objectContaining({
    source_identifier: createHash("sha256").update(expectedVerifiedCanonicalUrl, "utf8").digest("hex"),
    is_official: true,
    canonical_matches: true,
    final_matches: true,
  })]);
  expect(facts.versions).toHaveLength(1);
  expect(facts.versions[0]).toMatchObject({ has_raw_object_reference: true, normalized_data_safe: true });
  expect(facts.opportunities).toHaveLength(1);
  expect(facts.opportunities[0]?.source_posting_version_id).toBe(sharedVersionId);
  expect(facts.results).toEqual([expect.objectContaining({ source_posting_version_id: sharedVersionId, ordinal: 1 })]);
  expect(facts.attentions).toHaveLength(1);
  expect(audit.map((entry) => entry.operation)).toEqual(expect.arrayContaining(["search", "extract", "page"]));
  for (const fixture of ["verified_alias", "expired", "login", "listing", "insufficient"]) {
    const extractedAt = audit.findIndex((entry) => entry.operation === "extract" && entry.fixture === fixture);
    const pagedAt = audit.findIndex((entry) => entry.operation === "page" && entry.fixture === fixture);
    expect(extractedAt).toBeGreaterThan(-1);
    expect(pagedAt).toBeGreaterThan(extractedAt);
  }
  const aliasPageAt = audit.findIndex((entry) => entry.operation === "page" && entry.fixture === "verified_alias");
  const canonicalPageAt = audit.findIndex((entry) => entry.operation === "page" && entry.fixture === "verified");
  expect(audit.findIndex((entry) => entry.operation === "extract" && entry.fixture === "verified")).toBeGreaterThan(-1);
  expect(canonicalPageAt).toBeGreaterThan(aliasPageAt);
  const policyExtractedAt = audit.findIndex((entry) => entry.operation === "extract" && entry.fixture === "policy");
  const targetSearchAt = audit.findIndex((entry) => entry.operation === "search" && entry.fixture === "target_company");
  expect(policyExtractedAt).toBeGreaterThan(targetSearchAt);
  expect(audit.some((entry) => entry.operation === "page" && entry.fixture === "policy")).toBe(false);
  expect(audit.filter((entry) => entry.operation === "page").every((entry) => ["verified_alias", "verified", "expired", "login", "listing", "insufficient"].includes(entry.fixture ?? ""))).toBe(true);
  const queue = new Queue("agent-runs", { connection: { host: "127.0.0.1", port: redisPort } });
  try {
    const duplicate = await queue.add("discover-jobs", { version: 1, runId, userId: account.userId }, { jobId: `${runId}-duplicate`, attempts: 3, removeOnComplete: false, removeOnFail: true });
    await expect.poll(async () => (await queue.getJob(duplicate.id!))?.returnvalue, { timeout: 15_000 }).toBe("stale");
    await duplicate.remove();
  } finally {
    await queue.close();
  }
  expect(await persistedFacts(account.userId, runId)).toEqual(facts);
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
  const factsWithTestOnlyPlaceholder = { ...facts, testOnlyPlaceholder: "fake-anysearch-public-job-test-key" };
  expect(JSON.stringify({ run, facts: factsWithTestOnlyPlaceholder }).includes("fake-anysearch-public-job-test-key")).toBe(false);
  await page.reload();
  const attention = page.locator(".agent-inbox-panel").getByRole("link", { name: "查看本次运行诊断" });
  await expect(attention).toHaveAttribute("href", `/home?runId=${runId}#agent-run`);
});
