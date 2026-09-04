import AxeBuilder from "@axe-core/playwright";
import { Queue } from "bullmq";
import { Client } from "pg";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3121";
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgresql://job_copilot:local_only_job_copilot@127.0.0.1:55420/job_copilot";
const testDevAuthSecret = "issue-2-e2e-dev-auth-shared-secret";
const redisPort = Number(process.env.E2E_REDIS_PORT ?? "64790");
const runSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type LatestResponse = { run: null | { runId: string; status: string; adapter: string; results?: unknown[] } };

async function createSession(request: APIRequestContext, subject: string): Promise<{ token: string; userId: string }> {
  const response = await request.post(`${apiBaseUrl}/v1/auth/dev/sessions`, {
    headers: { "x-dev-auth-secret": testDevAuthSecret }, data: { subject },
  });
  expect(response.status()).toBe(201);
  const session = await response.json() as { sessionToken: string; account: { userId: string } };
  return { token: session.sessionToken, userId: session.account.userId };
}

async function createActiveTarget(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.post(`${apiBaseUrl}/v1/job-targets`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      priority: "primary",
      constraints: {
        roleFamily: "AI 应用工程师", seniority: "高级", locations: ["北京", "深圳"], workModes: ["hybrid"], relocation: "conditional",
        salary: { minimum: 30000, maximum: 45000, period: "month", currency: "CNY" }, industries: [],
        dealBreakers: { excludedCompanies: [], excludedIndustries: [], excludeOutsourcing: false, excludeDispatch: false, excludeHeadhunter: false, other: [] },
      },
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json() as { targets: Array<{ targetId: string; priority: string }> }).targets.find((target) => target.priority === "primary")!.targetId;
}

async function addExecutableWatchlistSource(request: APIRequestContext, token: string, targetId: string): Promise<void> {
  const response = await request.post(`${apiBaseUrl}/v1/job-targets/${targetId}/company-watchlist/items`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      expectedVersion: 0,
      canonicalCompanyName: "Scheduled Fake Fixture",
      careersUrl: "https://boards.greenhouse.io/scheduled-fake-fixture",
      allowedDomains: ["boards.greenhouse.io", "boards-api.greenhouse.io"],
      sourceNote: null,
    },
  });
  expect(response.status()).toBe(201);
}

/** E2E helper deliberately advances only the persisted schedule clock; it never inserts occurrences or runs. */
async function fastForwardSchedule(scheduleId: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query("update job_discovery_schedules set next_run_at = now() - interval '1 second' where id = $1", [scheduleId]);
    expect(result.rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

async function latest(page: Page): Promise<LatestResponse> {
  const response = await page.request.get("/api/agent-runs");
  expect(response.status()).toBe(200);
  return await response.json() as LatestResponse;
}

test("每日检查通过 Fake Worker 交付一组岗位，并抵抗重复 Worker delivery", async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const session = await createSession(request, `scheduled-job-discovery-${testInfo.project.name}-${runSuffix}`);
  const targetId = await createActiveTarget(request, session.token);
  await addExecutableWatchlistSource(request, session.token, targetId);
  await page.context().addCookies([{ name: "job_copilot_session", value: session.token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/home");

  await expect(page.getByRole("heading", { name: "每天检查新岗位" })).toBeVisible();
  await expect(page.getByText("可每日检查 1 个岗位来源")).toBeVisible();
  const time = page.getByLabel("每日检查时间（北京时间 / Asia/Shanghai）");
  expect(await time.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  for (const name of ["启用", "停用", "保存每日检查"]) {
    expect(await page.getByRole("button", { name }).evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  await time.fill("09:30");
  const enable = page.getByRole("button", { name: "启用" });
  if (testInfo.project.name === "Desktop Chrome") {
    await enable.focus();
    await expect(enable).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    await enable.click();
  }
  const saveResponse = page.waitForResponse((response) => response.url().includes(`/api/job-targets/${targetId}/discovery-schedule`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存每日检查" }).click();
  await expect(page.getByRole("region", { name: "每天检查新岗位" }).getByRole("status")).toContainText("每日检查已保存。");
  expect((await saveResponse).status()).toBe(200);
  const scheduleResponse = await page.request.get(`/api/job-targets/${targetId}/discovery-schedule`);
  expect(scheduleResponse.status()).toBe(200);
  const schedule = await scheduleResponse.json() as { schedule: { scheduleId: string; state: string } | null };
  expect(schedule.schedule).toMatchObject({ state: "enabled", scheduleId: expect.any(String) });
  const queue = new Queue("agent-runs", { connection: { host: "127.0.0.1", port: redisPort } });
  let queued!: NonNullable<LatestResponse["run"]>;
  try {
    await queue.pause();
    await fastForwardSchedule(schedule.schedule!.scheduleId);

    await expect.poll(async () => {
      const current = await latest(page);
      if (current.run?.status === "queued") queued = current.run;
      return current.run?.status;
    }, { timeout: 25_000 }).toBe("queued");
    expect(queued).toMatchObject({ adapter: "fake" });

    const sseRequest = page.waitForRequest((request) => request.url().includes(`/api/agent-runs/${queued.runId}/events?afterEventId=`));
    await page.reload();
    expect((await sseRequest).url()).toContain(`/api/agent-runs/${queued.runId}/events?afterEventId=`);
    await expect(page.locator(".agent-run-panel [role=status]")).toContainText("岗位发现已排队");
    await queue.resume();

    // 恢复队列后由同一 SSE 页面推进完成；此处不 reload。
    await expect(page.locator(".agent-run-panel [role=status]")).toContainText("岗位发现完成", { timeout: 25_000 });
    await expect(page.getByRole("heading", { name: "本次发现的岗位" })).toBeVisible();
    await expect(page.locator(".agent-run-results li")).toHaveCount(2);
    await expect(page.locator(".agent-run-results")).toContainText("AI 应用工程师");

    const duplicate = await queue.add("discover-jobs", { version: 1, runId: queued.runId, userId: session.userId }, {
      jobId: queued.runId, attempts: 3, removeOnComplete: false, removeOnFail: true,
    });
    await expect.poll(async () => (await queue.getJob(duplicate.id!))?.returnvalue, { timeout: 15_000 }).toBe("stale");
    await duplicate.remove();
  } finally {
    await queue.resume().catch(() => undefined);
    await queue.close();
  }
  await page.goto(`/home?runId=${queued.runId}#agent-run`);
  await expect(page.getByRole("heading", { name: "发现新的岗位机会" })).toBeVisible();
  await expect(page.locator(".agent-run-results li")).toHaveCount(2);

  const controls = page.locator(".agent-run-panel .workbench-touch-target");
  expect(await controls.count()).toBeGreaterThan(0);
  expect(await controls.evaluateAll((elements) => elements.every((element) => element.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
