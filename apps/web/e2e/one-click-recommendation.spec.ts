import { Client } from "pg";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { JobNormalizerOutputSchema } from "@job-copilot/contracts/job-imports";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";
const devAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const scenarioKeys = {
  "Desktop Chrome": {
    full: "10000000-0000-4000-8000-000000000171",
    empty: "10000000-0000-4000-8000-000000000172",
  },
  "Mobile Safari": {
    full: "10000000-0000-4000-8000-000000000173",
    empty: "10000000-0000-4000-8000-000000000174",
  },
} as const;

const completeSourceInput = JobNormalizerOutputSchema.parse({
  normalizerVersion: "e2e-recommendation-source-input-v1",
  company: "曙光云图",
  title: "高级前端工程师",
  location: "上海",
  postedAt: "2026-08-20T00:00:00.000Z",
  deadline: "2030-12-31T00:00:00.000Z",
  deadlineProvenance: null,
  description: "为可验证的求职工作台交付 TypeScript 前端功能。",
  qualifications: {
    workMode: { value: "remote", evidence: { field: "workMode", path: "工作方式", value: "远程" } },
    relocationRequired: { value: false, evidence: { field: "relocationRequired", path: "是否需要搬迁", value: "否" } },
    salary: { value: { minimum: 30_000, maximum: 45_000, currency: "CNY", period: "month" }, evidence: { field: "salary", path: "薪资", value: "CNY 30000-45000/month" } },
    seniority: null,
    education: { value: "本科", evidence: { field: "education", path: "学历", value: "本科" } },
    languages: { value: [{ name: "英语", level: "C1" }], evidence: { field: "languages", path: "语言", value: "英语(C1)" } },
    workEligibility: { value: "中国工作许可", evidence: { field: "workEligibility", path: "工作资格", value: "中国工作许可" } },
    industry: { value: "云计算", evidence: { field: "industry", path: "行业", value: "云计算" } },
    employmentType: { value: "direct", evidence: { field: "employmentType", path: "雇佣类型", value: "直接雇佣" } },
    requiredSkills: { value: ["TypeScript"], evidence: { field: "requiredSkills", path: "必备技能", value: "TypeScript" } },
  },
});

type Account = { token: string; userId: string; targetId: string };
type RecommendationRun = {
  runId: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  result: null | { kind: "recommendation_list"; resultId: string; recommendationListId: string; itemCount: number; evidence: RecommendationEvidence } | { kind: "no_recommendations"; resultId: string; evidence: RecommendationEvidence };
  failure: unknown;
};
type RecommendationEvidence = {
  discovery: { discoveredJobCount: number };
  sourceCoverage: { checkedBranchCount: number; credibleBranchCount: number; verifiedJobCount: number };
  qualification: { evaluatedCount: number; insufficientInformationCount: number };
  coarseRanking: { eligibleCount: number; deepMatchCandidateCount: number };
  deepMatching: { evaluatedCount: number; finalRecommendationCount: number };
  coverageLosses: unknown[];
};
type SideFacts = {
  careerDocuments: unknown; careerImports: unknown; jobProfiles: unknown; profileFacts: unknown; profileFactRevisions: unknown;
  candidateFactDecisions: unknown; jobTargets: unknown; jobTargetRevisions: unknown; recommendationDecisionEvents: unknown;
};
type RunGraph = {
  rootCount: number; childCount: number; resultCount: number; listCount: number; itemCount: number; inboxCount: number; journeyCompletionCount: number;
  childParentMatches: boolean; resultProducerMatches: boolean; journeyOwnerRootChildMatches: boolean;
};

function auth(token: string) { return { authorization: `Bearer ${token}` }; }
function scenarioKey(info: TestInfo, scenario: "full" | "empty") { return scenarioKeys[info.project.name as keyof typeof scenarioKeys][scenario]; }
function fixtureName(info: TestInfo, scenario: "full" | "empty") { return `e2e_one_click_${info.project.name === "Desktop Chrome" ? "desktop" : "mobile"}_${scenario}`; }
function sqlLiteral(value: string) { return `'${value.replaceAll("'", "''")}'`; }

