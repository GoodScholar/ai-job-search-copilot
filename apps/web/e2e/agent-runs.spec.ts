import AxeBuilder from "@axe-core/playwright";
import type { AgentInboxItem } from "@job-copilot/contracts/agent-inbox";
import { AGENT_RUN_QUEUE, type AgentRunDetail } from "@job-copilot/contracts/agent-runs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { Queue } from "bullmq";

const desktopScenarios = {
  pause: "10000000-0000-4000-8000-000000000101",
  cancel: "10000000-0000-4000-8000-000000000102",
  retryOnce: "10000000-0000-4000-8000-000000000103",
  retryBudget: "10000000-0000-4000-8000-000000000104",
} as const;
const mobileScenarios: Record<keyof typeof desktopScenarios, string> = {
  pause: "10000000-0000-4000-8000-000000000111",
  cancel: "10000000-0000-4000-8000-000000000112",
  retryOnce: "10000000-0000-4000-8000-000000000113",
  retryBudget: "10000000-0000-4000-8000-000000000114",
};
const redisPort = Number(process.env.E2E_REDIS_PORT ?? "64790");

function scenarioFor(testInfo: TestInfo, scenario: keyof typeof desktopScenarios): string {
  return (testInfo.project.name === "Mobile Safari" ? mobileScenarios : desktopScenarios)[scenario];
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?returnTo=%2Fprofile%2Ftargets");
  await page.getByRole("button", { name: "使用本地体验账户登录" }).click();
  await expect(page).toHaveURL(/\/profile\/targets$/);
}

async function replaceActiveTarget(page: Page): Promise<void> {
  while (await page.getByRole("button", { name: /^停用 / }).count()) {
    await page.getByRole("button", { name: /^停用 / }).first().click();
    await expect(page.getByRole("status")).toHaveText("求职目标已停用。");
  }
  await page.getByLabel("目标岗位方向").fill("AI 应用工程师");
  await page.getByLabel("意向地点（用逗号分隔）").fill("北京, 深圳");
  await page.getByLabel("工作方式").selectOption(["hybrid", "remote"]);
  await page.getByRole("button", { name: "保存主目标" }).click();
  await expect(page.getByRole("status")).toHaveText("求职目标已保存。");
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

async function startScenario(page: Page, testInfo: TestInfo, idempotencyKey: string): Promise<string> {
  await signIn(page);
  await replaceActiveTarget(page);
  await installFirstRandomUuid(page, idempotencyKey);
  await page.getByRole("link", { name: "AI Job Search Copilot" }).click();
  await expect(page).toHaveURL(/\/home$/);
  const requestPromise = page.waitForRequest((request) => request.url().endsWith("/api/agent-runs") && request.method() === "POST");
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/agent-runs") && response.request().method() === "POST");
  const start = page.getByRole("button", { name: "发现岗位" });
  if (testInfo.project.name === "Mobile Safari") await start.tap();
  else await start.click();
  expect((await requestPromise).postDataJSON()).toMatchObject({ idempotencyKey });
  return ((await (await responsePromise).json()) as { runId: string }).runId;
}

async function getRun(page: Page, runId: string): Promise<AgentRunDetail> {
  const response = await page.request.get(`/api/agent-runs/${runId}`);
  expect(response.status()).toBe(200);
  return await response.json() as AgentRunDetail;
}

async function getOpenInbox(page: Page): Promise<AgentInboxItem[]> {
  const response = await page.request.get("/api/agent-inbox?status=open");
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: AgentInboxItem[] }).items;
}

function runStatus(page: Page) {
  return page.locator(".agent-run-panel [role=status]");
}

function assertExecutionEvidence(run: AgentRunDetail): void {
  expect(run.targetSnapshot.constraints.roleFamily).toBe("AI 应用工程师");
  expect(run.executionSpec.sourceScope.sources).toEqual(["fake:aurora-careers", "fake:orbit-careers"]);
  expect(run.executionSpec.ruleVersion).toBe("fake-job-discovery-rules-v1");
  expect(run.executionSpec.budget).toMatchObject({ maxAttempts: 3, maxToolCalls: 10, maxResults: 5 });
  expect(run.usage.complete).toBe(true);
}

async function assertAccessibleControls(page: Page, testInfo: TestInfo): Promise<void> {
  const controls = page.locator(".agent-run-panel .workbench-touch-target, .agent-inbox-panel .workbench-touch-target");
  expect(await controls.count()).toBeGreaterThan(0);
  expect(await controls.evaluateAll((elements) => elements.every((element) => element.getBoundingClientRect().height >= 44))).toBe(true);
  await expect(page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  if (testInfo.project.name === "Desktop Chrome") {
    const target = page.getByRole("combobox", { name: "用于发现岗位的求职目标" });
    await target.focus();
    await expect(target).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /发现岗位|暂停岗位发现|继续本次岗位发现/ }).first()).toBeFocused();
  }
}

