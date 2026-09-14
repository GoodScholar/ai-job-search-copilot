import { Client } from "pg";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { AGENT_RUN_QUEUE } from "@job-copilot/contracts/agent-runs";
import { JobNormalizerOutputSchema } from "@job-copilot/contracts/job-imports";
import { Queue } from "bullmq";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";
const devAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const redisPort = Number(process.env.E2E_REDIS_PORT ?? "64790");
const sourceHealthOnly = process.env.E2E_SOURCE_HEALTH_ONLY === "1";

const scenarioKeys = {
  "Desktop Chrome": {
    full: "10000000-0000-4000-8000-000000000171",
    empty: "10000000-0000-4000-8000-000000000172",
    duplicate: "10000000-0000-4000-8000-000000000175",
    duplicateConcurrent: "10000000-0000-4000-8000-000000000176",
    duplicateConcurrentOther: "10000000-0000-4000-8000-000000000183",
    recovery: "10000000-0000-4000-8000-000000000177",
    partial: "10000000-0000-4000-8000-000000000181",
    globalStopA: "10000000-0000-4000-8000-000000000185",
    globalStopB: "10000000-0000-4000-8000-000000000186",
  },
  "Mobile Safari": {
    full: "10000000-0000-4000-8000-000000000173",
    empty: "10000000-0000-4000-8000-000000000174",
    duplicate: "10000000-0000-4000-8000-000000000178",
    duplicateConcurrent: "10000000-0000-4000-8000-000000000179",
    duplicateConcurrentOther: "10000000-0000-4000-8000-000000000184",
    recovery: "10000000-0000-4000-8000-000000000180",
    partial: "10000000-0000-4000-8000-000000000182",
    globalStopA: "10000000-0000-4000-8000-000000000187",
    globalStopB: "10000000-0000-4000-8000-000000000188",
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

const publicSourceHealthInput = JobNormalizerOutputSchema.parse({
  ...completeSourceInput,
  normalizerVersion: "e2e-one-click-public-source-health-v1",
  company: "One Click partial healthy",
  title: "Engineer",
  location: "Beijing",
  description: "Engineer role with TypeScript delivery requirements from the controlled source input.",
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
  ownerTargetRootCount: number; ownerTargetRootIds: string[];
};
type OperationalFacts = { auditEventTypes: string[]; usage: Array<{ runId: string; category: string; stepKey: string | null }> };
type Scenario = "full" | "empty" | "partial";

function auth(token: string) { return { authorization: `Bearer ${token}` }; }
function scenarioKey(info: TestInfo, scenario: keyof typeof scenarioKeys["Desktop Chrome"]) { return scenarioKeys[info.project.name as keyof typeof scenarioKeys][scenario]; }
function fixtureName(info: TestInfo, scenario: "full" | "partial" | "duplicate" | "recovery" | "global_stop_a" | "global_stop_b") { return `e2e_one_click_${info.project.name === "Desktop Chrome" ? "desktop" : "mobile"}_${scenario}`; }
function sqlLiteral(value: string) { return `'${value.replaceAll("'", "''")}'`; }

async function createAccount(request: APIRequestContext, info: TestInfo, scenario: Scenario, accountIdentity: string = scenario): Promise<Account> {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": devAuthSecret }, data: { subject: `one-click-${scenario}-${accountIdentity}-${info.project.name}-${runSuffix}` },
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
      roleFamily: scenario === "full" ? "前端" : scenario === "empty" ? "数据治理" : "Engineer", seniority: null, locations: [scenario === "partial" ? "Beijing" : "上海"], workModes: ["remote"], relocation: "not_willing", salary: null, industries: [],
      dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
    },
  } });
  expect(target.status()).toBe(201);
  const overview = await target.json() as { targets: Array<{ targetId: string; priority: string }> };
  const targetId = overview.targets.find((item) => item.priority === "primary")!.targetId;
  const sources = scenario === "partial"
    ? ["good", "limited"].map((kind) => ({ canonicalCompanyName: `One Click partial ${kind}`, careersUrl: `https://boards.greenhouse.io/e2e-one-click-${info.project.name === "Desktop Chrome" ? "desktop" : "mobile"}-${kind}` }))
    : [{ canonicalCompanyName: `One Click ${scenario} Fixture`, careersUrl: `https://boards.greenhouse.io/one-click-${scenario}-fixture` }];
  for (const [expectedVersion, source] of sources.entries()) {
    const watchlist = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items`, { headers: auth(body.sessionToken), data: {
      expectedVersion, ...source, allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null,
    } });
    expect(watchlist.status()).toBe(201);
  }
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

async function installSourceInputFixture(input: { name: string; userId: string; targetId: string; idempotencyKey: string; normalizedData?: typeof completeSourceInput }): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const payload = JSON.stringify(input.normalizedData ?? completeSourceInput);
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

async function runGraph(userId: string, rootRunId: string, targetId: string): Promise<RunGraph> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`
      select
        (select count(*) from agent_runs root where root.user_id = $1 and root.id = $2 and root.run_purpose = 'recommendation' and root.parent_run_id is null) as root_count,
        (select count(*) from agent_runs root where root.user_id = $1 and root.target_id = $3 and root.run_purpose = 'recommendation' and root.parent_run_id is null) as owner_target_root_count,
        coalesce((select array_agg(root.id::text order by root.id) from agent_runs root where root.user_id = $1 and root.target_id = $3 and root.run_purpose = 'recommendation' and root.parent_run_id is null), array[]::text[]) as owner_target_root_ids,
        (select count(*) from agent_runs child where child.user_id = $1 and child.parent_run_id = $2 and child.workflow_version = 'deep-match-v1') as child_count,
        (select count(*) from recommendation_results result where result.user_id = $1 and result.root_run_id = $2) as result_count,
        (select count(*) from recommendation_lists list join recommendation_results result on result.user_id = list.user_id and result.recommendation_list_id = list.id where result.user_id = $1 and result.root_run_id = $2) as list_count,
        (select count(*) from recommendation_list_items item join recommendation_results result on result.user_id = item.user_id and result.recommendation_list_id = item.recommendation_list_id where result.user_id = $1 and result.root_run_id = $2) as item_count,
        (select count(*) from agent_inbox_items inbox join recommendation_results result on result.user_id = inbox.user_id and (inbox.recommendation_result_id = result.id or inbox.recommendation_list_id = result.recommendation_list_id) where result.user_id = $1 and result.root_run_id = $2) as inbox_count,
        (select count(*) from first_recommendation_journey_completions completion join recommendation_results result on result.user_id = completion.user_id and ((completion.result_kind = 'recommendation_list' and result.kind = 'recommendation_list' and completion.result_id = result.recommendation_list_id) or (completion.result_kind = 'no_recommendations' and result.kind = 'no_recommendations' and completion.result_id = result.id)) join agent_runs child on child.user_id = result.user_id and child.id = result.producer_run_id where completion.user_id = $1 and result.root_run_id = $2 and child.parent_run_id = $2 and child.workflow_version = 'deep-match-v1') as journey_completion_count,
        exists(select 1 from agent_runs child where child.user_id = $1 and child.parent_run_id = $2 and child.workflow_version = 'deep-match-v1') as child_parent_matches,
        exists(select 1 from recommendation_results result join agent_runs child on child.user_id = result.user_id and child.id = result.producer_run_id where result.user_id = $1 and result.root_run_id = $2 and child.parent_run_id = $2) as result_producer_matches,
        exists(select 1 from first_recommendation_journey_completions completion join recommendation_results result on result.user_id = completion.user_id and ((completion.result_kind = 'recommendation_list' and result.kind = 'recommendation_list' and completion.result_id = result.recommendation_list_id) or (completion.result_kind = 'no_recommendations' and result.kind = 'no_recommendations' and completion.result_id = result.id)) join agent_runs child on child.user_id = result.user_id and child.id = result.producer_run_id where completion.user_id = $1 and result.root_run_id = $2 and child.parent_run_id = $2 and child.workflow_version = 'deep-match-v1') as journey_owner_root_child_matches
    `, [userId, rootRunId, targetId]);
    const row = result.rows[0]!;
    return {
      rootCount: Number(row.root_count), ownerTargetRootCount: Number(row.owner_target_root_count), ownerTargetRootIds: row.owner_target_root_ids, childCount: Number(row.child_count), resultCount: Number(row.result_count), listCount: Number(row.list_count), itemCount: Number(row.item_count), inboxCount: Number(row.inbox_count), journeyCompletionCount: Number(row.journey_completion_count), childParentMatches: row.child_parent_matches, resultProducerMatches: row.result_producer_matches, journeyOwnerRootChildMatches: row.journey_owner_root_child_matches,
    };
  } finally { await client.end(); }
}

async function operationalFacts(userId: string, rootRunId: string): Promise<OperationalFacts> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const [audit, usage] = await Promise.all([
      client.query(`
        select event_type from audit_events
        where user_id = $1 and resource_type = 'agent_run'
          and resource_id in (select id from agent_runs where user_id = $1 and (id = $2 or parent_run_id = $2))
        order by occurred_at, id
      `, [userId, rootRunId]),
      client.query(`
        select run_id, category, step_key from agent_run_usage_entries
        where user_id = $1 and run_id in (select id from agent_runs where user_id = $1 and (id = $2 or parent_run_id = $2))
        order by run_id, category, usage_key
      `, [userId, rootRunId]),
    ]);
    return { auditEventTypes: audit.rows.map((row) => row.event_type), usage: usage.rows.map((row) => ({ runId: row.run_id, category: row.category, stepKey: row.step_key })) };
  } finally { await client.end(); }
}

function assertOperationalFacts(facts: OperationalFacts): void {
  expect(facts.auditEventTypes).toEqual(expect.arrayContaining(["agent.run_queued", "agent.run_completed"]));
  expect(facts.usage.some((entry) => entry.category === "source_request")).toBe(true);
}

async function preparation(request: APIRequestContext, token: string) {
  const response = await request.get(`${apiBaseUrl}/v1/recommendation-runs/preparation`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  return await response.json() as { preparation: { preflight: { status: "ready" | "ready_with_warnings" | "blocked" } } };
}

type BrowserPreparation = { preflight: { status: "ready" | "ready_with_warnings" | "blocked"; warningFingerprint: string | null; items: Array<{ code: string }> } };
type StartResponse = { run: RecommendationRun; reused: boolean };

async function browserPreparation(page: Page): Promise<BrowserPreparation> {
  const response = await page.request.get("/api/recommendation-runs/preparation");
  expect(response.status()).toBe(200);
  return await response.json() as BrowserPreparation;
}

async function browserStart(page: Page, ready: BrowserPreparation, idempotencyKey: string): Promise<{ status: number; payload: StartResponse }> {
  expect(ready.preflight.status).not.toBe("blocked");
  const warningFingerprint = ready.preflight.status === "ready_with_warnings" ? ready.preflight.warningFingerprint : null;
  const response = await page.request.post("/api/recommendation-runs", { data: { idempotencyKey, warningFingerprint } });
  expect([200, 201]).toContain(response.status());
  const payload = await response.json() as StartResponse;
  expect(payload).toMatchObject({ run: { runId: expect.any(String) }, reused: expect.any(Boolean) });
  return { status: response.status(), payload };
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
    const runId = ((await response.json()) as { run: { runId: string } }).run.runId;
    await page.waitForURL((url) => url.pathname === "/home" && url.searchParams.get("runId") === runId);
    return runId;
  }
  const startedRequest = page.waitForRequest((value) => value.url().endsWith("/api/recommendation-runs") && value.method() === "POST");
  const startedResponse = page.waitForResponse((value) => value.url().endsWith("/api/recommendation-runs") && value.request().method() === "POST");
  await start.click();
  expect((await startedRequest).postDataJSON()).toMatchObject({ idempotencyKey });
  const response = await startedResponse;
  expect(response.status()).toBe(201);
  const runId = ((await response.json()) as { run: { runId: string } }).run.runId;
  await page.waitForURL((url) => url.pathname === "/home" && url.searchParams.get("runId") === runId);
  return runId;
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

async function recommendationRun(request: APIRequestContext, token: string, rootRunId: string): Promise<RecommendationRun> {
  const response = await request.get(`${apiBaseUrl}/v1/recommendation-runs/${rootRunId}`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  return response.json() as Promise<RecommendationRun>;
}

async function accountRunControl(request: APIRequestContext, token: string): Promise<{ stoppedAt: string | null; controlVersion: number; scheduleResumeAfter: string | null }> {
  const response = await request.get(`${apiBaseUrl}/v1/account/run-policy/control`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  return response.json() as Promise<{ stoppedAt: string | null; controlVersion: number; scheduleResumeAfter: string | null }>;
}

async function recommendationListSnapshot(request: APIRequestContext, token: string, targetId: string, listId: string): Promise<unknown> {
  const response = await request.get(`${apiBaseUrl}/v1/recommendations/lists/${listId}?targetId=${targetId}`, { headers: auth(token) });
  expect(response.status()).toBe(200);
  return response.json();
}

async function recommendationControlBinding(userId: string, rootRunId: string, commandId: string): Promise<{ rootRunId: string; physicalRunId: string; action: string; applied: boolean; physicalParentRunId: string | null }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(`
      select logical.root_run_id, logical.physical_run_id, logical.action, physical.applied, run.parent_run_id
      from recommendation_run_control_commands logical
      join agent_run_control_commands physical on physical.user_id = logical.user_id and physical.run_id = logical.physical_run_id and physical.command_id = logical.command_id
      join agent_runs run on run.user_id = logical.user_id and run.id = logical.physical_run_id
      where logical.user_id = $1 and logical.root_run_id = $2 and logical.command_id = $3
    `, [userId, rootRunId, commandId]);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    return { rootRunId: row.root_run_id, physicalRunId: row.physical_run_id, action: row.action, applied: row.applied, physicalParentRunId: row.parent_run_id };
  } finally { await client.end(); }
}

test("完整来源输入经真实推荐启动、worker 与发布链交付一条推荐", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  test.skip(sourceHealthOnly, "完整来源输入仅在 ordinary phase 运行");
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
    await expect.poll(() => runGraph(account.userId, rootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, inboxCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });
    assertOperationalFacts(await operationalFacts(account.userId, rootRunId));
    await page.goto(`/recommendations?runId=${rootRunId}&resultId=${result.resultId}`);
    await expect(page.getByRole("heading", { name: "本次推荐已准备好" })).toBeVisible();
    await expect(page.getByRole("list", { name: "推荐岗位" })).toContainText("高级前端工程师");
    expect(await sideFacts(account.userId, account.targetId)).toEqual(before);
  } finally { await removeSourceInputFixture(name); }
});

test("可信空来源回执经真实推荐启动、worker 与发布链交付暂无推荐", async ({ page, request }, info) => {
  test.setTimeout(90_000);
  test.skip(sourceHealthOnly, "可信空来源仅在 ordinary phase 运行");
  const account = await createAccount(request, info, "empty");
  const before = await sideFacts(account.userId, account.targetId);
  const rootRunId = await startFromHome(page, request, account, scenarioKey(info, "empty"));
  const run = await completedRun(request, account.token, rootRunId);
  expect(run.result).toMatchObject({ kind: "no_recommendations", evidence: { discovery: { discoveredJobCount: 0 }, sourceCoverage: { verifiedJobCount: 0 }, qualification: { evaluatedCount: 0, insufficientInformationCount: 0 }, coarseRanking: { eligibleCount: 0, deepMatchCandidateCount: 0 }, deepMatching: { evaluatedCount: 0, finalRecommendationCount: 0 }, coverageLosses: [] } });
  expect(run.result?.evidence.sourceCoverage.credibleBranchCount).toBeGreaterThan(0);
  expect(run.result?.evidence.sourceCoverage.checkedBranchCount).toBe(run.result?.evidence.sourceCoverage.credibleBranchCount);
  const result = run.result!;
  if (result.kind !== "no_recommendations") throw new Error("EXPECTED_NO_RECOMMENDATIONS");
  await expect.poll(() => runGraph(account.userId, rootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, childCount: 1, resultCount: 1, listCount: 0, itemCount: 0, inboxCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });
  assertOperationalFacts(await operationalFacts(account.userId, rootRunId));
  await page.goto(`/recommendations?runId=${rootRunId}&resultId=${result.resultId}`);
  await expect(page.getByRole("heading", { name: "今天暂无推荐" })).toBeVisible();
  await expect(page.getByRole("list", { name: "推荐岗位" })).toHaveCount(0);
  expect(await sideFacts(account.userId, account.targetId)).toEqual(before);
});

test("同一会话的同键重放与不同键并发只保留一个推荐 root", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  test.skip(sourceHealthOnly, "重复启动仅在 ordinary phase 运行");
  const account = await createAccount(request, info, "full", "duplicate");
  const key = scenarioKey(info, "duplicate");
  const name = fixtureName(info, "duplicate");
  const before = await sideFacts(account.userId, account.targetId);
  const queue = new Queue(AGENT_RUN_QUEUE, { connection: { host: "127.0.0.1", port: redisPort } });
  let paused = false;
  try {
    await installSourceInputFixture({ name, userId: account.userId, targetId: account.targetId, idempotencyKey: key });
    await setSessionCookie(page, account.token);
    await queue.pause();
    paused = true;
    const ready = await browserPreparation(page);
    const [first, replay] = await Promise.all([browserStart(page, ready, key), browserStart(page, ready, key)]);
    expect([first.status, replay.status].sort()).toEqual([200, 201]);
    expect(first.payload.run.runId).toBe(replay.payload.run.runId);
    expect([first.payload.reused, replay.payload.reused].filter(Boolean)).toHaveLength(1);
    const rootRunId = first.payload.run.runId;
    const [concurrentA, concurrentB] = await Promise.all([
      browserStart(page, ready, scenarioKey(info, "duplicateConcurrent")),
      browserStart(page, ready, scenarioKey(info, "duplicateConcurrentOther")),
    ]);
    expect(concurrentA.status).toBe(200);
    expect(concurrentB.status).toBe(200);
    expect(concurrentA.payload).toMatchObject({ reused: true, run: { runId: rootRunId, status: "queued" } });
    expect(concurrentB.payload).toMatchObject({ reused: true, run: { runId: rootRunId, status: "queued" } });
    await expect.poll(() => runGraph(account.userId, rootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, ownerTargetRootCount: 1, ownerTargetRootIds: [rootRunId], childCount: 0, resultCount: 0, listCount: 0, itemCount: 0, inboxCount: 0 });
    await queue.resume();
    paused = false;
    const run = await completedRun(request, account.token, rootRunId);
    expect(run.result).toMatchObject({ kind: "recommendation_list", itemCount: 1 });
    await expect.poll(() => runGraph(account.userId, rootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, ownerTargetRootCount: 1, ownerTargetRootIds: [rootRunId], childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, inboxCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });
    const afterComplete = await browserStart(page, ready, key);
    expect(afterComplete).toMatchObject({ status: 200, payload: { reused: true, run: { runId: rootRunId, result: { kind: "recommendation_list" } } } });
    expect(await runGraph(account.userId, rootRunId, account.targetId)).toMatchObject({ rootCount: 1, ownerTargetRootCount: 1, ownerTargetRootIds: [rootRunId], childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, inboxCount: 1 });
    await page.goto(`/home?runId=${rootRunId}`);
    await expect(page.locator(".recommendation-run-panel [role=status]")).toContainText("本次推荐已准备完成");
    await expect(page.getByRole("link", { name: "查看本次推荐" })).toHaveAttribute("href", new RegExp(`^/recommendations\\?runId=${rootRunId}&resultId=${afterComplete.payload.run.result!.resultId}#recommendation-result$`));
    assertOperationalFacts(await operationalFacts(account.userId, rootRunId));
    expect(await sideFacts(account.userId, account.targetId)).toEqual(before);
  } finally {
    if (paused) await queue.resume();
    await queue.close();
    await removeSourceInputFixture(name);
  }
});