async function createAccount(request: APIRequestContext, info: TestInfo, scenario: "full" | "empty"): Promise<Account> {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": devAuthSecret }, data: { subject: `one-click-${scenario}-${info.project.name}-${runSuffix}` },
  });
  expect(session.status()).toBe(201);
  const body = await session.json() as { sessionToken: string; account: { userId: string } };
  const facts = [
    { factType: "education", factValue: { summary: "本科" } },
    { factType: "language", factValue: { name: "英语", level: "C1" } },
    { factType: "work_eligibility", factValue: { summary: "中国工作许可" } },
    { factType: "skill", factValue: { name: "TypeScript" } },
    { factType: "experience", factValue: { summary: "前端工程实践经验" } },
    { factType: "project", factValue: { summary: "可验证的交付项目" } },
  ];
  for (const [expectedVersion, fact] of facts.entries()) {
    const response = await request.post(`${apiBaseUrl}/v1/profile/facts`, { headers: auth(body.sessionToken), data: { expectedVersion, ...fact } });
    expect(response.status()).toBe(201);
  }
  const target = await request.post(`${apiBaseUrl}/v1/job-targets`, { headers: auth(body.sessionToken), data: {
    priority: "primary",
    constraints: {
      roleFamily: scenario === "full" ? "前端" : "数据治理", seniority: null, locations: ["上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [],
      dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
    },
  } });
  expect(target.status()).toBe(201);
  const overview = await target.json() as { targets: Array<{ targetId: string; priority: string }> };
  const targetId = overview.targets.find((item) => item.priority === "primary")!.targetId;
  const watchlist = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items`, { headers: auth(body.sessionToken), data: {
    expectedVersion: 0, canonicalCompanyName: `One Click ${scenario} Fixture`, careersUrl: `https://boards.greenhouse.io/one-click-${scenario}-fixture`,
    allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null,
  } });
  expect(watchlist.status()).toBe(201);
  const diagnostic = await request.post(`${apiBaseUrl}/v1/model-diagnostics`, { headers: auth(body.sessionToken), data: {} });
  expect(diagnostic.status()).toBe(201);
  await expect(diagnostic.json()).resolves.toMatchObject({ status: "available" });
  return { token: body.sessionToken, userId: body.account.userId, targetId };
}