test("暂停会持久化到 Inbox，刷新后用 SSE 游标恢复并可继续完成", async ({ page }, testInfo) => {
  const queue = new Queue(AGENT_RUN_QUEUE, { connection: { host: "127.0.0.1", port: redisPort } });
  let queuePaused = false;
  try {
    await queue.pause();
    queuePaused = true;
    const runId = await startScenario(page, testInfo, scenarioFor(testInfo, "pause"));
    const timeline = page.getByRole("list", { name: "岗位发现运行时间线" });
    await expect(timeline).toContainText("已排队");
    let savedCursor = 0;
    await expect.poll(async () => {
      savedCursor = await page.evaluate((id) => Number(sessionStorage.getItem(`job-copilot:agent-run:${id}:cursor`) ?? "0"), runId);
      return savedCursor;
    }).toBeGreaterThan(0);
    const resumedEventsRequest = page.waitForRequest((request) => request.url().includes(`/api/agent-runs/${runId}/events?afterEventId=${savedCursor}`));
    await page.reload();
    expect((await resumedEventsRequest).url()).toContain(`afterEventId=${savedCursor}`);
    await queue.resume();
    queuePaused = false;
    await page.getByRole("button", { name: "暂停岗位发现" }).click();
    await expect(runStatus(page)).toContainText(/等待安全暂停|岗位发现已暂停/);
    await expect(page.getByRole("heading", { name: "岗位发现已暂停" })).toBeVisible();
    await expect.poll(async () => (await getRun(page, runId)).status).toBe("paused");
    const paused = await getRun(page, runId);
    assertExecutionEvidence(paused);
    expect(paused.termination).toBeNull();
    expect(paused.events.some((event) => event.eventType === "run.paused")).toBe(true);
    expect((await getOpenInbox(page)).some((item) => item.runId === runId && item.kind === "decision_required")).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "岗位发现已暂停" })).toBeVisible();
    await page.getByRole("button", { name: "继续本次岗位发现：岗位发现已暂停" }).click();
    await expect(runStatus(page)).toContainText("岗位发现完成", { timeout: 20_000 });
    const completed = await getRun(page, runId);
    assertExecutionEvidence(completed);
    expect(completed).toMatchObject({ status: "completed", termination: { kind: "completed" } });
    expect(completed.results.length).toBeGreaterThan(0);
    expect(completed.results[0]?.sourceType).toBe("company_careers");
    await expect(page.locator(".agent-run-results")).toContainText("公司招聘官网");
    expect((await getOpenInbox(page)).some((item) => item.runId === runId)).toBe(false);
    await assertAccessibleControls(page, testInfo);
  } finally {
    if (queuePaused) await queue.resume();
    await queue.close();
  }
});

test("取消会在安全检查点终止且不会保存岗位结果", async ({ page }, testInfo) => {
  const runId = await startScenario(page, testInfo, scenarioFor(testInfo, "cancel"));
  await page.getByRole("button", { name: "取消岗位发现" }).click();
  await expect(runStatus(page)).toContainText(/等待安全取消|岗位发现已取消/);
  let cancelled: AgentRunDetail | undefined;
  await expect.poll(async () => {
    cancelled = await getRun(page, runId);
    return cancelled.status;
  }).toBe("cancelled");
  assertExecutionEvidence(cancelled!);
  expect(cancelled).toMatchObject({ status: "cancelled", results: [], termination: { kind: "cancelled_by_user" } });
  expect(cancelled!.events.some((event) => event.eventType === "run.cancelled")).toBe(true);
  expect((await getOpenInbox(page)).some((item) => item.runId === runId)).toBe(false);
  await assertAccessibleControls(page, testInfo);
});

test("来源临时失败后会在重试预算内完成第二次尝试", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const runId = await startScenario(page, testInfo, scenarioFor(testInfo, "retryOnce"));
  const timeline = page.getByRole("list", { name: "岗位发现运行时间线" });
  await expect(timeline).toContainText("正在重新尝试", { timeout: 45_000 });
  await expect(runStatus(page)).toContainText("岗位发现完成", { timeout: 45_000 });
  await expect(page.getByText("2 / 3 次尝试")).toBeVisible();
  const completed = await getRun(page, runId);
  assertExecutionEvidence(completed);
  expect(completed).toMatchObject({ status: "completed", attemptCount: 2, termination: { kind: "completed" } });
  expect(completed.usage.attempts).toBe(2);
  expect(completed.events.some((event) => event.eventType === "run.retry_scheduled")).toBe(true);
  expect(completed.results.length).toBeGreaterThan(0);
  expect((await getOpenInbox(page)).some((item) => item.runId === runId)).toBe(false);
  await assertAccessibleControls(page, testInfo);
});

test("重试预算耗尽会安全失败、说明原因并允许在 Inbox 标记已处理", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const runId = await startScenario(page, testInfo, scenarioFor(testInfo, "retryBudget"));
  await expect(runStatus(page)).toContainText("本次发现超过固定处理预算", { timeout: 75_000 });
  await expect(page.getByRole("heading", { name: "岗位发现预算已用尽" })).toBeVisible();
  const failed = await getRun(page, runId);
  assertExecutionEvidence(failed);
  expect(failed).toMatchObject({
    status: "failed",
    results: [],
    termination: { kind: "budget_exhausted", failureCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "attempts" },
  });
  expect(failed.usage.attempts).toBe(3);
  expect(failed.events.some((event) => event.eventType === "run.failed")).toBe(true);
  const item = (await getOpenInbox(page)).find((inboxItem) => inboxItem.runId === runId);
  expect(item).toMatchObject({ kind: "budget_exhausted", reasonCode: "AGENT_RUN_BUDGET_EXCEEDED", budgetDimension: "attempts", targetHref: "/profile/targets" });
  await expect(page.getByRole("link", { name: "调整求职目标" })).toHaveAttribute("href", "/profile/targets");
  await page.getByRole("button", { name: "标记已处理：岗位发现预算已用尽" }).click();
  await expect(page.getByRole("heading", { name: "岗位发现预算已用尽" })).toHaveCount(0);
  expect((await getOpenInbox(page)).some((inboxItem) => inboxItem.runId === runId)).toBe(false);
  await assertAccessibleControls(page, testInfo);
});