test("离页后以精确 root SSR 恢复并继续同一推荐运行", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  test.skip(sourceHealthOnly, "离页恢复仅在 ordinary phase 运行");
  const account = await createAccount(request, info, "full", "recovery");
  const key = scenarioKey(info, "recovery");
  const name = fixtureName(info, "recovery");
  const before = await sideFacts(account.userId, account.targetId);
  const queue = new Queue(AGENT_RUN_QUEUE, { connection: { host: "127.0.0.1", port: redisPort } });
  let paused = false;
  let postCount = 0;
  page.on("request", (value) => { if (value.url().endsWith("/api/recommendation-runs") && value.method() === "POST") postCount += 1; });
  try {
    await installSourceInputFixture({ name, userId: account.userId, targetId: account.targetId, idempotencyKey: key });
    await queue.pause();
    paused = true;
    const rootRunId = await startFromHome(page, request, account, key);
    await expect.poll(async () => (await request.get(`${apiBaseUrl}/v1/recommendation-runs/${rootRunId}`, { headers: auth(account.token) })).status()).toBe(200);
    await page.goto("/profile/targets");
    const recoveredRead = page.waitForRequest((value) => value.url().includes(`/api/recommendation-runs/${rootRunId}`) && value.method() === "GET");
    await page.goto(`/home?runId=${rootRunId}`);
    await recoveredRead;
    await expect(page.locator(".recommendation-run-panel [role=status]")).toContainText("已提交，等待开始");
    expect(postCount).toBe(1);
    await page.goto("/profile/targets");
    await queue.resume();
    paused = false;
    const run = await completedRun(request, account.token, rootRunId);
    expect(run.result).toMatchObject({ kind: "recommendation_list", itemCount: 1 });
    await page.goto(`/home?runId=${rootRunId}`);
    await expect(page.locator(".recommendation-run-panel [role=status]")).toContainText("本次推荐已准备完成", { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "发布结果" })).toBeVisible();
    await expect(page.locator('[aria-label="完整推荐阶段"] [data-status="completed"]')).toHaveCount(5);
    expect(postCount).toBe(1);
    await expect.poll(() => runGraph(account.userId, rootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, ownerTargetRootCount: 1, ownerTargetRootIds: [rootRunId], childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, inboxCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });
    assertOperationalFacts(await operationalFacts(account.userId, rootRunId));
    expect(await sideFacts(account.userId, account.targetId)).toEqual(before);
  } finally {
    if (paused) await queue.resume();
    await queue.close();
    await removeSourceInputFixture(name);
  }
});