async function setSessionCookie(page: Page, token: string): Promise<void> {
  await page.context().addCookies([{ name: "job_copilot_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
}

async function installFirstRandomUuid(page: Page, value: string): Promise<void> {
  const install = (fixed: string) => {
    const original = crypto.randomUUID.bind(crypto);
    const marker = `job-copilot:e2e-one-click-random-uuid:${fixed}`;
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

async function installSourceInputFixture(input: { name: string; userId: string; targetId: string; idempotencyKey: string }): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const payload = JSON.stringify(completeSourceInput);
    await client.query(`
      create or replace function ${input.name}_source_input() returns trigger language plpgsql as $$
      begin
        if exists (
          select 1 from agent_runs root
          where root.id = new.run_id
            and root.user_id = ${sqlLiteral(input.userId)}::uuid
            and root.target_id = ${sqlLiteral(input.targetId)}::uuid
            and root.idempotency_key = ${sqlLiteral(input.idempotencyKey)}::uuid
            and root.run_purpose = 'recommendation'
            and root.parent_run_id is null
        ) then
          update job_source_posting_versions
          set normalized_data = normalized_data || ${sqlLiteral(payload)}::jsonb
          where user_id = new.user_id and id = new.source_posting_version_id;
        end if;
        return new;
      end;
      $$;
      create trigger ${input.name}_source_input_trigger
      after insert on agent_run_job_results
      for each row execute function ${input.name}_source_input();
    `);
  } finally { await client.end(); }
}

async function removeSourceInputFixture(name: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`drop trigger if exists ${name}_source_input_trigger on agent_run_job_results; drop function if exists ${name}_source_input()`);
  } finally { await client.end(); }
}

async function sideFacts(userId: string, targetId: string): Promise<SideFacts> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`
      select
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'checksumSha256', checksum_sha256, 'objectKey', object_key, 'mediaType', media_type, 'byteSize', byte_size) order by id) from career_documents where user_id = $1), '[]'::jsonb) as career_documents,
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'careerDocumentId', career_document_id, 'status', status, 'attemptCount', attempt_count, 'failureCode', failure_code, 'originatingRequestId', originating_request_id) order by id) from career_imports where user_id = $1), '[]'::jsonb) as career_imports,
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'version', version) order by id) from job_profiles where user_id = $1), '[]'::jsonb) as job_profiles,
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'profileId', profile_id, 'factType', fact_type) order by id) from profile_facts where user_id = $1), '[]'::jsonb) as profile_facts,
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'profileFactId', profile_fact_id, 'revisionNumber', revision_number, 'profileVersion', profile_version, 'factType', fact_type, 'factValue', fact_value, 'state', state, 'source', source, 'candidateFactId', candidate_fact_id) order by id) from profile_fact_revisions where user_id = $1), '[]'::jsonb) as profile_fact_revisions,
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'profileId', profile_id, 'candidateFactId', candidate_fact_id, 'decision', decision, 'profileFactRevisionId', profile_fact_revision_id, 'profileVersion', profile_version) order by id) from candidate_fact_decisions where user_id = $1), '[]'::jsonb) as candidate_fact_decisions,
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'version', version, 'priority', priority, 'state', state, 'activeSlot', active_slot) order by id) from job_targets where user_id = $1 and id = $2), '[]'::jsonb) as job_targets,
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'targetId', target_id, 'version', version, 'priority', priority, 'state', state, 'constraints', constraints) order by id) from job_target_revisions where user_id = $1 and target_id = $2), '[]'::jsonb) as job_target_revisions,
        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'targetId', target_id, 'recommendationListId', recommendation_list_id, 'recommendationListItemId', recommendation_list_item_id, 'matchVersionId', match_version_id, 'decision', decision, 'reason', reason, 'note', note, 'expectedVersion', expected_version, 'version', version) order by id) from recommendation_decision_events where user_id = $1), '[]'::jsonb) as recommendation_decision_events
    `, [userId, targetId]);
    const row = result.rows[0]!;
    return {
      careerDocuments: row.career_documents, careerImports: row.career_imports, jobProfiles: row.job_profiles, profileFacts: row.profile_facts,
      profileFactRevisions: row.profile_fact_revisions, candidateFactDecisions: row.candidate_fact_decisions, jobTargets: row.job_targets,
      jobTargetRevisions: row.job_target_revisions, recommendationDecisionEvents: row.recommendation_decision_events,
    };
  } finally { await client.end(); }
}

