import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { Client } from "pg";
import { expect, test, type APIRequestContext, type TestInfo } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const secret = "issue-2-e2e-dev-auth-shared-secret";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";

async function createWarningAccount(request: APIRequestContext, info: TestInfo): Promise<{ token: string; userId: string; targetId: string; itemId: string; sourceId: string }> {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject: `run-preflight-stale-${info.project.name}-${Date.now()}` } });
  const value = await session.json() as { sessionToken: string; account: { userId: string } };
  expect(session.status()).toBe(201);
  const fact = await request.post(`${apiBaseUrl}/v1/profile/facts`, { headers: { authorization: `Bearer ${value.sessionToken}` }, data: { expectedVersion: 0, factType: "skill", factValue: { name: "TypeScript" } } });
  expect(fact.status()).toBe(201);
  const target = await request.post(`${apiBaseUrl}/v1/job-targets`, { headers: { authorization: `Bearer ${value.sessionToken}` }, data: { priority: "primary", constraints: { roleFamily: "AI 应用工程师", seniority: "高级", locations: ["上海"], workModes: ["hybrid"], relocation: "conditional", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } } } });
  expect(target.status()).toBe(201);
  const targetId = (await target.json() as { targets: Array<{ targetId: string; priority: string }> }).targets.find((item) => item.priority === "primary")!.targetId;
  const sourceId = `greenhouse:e2e-preflight-${info.project.name === "Desktop Chrome" ? "desktop" : "mobile"}`;
  const source = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items`, { headers: { authorization: `Bearer ${value.sessionToken}` }, data: { expectedVersion: 0, canonicalCompanyName: "Preflight Health Fixture", careersUrl: `https://boards.greenhouse.io/${sourceId.slice("greenhouse:".length)}`, allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
  expect(source.status()).toBe(201);
  const itemId = (await source.json() as { items: Array<{ itemId: string }> }).items[0]!.itemId;
  const diagnostic = await request.post(`${apiBaseUrl}/v1/model-diagnostics`, { headers: { authorization: `Bearer ${value.sessionToken}` }, data: {} });
  expect(diagnostic.status()).toBe(201);
  await expect(diagnostic.json()).resolves.toMatchObject({ status: "available" });
  return { token: value.sessionToken, userId: value.account.userId, targetId, itemId, sourceId };
}

async function createActiveTarget(request: APIRequestContext, token: string, priority: "primary" | "secondary", roleFamily: string): Promise<string> {
  const target = await request.post(`${apiBaseUrl}/v1/job-targets`, { headers: { authorization: `Bearer ${token}` }, data: { priority, constraints: { roleFamily, seniority: "高级", locations: ["上海"], workModes: ["hybrid"], relocation: "conditional", salary: null, industries: [], dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] } } } });
  expect(target.status()).toBe(201);
  return (await target.json() as { targets: Array<{ targetId: string; priority: string }> }).targets.find((item) => item.priority === priority)!.targetId;
}