test("同一账户全局停止保留历史 A，解除后只由用户继续 B", async ({ page, request }, info) => {
  test.setTimeout(150_000);
  test.skip(sourceHealthOnly, "全局停止旅程仅在 ordinary phase 运行");
  const account = await createAccount(request, info, "full", "global-stop");
  const aKey = scenarioKey(info, "globalStopA");
  const bKey = scenarioKey(info, "globalStopB");
  const aFixture = fixtureName(info, "global_stop_a");
  const bFixture = fixtureName(info, "global_stop_b");
  const before = await sideFacts(account.userId, account.targetId);
  const queue = new Queue(AGENT_RUN_QUEUE, { connection: { host: "127.0.0.1", port: redisPort } });
  let aFixtureInstalled = false;
  let bFixtureInstalled = false;
  let paused = false;
  let trackAfterRelease = false;
  let bRootRunId = "";
  const afterReleaseStartPosts: string[] = [];
  const afterReleaseBControlPosts: string[] = [];
  page.on("request", (value) => {
    if (!trackAfterRelease || value.method() !== "POST") return;
    const pathname = new URL(value.url()).pathname;
    if (pathname === "/api/recommendation-runs") afterReleaseStartPosts.push(value.url());
    if (pathname === `/api/recommendation-runs/${bRootRunId}/controls`) afterReleaseBControlPosts.push(value.url());
  });
  try {
    aFixtureInstalled = true;
    await installSourceInputFixture({ name: aFixture, userId: account.userId, targetId: account.targetId, idempotencyKey: aKey });
    const aRootRunId = await startFromHome(page, request, account, aKey);
    const aRun = await completedRun(request, account.token, aRootRunId);
    expect(aRun.result).toMatchObject({ kind: "recommendation_list", itemCount: 1 });
    if (aRun.result?.kind !== "recommendation_list") throw new Error("EXPECTED_A_RECOMMENDATION_LIST");
    const aListSnapshot = await recommendationListSnapshot(request, account.token, account.targetId, aRun.result.recommendationListId);
    await expect.poll(() => runGraph(account.userId, aRootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, ownerTargetRootCount: 1, ownerTargetRootIds: [aRootRunId], childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });
    assertOperationalFacts(await operationalFacts(account.userId, aRootRunId));
    await page.goto(`/recommendations?runId=${aRootRunId}&resultId=${aRun.result.resultId}`);
    await expect(page.getByRole("heading", { name: "本次推荐已准备好" })).toBeVisible();
    await expect(page.getByRole("list", { name: "推荐岗位" })).toContainText("高级前端工程师");

    bFixtureInstalled = true;
    await installSourceInputFixture({ name: bFixture, userId: account.userId, targetId: account.targetId, idempotencyKey: bKey });
    await queue.pause();
    paused = true;
    bRootRunId = await startFromHome(page, request, account, bKey);
    await expect.poll(async () => (await recommendationRun(request, account.token, bRootRunId)).status).toBe("queued");
    await expect.poll(() => runGraph(account.userId, bRootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, ownerTargetRootCount: 2, ownerTargetRootIds: [aRootRunId, bRootRunId].sort(), childCount: 0, resultCount: 0, listCount: 0, itemCount: 0 });

    await page.goto("/profile/run-policy");
    const stopResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/account/run-policy/controls" && response.request().method() === "POST");
    await page.getByRole("button", { name: "停止全部运行" }).click();
    expect((await stopResponse).status()).toBe(200);
    await expect.poll(() => accountRunControl(request, account.token)).toMatchObject({ stoppedAt: expect.any(String), controlVersion: 1 });
    await expect.poll(() => browserPreparation(page)).toMatchObject({ preflight: { status: "blocked", items: expect.arrayContaining([expect.objectContaining({ code: "ACCOUNT_RUN_POLICY_BLOCKED" })]) } });

    await expect.poll(async () => (await recommendationRun(request, account.token, bRootRunId)).status, { timeout: 30_000 }).toBe("paused");
    await page.goto(`/home?runId=${bRootRunId}`);
    const panel = page.locator(".recommendation-run-panel");
    await expect(panel.getByRole("status")).toContainText("本次推荐已暂停");
    await expect(panel.getByRole("button", { name: "本次推荐已暂停" })).toBeDisabled();
    await expect(panel.getByRole("link", { name: "查看运行设置" })).toHaveAttribute("href", "/profile/run-policy");
    await queue.resume();
    paused = false;
    const blockedResumeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/recommendation-runs/${bRootRunId}/controls` && response.request().method() === "POST");
    await panel.getByRole("button", { name: "继续本次推荐" }).click();
    expect((await blockedResumeResponse).status()).toBe(409);
    await expect(panel.getByRole("status")).toContainText("账户已停止全部运行");

    await page.goto(`/recommendations?runId=${aRootRunId}&resultId=${aRun.result.resultId}`);
    await expect(page.getByRole("heading", { name: "本次推荐已准备好" })).toBeVisible();
    await expect(page.getByRole("list", { name: "推荐岗位" })).toContainText("高级前端工程师");
    expect(await recommendationListSnapshot(request, account.token, account.targetId, aRun.result.recommendationListId)).toEqual(aListSnapshot);
    expect(await runGraph(account.userId, aRootRunId, account.targetId)).toMatchObject({ rootCount: 1, ownerTargetRootCount: 2, ownerTargetRootIds: [aRootRunId, bRootRunId].sort(), childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });

    trackAfterRelease = true;
    await page.goto("/profile/run-policy");
    const releaseResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/account/run-policy/controls" && response.request().method() === "POST");
    await page.getByRole("button", { name: "解除全局停止" }).click();
    expect((await releaseResponse).status()).toBe(200);
    await expect.poll(() => accountRunControl(request, account.token)).toMatchObject({ stoppedAt: null, controlVersion: 2 });
    await page.goto(`/home?runId=${bRootRunId}`);
    await expect(panel.getByRole("status")).toContainText("本次推荐已暂停");
    expect(afterReleaseStartPosts).toEqual([]);
    expect(afterReleaseBControlPosts).toEqual([]);
    expect(await recommendationRun(request, account.token, bRootRunId)).toMatchObject({ status: "paused", result: null, failure: null });
    expect(await runGraph(account.userId, bRootRunId, account.targetId)).toMatchObject({ rootCount: 1, ownerTargetRootCount: 2, ownerTargetRootIds: [aRootRunId, bRootRunId].sort(), childCount: 0, resultCount: 0, listCount: 0, itemCount: 0, journeyCompletionCount: 0 });
    expect(await recommendationListSnapshot(request, account.token, account.targetId, aRun.result.recommendationListId)).toEqual(aListSnapshot);

    trackAfterRelease = false;
    const resumeRequest = page.waitForRequest((value) => new URL(value.url()).pathname === `/api/recommendation-runs/${bRootRunId}/controls` && value.method() === "POST");
    const resumeResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/recommendation-runs/${bRootRunId}/controls` && response.request().method() === "POST");
    await panel.getByRole("button", { name: "继续本次推荐" }).click();
    const resumeCommand = (await resumeRequest).postDataJSON() as { commandId: string; action: string };
    expect(resumeCommand.action).toBe("resume");
    expect((await resumeResponse).status()).toBe(200);
    await expect.poll(() => recommendationControlBinding(account.userId, bRootRunId, resumeCommand.commandId), { timeout: 20_000 }).toMatchObject({ rootRunId: bRootRunId, physicalRunId: bRootRunId, physicalParentRunId: null, action: "resume", applied: true });
    const bRun = await completedRun(request, account.token, bRootRunId);
    expect(bRun.result).toMatchObject({ kind: "recommendation_list", itemCount: 1 });
    await expect.poll(() => runGraph(account.userId, bRootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, ownerTargetRootCount: 2, ownerTargetRootIds: [aRootRunId, bRootRunId].sort(), childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, journeyCompletionCount: 0, childParentMatches: true, resultProducerMatches: true });
    const bFacts = await operationalFacts(account.userId, bRootRunId);
    assertOperationalFacts(bFacts);
    expect(bFacts.auditEventTypes).toEqual(expect.arrayContaining(["agent.run_paused", "agent.run_resumed"]));
    expect(await runGraph(account.userId, aRootRunId, account.targetId)).toMatchObject({ rootCount: 1, ownerTargetRootCount: 2, ownerTargetRootIds: [aRootRunId, bRootRunId].sort(), childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, journeyCompletionCount: 1, journeyOwnerRootChildMatches: true });
    expect(await recommendationListSnapshot(request, account.token, account.targetId, aRun.result.recommendationListId)).toEqual(aListSnapshot);
    expect(await sideFacts(account.userId, account.targetId)).toEqual(before);
  } finally {
    if (paused) await queue.resume();
    await queue.close();
    if (bFixtureInstalled) await removeSourceInputFixture(bFixture);
    if (aFixtureInstalled) await removeSourceInputFixture(aFixture);
  }
});