async function runGraph(userId: string, rootRunId: string): Promise<RunGraph> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`
      select
        (select count(*) from agent_runs root where root.user_id = $1 and root.id = $2 and root.run_purpose = 'recommendation' and root.parent_run_id is null) as root_count,
        (select count(*) from agent_runs child where child.user_id = $1 and child.parent_run_id = $2 and child.workflow_version = 'deep-match-v1') as child_count,
        (select count(*) from recommendation_results result where result.user_id = $1 and result.root_run_id = $2) as result_count,
        (select count(*) from recommendation_lists list join recommendation_results result on result.user_id = list.user_id and result.recommendation_list_id = list.id where result.user_id = $1 and result.root_run_id = $2) as list_count,
        (select count(*) from recommendation_list_items item join recommendation_results result on result.user_id = item.user_id and result.recommendation_list_id = item.recommendation_list_id where result.user_id = $1 and result.root_run_id = $2) as item_count,
        (select count(*) from agent_inbox_items inbox join recommendation_results result on result.user_id = inbox.user_id and (inbox.recommendation_result_id = result.id or inbox.recommendation_list_id = result.recommendation_list_id) where result.user_id = $1 and result.root_run_id = $2) as inbox_count,
        (select count(*) from first_recommendation_journey_completions completion join recommendation_results result on result.user_id = completion.user_id and ((completion.result_kind = 'recommendation_list' and result.kind = 'recommendation_list' and completion.result_id = result.recommendation_list_id) or (completion.result_kind = 'no_recommendations' and result.kind = 'no_recommendations' and completion.result_id = result.id)) join agent_runs child on child.user_id = result.user_id and child.id = result.producer_run_id where completion.user_id = $1 and result.root_run_id = $2 and child.parent_run_id = $2 and child.workflow_version = 'deep-match-v1') as journey_completion_count,
        exists(select 1 from agent_runs child where child.user_id = $1 and child.parent_run_id = $2 and child.workflow_version = 'deep-match-v1') as child_parent_matches,
        exists(select 1 from recommendation_results result join agent_runs child on child.user_id = result.user_id and child.id = result.producer_run_id where result.user_id = $1 and result.root_run_id = $2 and child.parent_run_id = $2) as result_producer_matches,
        exists(select 1 from first_recommendation_journey_completions completion join recommendation_results result on result.user_id = completion.user_id and ((completion.result_kind = 'recommendation_list' and result.kind = 'recommendation_list' and completion.result_id = result.recommendation_list_id) or (completion.result_kind = 'no_recommendations' and result.kind = 'no_recommendations' and completion.result_id = result.id)) join agent_runs child on child.user_id = result.user_id and child.id = result.producer_run_id where completion.user_id = $1 and result.root_run_id = $2 and child.parent_run_id = $2 and child.workflow_version = 'deep-match-v1') as journey_owner_root_child_matches
    `, [userId, rootRunId]);
    const row = result.rows[0]!;
    return {
      rootCount: Number(row.root_count), childCount: Number(row.child_count), resultCount: Number(row.result_count), listCount: Number(row.list_count), itemCount: Number(row.item_count), inboxCount: Number(row.inbox_count), journeyCompletionCount: Number(row.journey_completion_count), childParentMatches: row.child_parent_matches, resultProducerMatches: row.result_producer_matches, journeyOwnerRootChildMatches: row.journey_owner_root_child_matches,
    };
  } finally { await client.end(); }
}