test("新账户在工作台看到可修复的运行前阻塞，且不会创建运行", async ({ page, request }) => {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject: `run-preflight-${test.info().project.name}-${Date.now()}` } });
  expect(session.status()).toBe(201);
  const { sessionToken } = await session.json() as { sessionToken: string };
  await page.context().addCookies([{ name: "job_copilot_session", value: sessionToken, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/home");

  const preflight = page.getByRole("region", { name: "运行前检查" });
  await expect(preflight).toBeVisible();
  await expect(preflight.getByText("暂不能启动")).toBeVisible();
  await expect(preflight.getByRole("link", { name: "完善求职画像" })).toHaveAttribute("href", "/profile");
  await expect(page.getByRole("button", { name: "发现岗位" })).toHaveCount(0);
  await page.getByRole("link", { name: "完善求职画像" }).focus();
  await expect(page.getByRole("link", { name: "完善求职画像" })).toBeFocused();
  await page.screenshot({ path: path.resolve(process.cwd(), "../..", ".impeccable/review", `issue-51-after-${test.info().project.name === "Desktop Chrome" ? "desktop" : "mobile"}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  await expect(new AxeBuilder({ page }).include("main").analyze()).resolves.toMatchObject({ violations: [] });
});

test("新账户按画像、主目标、真实来源和模型诊断逐项解除阻塞，并始终给出固定修复路由", async ({ page, request }, info) => {
  const session = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject: `run-preflight-progression-${info.project.name}-${Date.now()}` } });
  expect(session.status()).toBe(201);
  const { sessionToken } = await session.json() as { sessionToken: string };
  const authorization = { authorization: `Bearer ${sessionToken}` };
  await page.context().addCookies([{ name: "job_copilot_session", value: sessionToken, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);

  await page.goto("/home");
  const preflight = page.getByRole("region", { name: "运行前检查" });
  await expect(preflight.getByRole("link", { name: "完善求职画像" })).toHaveAttribute("href", "/profile");

  const fact = await request.post(`${apiBaseUrl}/v1/profile/facts`, { headers: authorization, data: { expectedVersion: 0, factType: "skill", factValue: { name: "TypeScript" } } });
  expect(fact.status()).toBe(201);
  await page.reload();
  await expect(preflight.getByRole("link", { name: "查看求职目标" }).first()).toHaveAttribute("href", "/profile/targets");

  const targetId = await createActiveTarget(request, sessionToken, "primary", "平台工程师");
  await page.reload();
  await expect(preflight.getByRole("link", { name: "查看来源能力" })).toHaveAttribute("href", `/profile/targets/${targetId}/watchlist#source-capabilities`);

  const source = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items`, { headers: authorization, data: { expectedVersion: 0, canonicalCompanyName: "Progression Greenhouse Fixture", careersUrl: `https://boards.greenhouse.io/progression-${info.project.name === "Desktop Chrome" ? "desktop" : "mobile"}`, allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
  expect(source.status()).toBe(201);
  const reportResponse = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${targetId}`, { headers: authorization });
  expect(reportResponse.status()).toBe(200);
  const report = await reportResponse.json() as { items: Array<{ code: string }> };
  const modelBlocked = report.items.some((item) => item.code === "MODEL_DIAGNOSTIC_UNAVAILABLE");
  await page.reload();
  const diagnosticLink = preflight.getByRole("link", { name: "检查模型连接" });
  // 诊断记录以部署指纹共享；串行 worker 的第二个浏览器项目会继承第一个项目的真实稳定结果。
  if (modelBlocked) await expect(diagnosticLink).toHaveAttribute("href", "/profile/model-connection");
  else await expect(preflight.getByText("模型诊断已就绪")).toBeVisible();

  const diagnostic = await request.post(`${apiBaseUrl}/v1/model-diagnostics`, { headers: authorization, data: {} });
  expect(diagnostic.status()).toBe(201);
  await expect(diagnostic.json()).resolves.toMatchObject({ status: "available" });
  await page.reload();
  await expect(preflight.getByText("启动前需要你确认")).toBeVisible();
  await expect(preflight.getByRole("link", { name: "查看来源健康" })).toHaveAttribute("href", `/profile/targets/${targetId}/watchlist#source-health`);
  await expect(page.getByRole("button", { name: "发现岗位" })).toBeEnabled();
});

test("正式 health fixture 使旧 warning 过期，页面刷新后以同一 key 再确认", async ({ page, request }, info) => {
  const account = await createWarningAccount(request, info);
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  const initial = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${account.targetId}`, { headers: { authorization: `Bearer ${account.token}` } });
  const old = await initial.json() as { warningFingerprint: string; items: Array<{ code: string }> };
  expect(old.items.map((item) => item.code)).toContain("SOURCE_HEALTH_UNCHECKED");
  await page.goto("/home"); await page.getByRole("button", { name: "发现岗位" }).click();
  const bootstrap = await request.post(`${apiBaseUrl}/v1/agent-runs`, { headers: { authorization: `Bearer ${account.token}` }, data: { targetId: account.targetId, idempotencyKey: "10000000-0000-4000-8000-000000000302", warningFingerprint: old.warningFingerprint } });
  expect(bootstrap.status()).toBe(201);
  const { runId } = await bootstrap.json() as { runId: string };
  const client = new Client({ connectionString: databaseUrl }); await client.connect();
  try { await client.query("insert into job_source_health_checks (id, user_id, run_id, target_id, watchlist_item_id, source_id, status, reason_codes, impact_scope, impact_affected_count, observed_posting_count, selected_detail_count, valid_detail_count, request_attempt_count, checked_at) values (gen_random_uuid(), $1, $2, $3, $4, $5, 'rate_limited', '[\"SOURCE_RATE_LIMITED\"]'::jsonb, 'entire_source', null, 0, 0, 0, 1, now()) on conflict (run_id, source_id) do update set user_id = excluded.user_id, target_id = excluded.target_id, watchlist_item_id = excluded.watchlist_item_id, status = excluded.status, reason_codes = excluded.reason_codes, impact_scope = excluded.impact_scope, impact_affected_count = excluded.impact_affected_count, observed_posting_count = excluded.observed_posting_count, selected_detail_count = excluded.selected_detail_count, valid_detail_count = excluded.valid_detail_count, request_attempt_count = excluded.request_attempt_count, checked_at = excluded.checked_at", [account.userId, runId, account.targetId, account.itemId, account.sourceId]); } finally { await client.end(); }
  const currentReport = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${account.targetId}`, { headers: { authorization: `Bearer ${account.token}` } });
  const current = await currentReport.json() as { warningFingerprint: string; items: Array<{ code: string }> };
  expect(current.items.map((item) => item.code)).toContain("SOURCE_HEALTH_DEGRADED"); expect(current.warningFingerprint).not.toBe(old.warningFingerprint);
  const stale = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "我已了解，仍要启动" }).click();
  const staleResponse = await stale; expect(staleResponse.status()).toBe(409);
  const key = staleResponse.request().postDataJSON().idempotencyKey;
  await expect(page.getByText("启动条件已变化，请查看最新检查后再次确认。")).toBeVisible();
  await page.getByRole("button", { name: "发现岗位" }).click();
  const confirmed = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "我已了解，仍要启动" }).click();
  const confirmedResponse = await confirmed; expect(confirmedResponse.status()).toBe(201); expect(confirmedResponse.request().postDataJSON()).toMatchObject({ idempotencyKey: key, warningFingerprint: current.warningFingerprint });
});