test("一个可信来源交付且一个限流来源失败时发布带非零覆盖损失的结论", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  test.skip(!sourceHealthOnly, "部分来源失败仅在 source-health phase 运行");
  const account = await createAccount(request, info, "partial");
  const key = scenarioKey(info, "partial");
  const name = fixtureName(info, "partial");
  const before = await sideFacts(account.userId, account.targetId);
  try {
    await installSourceInputFixture({ name, userId: account.userId, targetId: account.targetId, idempotencyKey: key, normalizedData: publicSourceHealthInput });
    const rootRunId = await startFromHome(page, request, account, key);
    const run = await completedRun(request, account.token, rootRunId);
    expect(run.result).toMatchObject({ kind: "recommendation_list", itemCount: 1, evidence: { discovery: { discoveredJobCount: 1 }, sourceCoverage: { checkedBranchCount: 2, credibleBranchCount: 1, verifiedJobCount: 1 }, coverageLosses: [expect.objectContaining({ affectedCount: 1 })] } });
    expect(run.result?.evidence.coverageLosses).toHaveLength(1);
    const result = run.result!;
    if (result.kind !== "recommendation_list") throw new Error("EXPECTED_PARTIAL_RECOMMENDATION_LIST");
    await expect.poll(() => runGraph(account.userId, rootRunId, account.targetId), { timeout: 20_000 }).toMatchObject({ rootCount: 1, childCount: 1, resultCount: 1, listCount: 1, itemCount: 1, inboxCount: 1, journeyCompletionCount: 1, childParentMatches: true, resultProducerMatches: true, journeyOwnerRootChildMatches: true });
    await page.goto(`/home?runId=${rootRunId}`);
    await expect(page.locator(".recommendation-run-panel [role=status]")).toContainText("本次推荐已准备完成");
    await page.goto(`/recommendations?runId=${rootRunId}&resultId=${result.resultId}`);
    await expect(page.getByText("来源健康度下降：影响 1 项来源检查，可稍后重试")).toBeVisible();
    assertOperationalFacts(await operationalFacts(account.userId, rootRunId));
    expect(await sideFacts(account.userId, account.targetId)).toEqual(before);
  } finally { await removeSourceInputFixture(name); }
});