async function preparation(request: APIRequestContext, token: string) {
  const response = await request.get(`${apiBaseUrl}/v1/recommendation-runs/preparation`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  return await response.json() as { preparation: { preflight: { status: "ready" | "ready_with_warnings" | "blocked" } } };
}

async function startFromHome(page: Page, request: APIRequestContext, account: Account, idempotencyKey: string): Promise<string> {
  const ready = await preparation(request, account.token);
  expect(ready.preparation.preflight.status).not.toBe("blocked");
  await setSessionCookie(page, account.token);
  await page.goto("/home");
  await installFirstRandomUuid(page, idempotencyKey);
  const start = page.getByRole("button", { name: "开始今日发现" });
  await expect(start).toBeEnabled();
  if (ready.preparation.preflight.status === "ready_with_warnings") {
    await start.click();
    const confirm = page.getByRole("button", { name: "我已了解，开始今日发现" });
    await expect(confirm).toBeVisible();
    const startedRequest = page.waitForRequest((value) => value.url().endsWith("/api/recommendation-runs") && value.method() === "POST");
    const startedResponse = page.waitForResponse((value) => value.url().endsWith("/api/recommendation-runs") && value.request().method() === "POST");
    await confirm.click();
    expect((await startedRequest).postDataJSON()).toMatchObject({ idempotencyKey });
    const response = await startedResponse;
    expect(response.status()).toBe(201);
    return ((await response.json()) as { run: { runId: string } }).run.runId;
  }
  const startedRequest = page.waitForRequest((value) => value.url().endsWith("/api/recommendation-runs") && value.method() === "POST");
  const startedResponse = page.waitForResponse((value) => value.url().endsWith("/api/recommendation-runs") && value.request().method() === "POST");
  await start.click();
  expect((await startedRequest).postDataJSON()).toMatchObject({ idempotencyKey });
  const response = await startedResponse;
  expect(response.status()).toBe(201);
  return ((await response.json()) as { run: { runId: string } }).run.runId;
}

async function completedRun(request: APIRequestContext, token: string, rootRunId: string): Promise<RecommendationRun> {
  let finalRun: RecommendationRun | undefined;
  await expect.poll(async () => {
    const response = await request.get(`${apiBaseUrl}/v1/recommendation-runs/${rootRunId}`, { headers: auth(token) });
    expect(response.status()).toBe(200);
    finalRun = await response.json() as RecommendationRun;
    return finalRun.status;
  }, { timeout: 60_000 }).toBe("completed");
  expect(finalRun?.result).not.toBeNull();
  expect(finalRun?.failure).toBeNull();
  return finalRun!;
}

test("完整来源输入经真实推荐启动、worker 与发布链交付一条推荐", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const account = await createAccount(request, info, "full");
  const idempotencyKey = scenarioKey(info, "full");
  const name = fixtureName(info, "full");
  const before = await sideFacts(account.userId, account.targetId);
  try {
    await installSourceInputFixture({ name, userId: account.userId, targetId: account.targetId, idempotencyKey });
    const rootRunId = await startFromHome(page, request, account, idempotencyKey);
    const run = await completedRun(request, account.token, rootRunId);
    expect(run.result).toMatchObject({ kind: "recommendation_list", itemCount: 1, evidence: { discovery: { discoveredJobCount: 1 }, qualification: { evaluatedCount: 1, insufficientInformationCount: 0 }, coarseRanking: { eligibleCount: 1, deepMatchCandidateCount: 1 }, deepMatching: { evaluatedCount: 1, finalRecommendationCount: 1 } } });
    const result = run.result!;
    if (result.kind !== "recommendation_list") throw new Error("EXPECTED_RECOMMENDATION_LIST");
    await expect.poll(() => runGraph(account.userId, rootRunId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, inboxCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });
    await page.goto(`/recommendations?runId=${rootRunId}&resultId=${result.resultId}`);
    await expect(page.getByRole("heading", { name: "本次推荐已准备好" })).toBeVisible();
    await expect(page.getByRole("list", { name: "推荐岗位" })).toContainText("高级前端工程师");
    expect(await sideFacts(account.userId, account.targetId)).toEqual(before);
  } finally { await removeSourceInputFixture(name); }
});

test("可信空来源回执经真实推荐启动、worker 与发布链交付暂无推荐", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const account = await createAccount(request, info, "empty");
  const before = await sideFacts(account.userId, account.targetId);
  const rootRunId = await startFromHome(page, request, account, scenarioKey(info, "empty"));
  const run = await completedRun(request, account.token, rootRunId);
  expect(run.result).toMatchObject({ kind: "no_recommendations", evidence: { discovery: { discoveredJobCount: 0 }, sourceCoverage: { verifiedJobCount: 0 }, qualification: { evaluatedCount: 0, insufficientInformationCount: 0 }, coarseRanking: { eligibleCount: 0, deepMatchCandidateCount: 0 }, deepMatching: { evaluatedCount: 0, finalRecommendationCount: 0 }, coverageLosses: [] } });
  expect(run.result?.evidence.sourceCoverage.credibleBranchCount).toBeGreaterThan(0);
  expect(run.result?.evidence.sourceCoverage.checkedBranchCount).toBe(run.result?.evidence.sourceCoverage.credibleBranchCount);
  const result = run.result!;
  if (result.kind !== "no_recommendations") throw new Error("EXPECTED_NO_RECOMMENDATIONS");
  await expect.poll(() => runGraph(account.userId, rootRunId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, childCount: 1, resultCount: 1, listCount: 0, itemCount: 0, inboxCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });
  await page.goto(`/recommendations?runId=${rootRunId}&resultId=${result.resultId}`);
  await expect(page.getByRole("heading", { name: "今天暂无推荐" })).toBeVisible();
  await expect(page.getByRole("list", { name: "推荐岗位" })).toHaveCount(0);
  expect(await sideFacts(account.userId, account.targetId)).toEqual(before);
});