test("活动主次目标切换期间禁用启动，完成后只采用所选目标的正式报告", async ({ page, request }, info) => {
  const account = await createWarningAccount(request, info);
  const secondaryId = await createActiveTarget(request, account.token, "secondary", "数据平台工程师");
  const secondarySource = await request.post(`${apiBaseUrl}/v1/job-targets/${secondaryId}/company-watchlist/items`, { headers: { authorization: `Bearer ${account.token}` }, data: { expectedVersion: 0, canonicalCompanyName: "Secondary Target Fixture", careersUrl: `https://boards.greenhouse.io/secondary-${info.project.name === "Desktop Chrome" ? "desktop" : "mobile"}`, allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"], sourceNote: null } });
  expect(secondarySource.status()).toBe(201);
  await page.context().addCookies([{ name: "job_copilot_session", value: account.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/home");
  const target = page.getByRole("combobox", { name: "用于发现岗位的求职目标" });
  await expect(target).toHaveValue(account.targetId);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/run-preflight?targetId=${secondaryId}`, async (route) => {
    const response = await route.fetch();
    await delayed;
    await route.fulfill({ response });
  });
  await target.selectOption(secondaryId);
  await expect(page.getByRole("button", { name: "发现岗位" })).toBeDisabled();
  await expect(page.getByText("正在刷新所选求职目标的启动条件。")).toBeVisible();
  const refreshed = page.waitForResponse((response) => response.url().endsWith(`/api/run-preflight?targetId=${secondaryId}`));
  release();
  const report = await (await refreshed).json() as { targetId: string };
  expect(report.targetId).toBe(secondaryId);
  await expect(target).toHaveValue(secondaryId);
  await expect(page.getByRole("button", { name: "发现岗位" })).toBeEnabled();
});

test("账户 B 不能从工作台或正式报告读取账户 A 的目标和来源证据", async ({ page, request }, info) => {
  const accountA = await createWarningAccount(request, info);
  const accountB = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, { headers: { "x-dev-auth-secret": secret }, data: { subject: `run-preflight-isolation-${info.project.name}-${Date.now()}` } });
  expect(accountB.status()).toBe(201);
  const { sessionToken } = await accountB.json() as { sessionToken: string };
  const foreignTargetReport = await request.get(`${apiBaseUrl}/v1/run-preflight?workflow=discovery&trigger=manual&targetId=${accountA.targetId}`, { headers: { authorization: `Bearer ${sessionToken}` } });
  expect(foreignTargetReport.status()).toBe(200);
  const report = await foreignTargetReport.json() as { targetId: string | null; items: Array<{ evidence: unknown }> };
  expect(report.targetId).toBeNull();
  expect(JSON.stringify(report.items)).not.toContain("Preflight Health Fixture");
  await page.context().addCookies([{ name: "job_copilot_session", value: sessionToken, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/home");
  await expect(page.getByText("Preflight Health Fixture")).toHaveCount(0);
  await expect(page.getByText("AI 应用工程师 · 主目标")).toHaveCount(0);
});
